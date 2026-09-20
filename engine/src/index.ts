import { runFeatureEngine } from "./features/featureEngine.js";
import { runSignalEngine } from "./signal/signalEngine.js";
import { runBacktest } from "./backtest/backtestHarness.js";
import { runTradeConstructionEngine } from "./construction/tradeConstructionEngine.js";
import { runConstructionBacktest } from "./backtest/constructionBacktest.js";
import { runForecastEngine } from "./forecast/forecastEngine.js";
import { runShadowTradingEngine } from "./shadow/shadowTradingEngine.js";
import { resolvePendingPredictions } from "./scoring/predictionResolution.js";
import { pool } from "./db.js";

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "features":
      await runFeatureEngine();
      break;
    case "signal":
      await runSignalEngine();
      break;
    case "backtest":
      await runBacktest();
      break;
    case "construct":
      await runTradeConstructionEngine();
      break;
    case "backtest-construction":
      await runConstructionBacktest();
      break;
    case "forecast":
      await runForecastEngine();
      break;
    case "shadow":
      await runShadowTradingEngine();
      break;
    case "worker": {
      const intervalMs = Math.max(10_000, Number(process.env.ENGINE_POLL_SECONDS ?? 60) * 1000);
      console.log(`[engine] worker started; polling every ${intervalMs / 1000}s`);
      while (true) {
        try {
          await runFeatureEngine();
          const resolution = await resolvePendingPredictions();
          console.log(`[engine] prediction resolution: ${resolution.resolved} resolved; ${resolution.stillPending} pending`);
          await runSignalEngine();
          await runForecastEngine();
          await runTradeConstructionEngine();
          await runShadowTradingEngine();
        } catch (error) {
          console.error("[engine] worker cycle failed; will retry", error);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    default:
      console.log("Usage: tsx src/index.ts <features|signal|backtest|construct|backtest-construction|forecast|shadow|worker>");
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
