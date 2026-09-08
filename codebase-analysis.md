# D-predict Codebase Analysis and Product Roadmap

**Repository:** [akkillies1/D-predict-](https://github.com/akkillies1/D-predict-)

**Scope reviewed:** Python data collector, PostgreSQL/Supabase schema, TypeScript feature and signal engines, trade construction, backtests, Monte Carlo forecasting, and the current repository surface.

## Executive assessment

D-predict is currently a **research-grade Nifty options analytics pipeline**, not yet a complete trading application. It collects market facts, validates and stores them, derives technical and options-chain features, generates explainable directional signals, constructs simple ATM option trade ideas, evaluates historical outcomes, and produces a volatility-based probability cone.

Its strongest design decision is the separation between **raw data, derived features, decisions, and future execution stages**. The database records strategy and model versions, input snapshot references, reason codes, and parameters. That gives the project a useful foundation for reproducibility and later model comparison.

The largest product gap is that the repository has **no frontend, HTTP API, authentication layer, live dashboard, alerting system, order-management integration, or completed risk and hedging engines**. The next stage should therefore be an observable decision-support dashboard rather than direct automated trading.

> **Recommended product position:** build a transparent research and paper-trading workstation first. Do not connect live order execution until data quality, backtest methodology, risk controls, operational monitoring, and manual override behavior have been validated over sufficient historical and live-paper data.

## 1. What the current codebase can do

| Area | Current capability | Main implementation | Current limitation |
|---|---|---|---|
| Market ingestion | Polls Nifty price bars from Yahoo and option-chain snapshots from NSE | `collector/` | Adapter assumptions may break when provider response formats change |
| Validation | Rejects invalid or stale-looking market records before persistence | `collector/validation/` | No operational alerting or data-quality dashboard |
| Persistence | Idempotent storage of instruments, contracts, price bars, option snapshots, events, features, and decisions | `db/schema.sql`, `collector/persistence/` | Requires a prepared PostgreSQL/Supabase database and seed data |
| Technical features | Computes trend, momentum, RSI, ATR, expected move, MACD, volume z-score, and volatility regime | `engine/src/features/` | Implied-volatility history is not yet used in expected-move calculation |
| Options features | Computes nearest-expiry put-call ratio and max-pain strike from open interest | `featureEngine.ts` | These are heuristic indicators and need stronger validation by regime and expiry |
| Directional signal | Produces BULLISH, BEARISH, or NEUTRAL with a bounded confidence score and reason codes | `signalEngine.ts` | Confidence is a hand-tuned score, not a calibrated probability |
| Trade construction | Converts sufficiently confident signals into ATM CE or PE ideas with entry range, 30% premium stop, and 60% premium target | `tradeConstructionEngine.ts` | No lot sizing, capital limits, spreads, slippage, or execution simulation |
| Signal backtest | Measures win rate, average return, expectancy, direction split, and reason-code performance | `backtestHarness.ts` | Does not yet model transaction costs, walk-forward validation, or overlapping positions |
| Construction backtest | Scans option premium snapshots to determine which of stop or target was reached first | `constructionBacktest.ts`, `tradeOutcome.ts` | Polling frequency can miss intrapoll price excursions |
| Forecasting | Simulates thousands of geometric-Brownian-motion paths and reports p10/p25/median/p75/p90 bands | `forecast/` | Zero directional drift, constant volatility, and normal-return assumptions are deliberate simplifications |
| Auditability | Keeps a staged decision chain from signal to future exit | `schema.sql` view `v_full_decision_chain` | Later stages are schema-only and not implemented |
| Frontend | None currently | No frontend or API directories are present | Users must run CLI commands and inspect logs |

## 2. Current end-to-end flow

The intended pipeline is:

```text
NSE option chain + Yahoo price bars
                |
                v
collector adapters -> validation -> PostgreSQL/Supabase
                |
                v
feature engine -> feature_snapshots
                |
                v
signal engine -> signal_decisions
                |
                v
signal backtest
                |
                v
trade construction -> trade_construction_decisions
                |
                v
construction backtest
                |
                +--> Monte Carlo volatility forecast
```

The collector is intentionally prevented from making trading decisions. The TypeScript engine consumes stored facts and produces derived outputs. The decision tables are versioned so that changing a feature or strategy can be compared with earlier runs instead of overwriting historical conclusions.

## 3. Detailed capability analysis

### 3.1 Data collection and storage

The Python collector has separate adapters for NSE option chains and Yahoo price bars. It maps provider-specific responses into canonical records, validates those records, and performs idempotent persistence. Each polling cycle receives an `ingestion_run_id`, which provides traceability from stored data back to a collector run.

The schema stores both spot-market data and option-chain data. It preserves contract identity by instrument, expiry, strike, and option type. It also includes historical lot-size records, trading sessions, event records, and indexes intended for time-series lookup.

This design can support additional instruments such as BANKNIFTY, more timeframes, and alternate data providers. The `source` and `source_version` fields are especially useful when comparing provider behavior or replaying a historical dataset.

### 3.2 Feature engine

The feature layer uses the latest price history and the nearest unexpired option expiry. It computes trend, momentum, RSI, ATR, regime, MACD histogram, volume z-score, put-call ratio, and max-pain strike. The feature row also stores a JSON field for additional values that have not yet received dedicated columns.

The feature engine requires at least 25 bars before writing a snapshot. It records the feature-set version, which is important for reproducible backtests. It currently calculates expected move using ATR because the implied-volatility history path is not yet wired into the calculation.

### 3.3 Signal engine

The signal engine is deterministic and explainable. It first uses trend and momentum agreement to choose a direction. It then adjusts confidence using RSI extremes, volatility regime, MACD agreement, volume confirmation, put-call ratio, and max-pain positioning.

Every decision records reason codes such as `TREND_UP`, `MOMENTUM_CONFIRMS`, `MACD_DIVERGES`, or `HIGH_VOL_REGIME_PENALTY`. This makes it possible to ask not only whether the strategy worked, but which rule components helped or hurt.

The current confidence value should be interpreted as a **ranking score**, not as a statistically calibrated probability. A score of `0.80` does not currently mean that 80% of similar signals will succeed.

### 3.4 Trade construction

Trade construction converts a non-neutral signal with confidence of at least `0.60` into an option idea. Bullish signals select a call and bearish signals select a put. The current strike rule is nearest at-the-money. The expiry must provide the two-day holding horizon plus a two-day theta buffer.

The current premium rules are intentionally simple: the stop is 30% below the estimated entry premium and the target is 60% above it. The engine records skipped signals, including neutral and low-confidence signals, instead of silently dropping them.

This is useful for research because the system can measure the opportunity cost of skipped signals. It is not ready for live use because it does not calculate position size, account risk, spread quality, liquidity, slippage, or order-fill probability.

### 3.5 Backtesting

The signal backtest evaluates directional calls against subsequent underlying-price movement. It reports total and evaluable signals, win rate, average return, average win, average loss, expectancy, direction-level results, and reason-code breakdowns.

The construction backtest uses the full available option-premium path between entry and the end of the holding window. It detects the first stop-loss or target crossing rather than only comparing the final premium. This is materially better than terminal-price-only scoring.

The backtesting layer still needs safeguards against common research errors. It should add transaction costs, bid-ask spread, slippage, partial fills, market hours, trading-day horizons, overlapping-position rules, out-of-sample splits, and walk-forward evaluation before strategy results are treated as evidence.

### 3.6 Monte Carlo forecast

The forecast engine produces a probability cone instead of a single price target. It estimates recent historical volatility, simulates positive price paths, and reports percentile bands at each future day. It intentionally uses zero drift so that the output is an independent estimate of plausible movement range rather than a disguised version of the signal engine.

This is suitable for displaying uncertainty and expected range. It should not be presented as a directional prediction or as a probability of profit for a specific option trade. A future version can add regime-dependent volatility, jumps, fat tails, and calibrated directional scenarios.

## 4. Important current weaknesses

| Priority | Weakness | Why it matters | Recommended correction |
|---|---|---|---|
| Critical | No risk engine | A signal and option idea do not define safe capital usage | Implement capital, risk-per-trade, max-loss, exposure, daily-loss, and correlation constraints |
| Critical | No frontend or API | Users cannot inspect decisions, data quality, or backtest evidence interactively | Add a typed read-only API and dashboard before execution features |
| Critical | No live execution safeguards | Direct broker integration could create unbounded operational risk | Add paper trading, approval workflow, kill switch, reconciliation, and audit logs first |
| High | Confidence is not calibrated | Users may mistake a heuristic score for a probability | Calibrate by regime, direction, horizon, and confidence bucket using out-of-sample data |
| High | Backtests omit friction | Gross returns can materially overstate option strategy performance | Model spread, fees, taxes, slippage, latency, and fill rules |
| High | Provider and timezone assumptions | Incorrect timestamps can corrupt features and backtests | Normalize all timestamps to UTC, retain exchange timezone, and add provider schema checks |
| High | Forecast uses simplified volatility | Constant-volatility normal-return models understate jumps and volatility clustering | Add rolling/regime volatility, jump scenarios, and empirical or bootstrapped returns |
| Medium | Poller is a blocking single process | One failed or slow provider call can delay other instruments | Separate ingestion jobs, add timeouts, retries, metrics, and a durable scheduler |
| Medium | Database queries may scale poorly | Option snapshots will become the highest-volume table | Add partitioning, retention policy, query plans, materialized aggregates, and bounded backfills |
| Medium | No data-quality user interface | Missing or stale data can look like a valid neutral signal | Display freshness, coverage, rejected rows, provider errors, and confidence warnings |

## 5. Future capabilities and how to achieve them

### Phase 1: Make the research system observable

The first product milestone should be a read-only dashboard. It should show the latest market timestamp, data freshness, current spot, trend, regime, feature values, signal direction, confidence, reason codes, option contract, entry range, stop, target, and forecast cone.

To achieve this, add a small backend API that reads from PostgreSQL. Keep the API separate from the batch engines. Expose versioned endpoints such as `/api/instruments`, `/api/market/latest`, `/api/signals/latest`, `/api/trades/candidates`, `/api/forecasts`, `/api/backtests`, and `/api/data-quality`. Return timestamps, versions, and warnings with every response.

The frontend should never reconstruct trading logic. It should display server-produced decisions and link each decision to its input snapshot and reason codes.

### Phase 2: Improve measurement quality

Create a reproducible backtest job with explicit dataset boundaries. Split data into training, validation, and out-of-sample periods. Add walk-forward evaluation so that parameters are selected only from information available before each test period.

Add a trade ledger that records entry assumptions, bid, ask, mid, fill price, slippage, brokerage, taxes, exit reason, and realized P&L. Enforce a single position policy or explicitly model overlapping positions. Evaluate drawdown, profit factor, Sharpe-like risk-adjusted metrics, exposure time, average adverse excursion, and maximum consecutive losses.

Replace fixed hand-tuned thresholds with configuration records that are versioned and evaluated across regimes. Keep the current rule engine as a baseline so improvements can be compared against a stable reference.

### Phase 3: Complete the risk engine

The existing `risk_decisions` table already defines the intended contract. Implement a deterministic risk engine that consumes a trade-construction decision and account configuration.

The engine should calculate the maximum rupee loss, number of lots, premium budget, portfolio exposure, sector or instrument concentration, daily loss remaining, and correlation with open positions. It should reject trades that violate any constraint and record the exact rejection reason.

Use the lot-size history table rather than a hard-coded lot size. Treat missing account state as a rejection, not as permission to trade.

### Phase 4: Add hedging and structure selection

The schema already supports `NAKED`, `VERTICAL_SPREAD`, and `EVENT_HEDGE`. Implement structure selection only after the naked-option baseline has been measured.

A structure engine can compare candidate legs by maximum loss, maximum profit, breakeven, margin requirement, liquidity, bid-ask spread, and sensitivity to volatility and time decay. It should prefer a spread when the naked position violates risk limits or when the expected edge does not justify unlimited or poorly bounded risk.

Backtest each structure separately. Do not compare a hedged trade with an unhedged trade using only win rate; compare risk-adjusted return and tail behavior.

### Phase 5: Add event and volatility intelligence

Populate the `events` table from a reviewed economic-calendar source. Tag event windows around RBI decisions, Union Budget, Federal Reserve decisions, major global releases, and relevant corporate or index events.

Use events as a risk context and regime label before using them as a directional predictor. The first safe use is to reduce size, widen uncertainty warnings, or block new positions near high-impact events.

Extend the options feature set with implied-volatility term structure, skew, IV rank, change in open interest, volume/open-interest ratios, bid-ask spread, and realized-versus-implied volatility. Store each feature with a version and source timestamp.

### Phase 6: Build paper trading and controlled execution

Create a broker abstraction with a paper implementation first. The paper broker should simulate order submission, fills, partial fills, cancellations, rejections, and reconciliation.

Require an explicit user approval step for each live order or an explicitly enabled automation policy. Add a global kill switch, per-instrument limits, stale-data rejection, duplicate-order protection, order-state reconciliation, and immutable execution logs.

Only after paper results match expected backtest behavior should a small, tightly capped live pilot be considered.

## 6. Frontend improvement plan

### 6.1 Recommended information architecture

| Screen | Purpose | Essential content |
|---|---|---|
| Overview | Fast current-state assessment | Spot, trend, regime, latest signal, confidence, data freshness, open paper positions, risk status |
| Signal detail | Explain one decision | Price chart, feature values, reason codes, strategy/model version, input timestamp, confidence interpretation |
| Option chain | Compare contracts | Strike ladder, CE/PE LTP, bid/ask, OI, OI change, IV, Greeks, liquidity flags, selected contract highlight |
| Trade candidate | Review a proposed trade | Entry range, stop, target, expiry, max premium risk, estimated slippage, construction reasons, approve/skip action in paper mode |
| Backtest lab | Evaluate strategy evidence | Date filters, regime filters, confidence buckets, win rate, expectancy, drawdown, reason-code performance, out-of-sample label |
| Forecast | Show uncertainty | Probability cone, spot marker, expected range, volatility history length, warning when history is thin |
| Data health | Detect unreliable input | Last successful poll, row counts, stale instruments, rejected records, provider errors, timestamp gaps |
| Decision audit | Trace reproducibility | Full signal-to-exit chain, versions, raw inputs, parameters, and event timeline |

### 6.2 Visual design recommendations

Use a dark, high-contrast market interface with restrained color semantics. Green and red should indicate direction only, while yellow should indicate warnings and gray should indicate unavailable data. Do not use color as the only signal; pair it with labels, icons, or arrows for accessibility.

The top navigation should contain the instrument selector, timeframe selector, market status, last data timestamp, and a visible stale-data warning. The main dashboard should prioritize the current signal and its evidence rather than showing every raw metric equally.

Use cards for summary values and full-width charts for time-series context. Every chart should show its timeframe, source timestamp, and data-quality state. Avoid displaying a confidence score without a tooltip that explains that it is a strategy score and not a calibrated probability.

### 6.3 High-value charts

The first frontend release should include a candlestick chart with signal markers, an indicator panel for RSI and MACD, an option-chain heatmap for open interest, a premium path with stop and target overlays, a probability cone, and a backtest equity curve.

Use synchronized crosshairs so that selecting a timestamp updates the feature values, option snapshot, signal, and decision-chain details. This is particularly important because the project is designed around reproducibility at a specific market timestamp.

### 6.4 UX safeguards

The interface should make uncertainty explicit. Show “stale,” “insufficient history,” “missing option snapshot,” and “backtest not out-of-sample” states prominently. Disable approval actions when required risk or market data is missing.

For paper trading, use a review drawer that displays the exact order payload, calculated maximum loss, selected contract, bid-ask spread, assumptions, and rejection checks. For future live trading, require a second confirmation step and show the account-level impact before submission.

### 6.5 Suggested frontend technology

A React and TypeScript application is a natural fit because the existing engine is TypeScript and the domain contains many typed decision objects. Use a charting library that supports financial candles and large time-series datasets. Use a query cache for polling and invalidation, and use a schema validator for every API response.

Keep the frontend as a separate application from the batch engine. The browser should call a backend API rather than connect directly to PostgreSQL. Add role-based access before exposing account or execution data.

## 7. Suggested technical architecture for the next release

```text
                    +----------------------+
                    | React/TypeScript UI  |
                    +----------+-----------+
                               |
                         HTTPS JSON API
                               |
                    +----------v-----------+
                    | API service          |
                    | auth + read models   |
                    +----+-------------+---+
                         |             |
                 PostgreSQL/Supabase   | WebSocket/SSE later
                         |
   +---------------------+----------------------+
   |                                            |
+--v----------------+                +----------v---------+
| Collector workers |                | Engine job runner   |
| NSE/Yahoo         |                | features/signals   |
+-------------------+                | construction/risk  |
                                     +--------------------+
```

Initially, the API can query the canonical tables directly with carefully bounded queries. As traffic and history grow, add read models or materialized views for the overview screen, option-chain snapshots, and backtest summaries. Keep the decision-chain tables as the source of truth.

## 8. Recommended implementation order

| Order | Deliverable | Definition of done |
|---:|---|---|
| 1 | Data-quality and freshness checks | Provider schema checks, timezone tests, stale-data detection, and visible logs |
| 2 | Read-only API | Typed endpoints for latest market state, signals, trades, forecasts, backtests, and health |
| 3 | Research dashboard | Overview, signal detail, option chain, forecast, backtest, and data-health screens |
| 4 | Better backtesting | Trading-day horizons, costs, slippage, out-of-sample and walk-forward reports |
| 5 | Risk engine | Deterministic sizing and rejection decisions with complete audit data |
| 6 | Paper trading | Simulated fills, ledger, reconciliation, approval flow, and kill switch |
| 7 | Hedging engine | Naked versus spread comparison, structure backtests, tail-risk reports |
| 8 | Event and volatility features | Calendar ingestion, IV history, skew, term structure, and event-risk controls |
| 9 | Controlled broker integration | Small limits, explicit authorization, reconciliation, and emergency shutdown |

## 9. Immediate code improvements

The highest-return engineering changes are to centralize time handling, add runtime schema validation for external provider responses, and make every batch command accept explicit date ranges and instrument filters. These changes will improve both correctness and operational usability.

The backtest harness should use binary search for timestamp lookup once data grows, avoid unbounded history reads, and expose structured JSON output in addition to console text. The construction backtest should distinguish trading days from calendar days and should record whether a trade was closed by stop, target, time horizon, or missing data.

The forecast engine should persist forecast runs and parameters so the frontend can compare forecast cones with realized outcomes. The signal engine should persist a calibration dataset that maps confidence buckets to realized outcomes by regime and direction.

The collector should add request timeouts, exponential backoff with jitter, provider response-shape checks, explicit exchange-timezone conversion, and metrics for success, rejection, latency, and staleness. A durable scheduler should replace the blocking loop when multiple instruments or timeframes are enabled.

## Final conclusion

D-predict already contains the core of an explainable options research engine. It can collect data, calculate features, issue versioned rule-based signals, construct simple option trades, backtest those stages, and display a statistical uncertainty range through the CLI. Its database schema anticipates the next stages well.

It is not yet a live trading platform. The most important next step is not adding more indicators. It is building a transparent dashboard and API, strengthening backtest realism, completing deterministic risk controls, and operating in paper mode. Once those foundations are validated, the existing schema can support hedging, event-aware decisions, richer volatility analytics, and eventually carefully controlled execution.

## References

[1]: https://github.com/akkillies1/D-predict-/blob/main/README.md "D-predict repository overview"

[2]: https://github.com/akkillies1/D-predict-/blob/main/db/schema.sql "D-predict canonical PostgreSQL schema"

[3]: https://github.com/akkillies1/D-predict-/blob/main/engine/README.md "D-predict TypeScript engine documentation"

[4]: https://github.com/akkillies1/D-predict-/blob/main/collector/README.md "D-predict data collector documentation"

[5]: https://github.com/akkillies1/D-predict-/blob/main/engine/src/signal/signalEngine.ts "D-predict rule-based signal engine"

[6]: https://github.com/akkillies1/D-predict-/blob/main/engine/src/backtest/backtestHarness.ts "D-predict signal backtest harness"

[7]: https://github.com/akkillies1/D-predict-/blob/main/engine/src/construction/tradeConstructionEngine.ts "D-predict trade construction engine"

[8]: https://github.com/akkillies1/D-predict-/blob/main/engine/src/forecast/forecastEngine.ts "D-predict Monte Carlo forecast engine"

[9]: https://github.com/akkillies1/D-predict-/blob/main/collector/scheduler/poller.py "D-predict collector scheduler"

[10]: https://github.com/akkillies1/D-predict-/blob/main/engine/src/features/featureEngine.ts "D-predict feature engine"

[11]: https://github.com/akkillies1/D-predict-/blob/main/engine/src/backtest/constructionBacktest.ts "D-predict construction backtest"

[12]: https://github.com/akkillies1/D-predict-/blob/main/engine/src/db.ts "D-predict database access helpers"

*Prepared by Manus AI.*
