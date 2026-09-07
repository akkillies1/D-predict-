import { runFeatureEngine } from "./features/featureEngine.js";
import { runSignalEngine } from "./signal/signalEngine.js";
import { runBacktest } from "./backtest/backtestHarness.js";
import { runTradeConstructionEngine } from "./construction/tradeConstructionEngine.js";
import { runConstructionBacktest } from "./backtest/constructionBacktest.js";
import { runForecastEngine } from "./forecast/forecastEngine.js";
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
    default:
      console.log("Usage: tsx src/index.ts <features|signal|backtest|construct|backtest-construction|forecast>");
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
