// Rule-based, long-only equity backtest over stored daily bars.
// Signals computed from closes up to bar i are executed at the close of bar
// i+1 — never same-bar — so no decision can see the price it trades at.
// Costs come from the same computeCharges engine the live paper desk uses.
import { computeCharges } from "./paperRoutes.js";

export type BacktestBar = { timestamp: string; close: number };
export type BacktestStrategy = "buy_hold" | "sma_trend" | "vol_expansion";
export const BACKTEST_STRATEGIES: BacktestStrategy[] = ["buy_hold", "sma_trend", "vol_expansion"];

export type BacktestTrade = {
  entryTimestamp: string;
  exitTimestamp: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  exitReason: "SIGNAL" | "END_OF_HISTORY";
};

export type BacktestResult = {
  ok: boolean;
  error?: string;
  requiredBars?: number;
  strategy: BacktestStrategy;
  bars: number;
  smaWindow: number;
  initialCapital: number;
  finalEquity: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  sharpePerTradeAnnualized: number | null;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null;
  totalCosts: number;
  equityCurve: { timestamp: string; equity: number; buyHold: number }[];
  tradeLog: BacktestTrade[];
};

const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

function std(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, v) => sum + v, 0) / returns.length;
  return Math.sqrt(returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (returns.length - 1));
}

function desiredPosition(bars: BacktestBar[], i: number, strategy: BacktestStrategy, smaWindow: number): boolean {
  if (strategy === "buy_hold") return true;
  if (strategy === "sma_trend") {
    if (i < smaWindow) return false;
    const window = bars.slice(i - smaWindow, i);
    const average = window.reduce((sum, bar) => sum + bar.close, 0) / window.length;
    return bars[i].close > average;
  }
  // vol_expansion: long while short-horizon realized vol exceeds the
  // long-horizon baseline — the highest signed, cross-symbol-stable panel IC
  // measured by training/diagnose_edge.py (vol_ratio_10_60, atr7_pct).
  if (i < 60) return false;
  const logReturn = (a: number, b: number) => Math.log(bars[a].close / bars[b].close);
  const shortVol = std(Array.from({ length: 10 }, (_, k) => logReturn(i - k, i - k - 1)));
  const longVol = std(Array.from({ length: 60 }, (_, k) => logReturn(i - k, i - k - 1)));
  return longVol > 0 && shortVol > longVol;
}

function requiredBars(strategy: BacktestStrategy, smaWindow: number): number {
  if (strategy === "buy_hold") return 2;
  return strategy === "sma_trend" ? smaWindow + 2 : 62;
}

export function runBacktest(
  inputBars: BacktestBar[],
  strategy: BacktestStrategy,
  options: { capital?: number; smaWindow?: number } = {}
): BacktestResult {
  const capital = options.capital && options.capital > 0 ? options.capital : 100_000;
  const smaWindow = options.smaWindow && options.smaWindow > 1 ? options.smaWindow : 20;
  const bars = inputBars.filter((bar) => Number.isFinite(bar.close) && bar.close > 0 && !!bar.timestamp);
  const base: BacktestResult = {
    ok: true,
    strategy,
    bars: bars.length,
    smaWindow,
    initialCapital: capital,
    finalEquity: capital,
    totalReturn: 0,
    cagr: 0,
    maxDrawdown: 0,
    sharpePerTradeAnnualized: null,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    profitFactor: null,
    totalCosts: 0,
    equityCurve: [],
    tradeLog: [],
  };
  if (bars.length < requiredBars(strategy, smaWindow)) {
    return { ...base, ok: false, error: "INSUFFICIENT_HISTORY", requiredBars: requiredBars(strategy, smaWindow) };
  }

  let cash = capital;
  let shares = 0;
  let totalCosts = 0;
  let openTrade: { timestamp: string; price: number; quantity: number; buyCost: number } | null = null;
  const tradeLog: BacktestTrade[] = [];

  const closePosition = (i: number, reason: BacktestTrade["exitReason"]) => {
    if (!openTrade || shares <= 0) return;
    const price = bars[i].close;
    const charges = computeCharges("SELL", "CNC", shares, price);
    totalCosts += charges.total;
    cash += shares * price - charges.total;
    const gross = shares * price - openTrade.quantity * openTrade.price;
    const costs = charges.total + openTrade.buyCost;
    tradeLog.push({
      entryTimestamp: openTrade.timestamp,
      exitTimestamp: bars[i].timestamp,
      entryPrice: round(openTrade.price, 2),
      exitPrice: round(price, 2),
      quantity: openTrade.quantity,
      grossPnl: round(gross, 2),
      costs: round(costs, 2),
      netPnl: round(gross - costs, 2),
      exitReason: reason,
    });
    openTrade = null;
    shares = 0;
  };

  const equityCurve: { timestamp: string; equity: number; buyHold: number }[] = [];
  const openPosition = (i: number) => {
    const price = bars[i].close;
    const quantity = Math.floor(cash / price);
    if (quantity <= 0) return;
    const charges = computeCharges("BUY", "CNC", quantity, price);
    totalCosts += charges.total;
    cash -= quantity * price + charges.total;
    shares = quantity;
    openTrade = { timestamp: bars[i].timestamp, price, quantity, buyCost: charges.total };
  };
  for (let i = 0; i < bars.length; i += 1) {
    const price = bars[i].close;
    if (i > 0) {
      // The decision uses data through bar i-1 and trades at bar i's close.
      if (strategy === "buy_hold") {
        if (i === 1) openPosition(i);
      } else {
        const want = desiredPosition(bars, i - 1, strategy, smaWindow);
        if (want && shares === 0) openPosition(i);
        else if (!want && shares > 0) closePosition(i, "SIGNAL");
      }
    }
    equityCurve.push({ timestamp: bars[i].timestamp, equity: round(cash + shares * price, 2), buyHold: round((capital * price) / bars[0].close, 2) });
  }

  if (openTrade && shares > 0) closePosition(bars.length - 1, "END_OF_HISTORY");
  // Rebuild the final curve point after end-of-history liquidation so the
  // last equity equals the realizable cash value.
  if (equityCurve.length) equityCurve[equityCurve.length - 1] = { ...equityCurve[equityCurve.length - 1], equity: round(cash, 2) };

  const finalEquity = cash;
  const wins = tradeLog.filter((trade) => trade.netPnl > 0).length;
  const losses = tradeLog.filter((trade) => trade.netPnl <= 0).length;
  const grossProfit = tradeLog.reduce((sum, t) => sum + Math.max(0, t.netPnl), 0);
  const grossLoss = tradeLog.reduce((sum, t) => sum + Math.max(0, -t.netPnl), 0);
  const tradeReturns = tradeLog.map((trade) => trade.netPnl / (trade.entryPrice * trade.quantity));
  const meanTrade = tradeReturns.reduce((sum, v) => sum + v, 0) / (tradeReturns.length || 1);
  const stdTrade = std(tradeReturns);
  let peak = capital;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - point.equity) / peak);
  }
  const years = bars.length / 250;
  const totalReturn = finalEquity / capital - 1;

  return {
    ...base,
    finalEquity: round(finalEquity, 2),
    totalReturn: round(totalReturn),
    cagr: years > 0 ? round((1 + totalReturn) ** (1 / years) - 1) : 0,
    maxDrawdown: round(maxDrawdown),
    sharpePerTradeAnnualized: tradeReturns.length >= 2 && stdTrade > 0 ? round((meanTrade / stdTrade) * Math.sqrt(252)) : null,
    trades: tradeLog.length,
    wins,
    losses,
    winRate: tradeLog.length ? round(wins / tradeLog.length) : null,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    totalCosts: round(totalCosts, 2),
    equityCurve,
    tradeLog,
  };
}
