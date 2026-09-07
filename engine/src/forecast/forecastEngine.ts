import { getInstrumentId, getSpotPriceAt, getDailyClosesFromIntraday } from "../db.js";
import { historicalVolatility } from "../features/indicators.js";
import { simulateProbabilityCone, probabilityAbove, probabilityBelow, ForecastResult } from "./monteCarlo.js";

const DEFAULT_HORIZON_DAYS = Number(process.env.FORECAST_HORIZON_DAYS ?? 5);
const DEFAULT_NUM_PATHS = Number(process.env.FORECAST_NUM_PATHS ?? 3000);
const VOLATILITY_LOOKBACK_DAYS = 20;
const MIN_DAYS_FOR_RELIABLE_VOL = 20; // see caveat printed below when under this

export interface SymbolForecast {
  symbol: string;
  spot: number;
  dailyVolatility: number;
  daysOfHistoryUsed: number;
  horizonDays: number;
  forecast: ForecastResult;
}

async function forecastForSymbol(symbol: string, horizonDays: number, numPaths: number): Promise<SymbolForecast | null> {
  const instrumentId = await getInstrumentId(symbol);
  const dailyCloses = await getDailyClosesFromIntraday(instrumentId);

  if (dailyCloses.length < 5) {
    console.warn(`[forecast] ${symbol}: only ${dailyCloses.length} days of history — not enough to calibrate volatility yet`);
    return null;
  }

  const closes = dailyCloses.map((d) => d.close);
  const period = Math.min(VOLATILITY_LOOKBACK_DAYS, closes.length - 1);
  const dailyVol = historicalVolatility(closes, period);

  if (dailyVol === null) {
    console.warn(`[forecast] ${symbol}: could not compute volatility from available history`);
    return null;
  }

  const spot = await getSpotPriceAt(instrumentId, new Date());
  if (spot === null) {
    console.warn(`[forecast] ${symbol}: no current spot price available`);
    return null;
  }

  if (closes.length < MIN_DAYS_FOR_RELIABLE_VOL) {
    console.warn(
      `[forecast] ${symbol}: WARNING — volatility calibrated from only ${closes.length} days (less than ${MIN_DAYS_FOR_RELIABLE_VOL}). Cone will be unreliable until more history accumulates.`
    );
  }

  // Zero drift, deliberately — see monteCarlo.ts header. This is a
  // statistical baseline ("how much could price plausibly move given its
  // own recent volatility"), not the signal engine's directional view
  // layered in. Blending signal confidence in as drift is a reasonable
  // future extension, but it would make this cone inherit the signal
  // engine's unvalidated accuracy rather than standing on its own.
  const forecast = simulateProbabilityCone(spot, dailyVol, horizonDays, numPaths, 0);

  return {
    symbol,
    spot,
    dailyVolatility: dailyVol,
    daysOfHistoryUsed: closes.length,
    horizonDays,
    forecast,
  };
}

function printForecast(result: SymbolForecast): void {
  const { symbol, spot, dailyVolatility, daysOfHistoryUsed, forecast } = result;
  console.log(`\n[forecast] ${symbol} — probability cone (zero-drift baseline, ${daysOfHistoryUsed}d volatility history)`);
  console.log(`  spot: ${spot.toFixed(2)}  daily volatility: ${(dailyVolatility * 100).toFixed(2)}%`);
  console.log(`  day    p10       p25       median    p75       p90`);
  for (const band of forecast.bands) {
    console.log(
      `  ${String(band.day).padStart(3)}    ${band.p10.toFixed(0).padStart(7)}   ${band.p25.toFixed(0).padStart(7)}   ${band.median.toFixed(0).padStart(7)}   ${band.p75.toFixed(0).padStart(7)}   ${band.p90.toFixed(0).padStart(7)}`
    );
  }

  const pAbove = probabilityAbove(forecast.terminalPrices, spot);
  const pBelow = probabilityBelow(forecast.terminalPrices, spot);
  console.log(`  P(above current spot at day ${result.horizonDays}): ${(pAbove * 100).toFixed(1)}%`);
  console.log(`  P(below current spot at day ${result.horizonDays}): ${(pBelow * 100).toFixed(1)}%`);
  console.log(`  note: zero-drift baseline — this is "how wide could the move plausibly be", not a directional call.`);
}

export async function runForecastEngine(): Promise<void> {
  const { config } = await import("../config.js");
  for (const symbol of config.instruments) {
    const result = await forecastForSymbol(symbol, DEFAULT_HORIZON_DAYS, DEFAULT_NUM_PATHS);
    if (result) printForecast(result);
  }
}
