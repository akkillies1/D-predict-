# Engine (TypeScript)

Phase 1: feature engine + rule-based signal engine + backtest harness, run in
that order so the directional signal is validated before anything downstream
(strike selection, sizing, hedging) gets built on top of it.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL (same Postgres/Supabase as the collector)
```

## Commands

```bash
npm run features                # reads price_bars (+ option_snapshots) -> writes feature_snapshots
npm run signal                    # reads latest feature_snapshots -> writes signal_decisions
npm run backtest                   # scores past signal_decisions against subsequent price moves
npm run construct                  # Phase 2: turns unconstructed signals into option trade specs
npm run backtest-construction      # scores constructed trades against actual option premium moves
npm run forecast                    # Monte Carlo probability cone: range + likelihood over a future window
```

Run in that order. `construct` only processes signals that don't already
have a `trade_construction_decisions` row, so it's safe to re-run repeatedly
as new signals land.

## What's deliberately NOT here yet

No lot sizing, no hedging. Per the architecture: those are separate engines
(Phase 3 risk, Phase 4 hedging) that consume `trade_construction_decisions`
as their input, each gated behind its own backtest.

## Phase 2 — trade construction (`src/construction/`)

v1 rules, intentionally simple, all constants documented as heuristics at
the top of `tradeConstructionEngine.ts`:
- Skip signals with `confidence < 0.6` or `direction = NEUTRAL` rather than
  force a low-conviction trade — skips are still logged (with `contract_id
  = null`) so the decision log has no silent gaps.
- Strike: ATM only in v1 (closest strike to spot). OTM strike selection by
  conviction level is a deliberate deferral, not an oversight.
- Expiry: nearest expiry with `days_to_expiry >= holding_horizon + theta_buffer`
  (currently 2 + 2 days — matches the horizon Phase 1's backtest evaluates against).
- SL/target: 30% premium stop, 60% premium target (~2:1). Arbitrary starting
  points — `backtest-construction` is what should end up changing them.

**`constructionBacktest.ts` now does a real path scan** — it walks every
option snapshot between entry and horizon end and returns whichever of
SL/target is crossed first chronologically (`src/backtest/tradeOutcome.ts`,
unit tested). The remaining limitation is polling density, not the logic:
a premium spike between two polls that crosses SL or target and reverts
before the next poll won't be seen. Tighter option-chain polling narrows
this gap; it can't be eliminated without tick-level data.

## Notes on the Phase 1 rule set (`src/signal/signalEngine.ts`)

Intentionally simple and readable — EMA-trend + momentum agreement is the
base call. On top of that, four independent confirmation signals each add a
small, capped nudge to confidence: MACD histogram agreement, volume z-score,
Put-Call Ratio, and max-pain "magnet" positioning. The PCR and max-pain
rules rest on commonly cited but genuinely debated market-folklore
assumptions — they're deliberately small nudges rather than primary
drivers, and the reason-code breakdown in `backtest` output is what should
end up deciding whether `OI_PCR_*` and `MAX_PAIN_MAGNET_*` actually earn
their keep or should be removed. This whole rule set is meant to be
replaced/tuned once `backtest` shows where it's weak, not treated as a
finished model. Every decision persists its `reason_codes`, so you can
slice backtest results by which rule fired.

## Forecast — Monte Carlo probability cone (`src/forecast/`)

Answers "how could price behave over the next N days" as a probability
distribution, not a single number — simulates thousands of random GBM price
paths calibrated to recent historical volatility, then reports percentile
bands (p10/p25/median/p75/p90) at each day, i.e. a widening cone of
plausible outcomes.

**Deliberately separate from the signal engine.** This is a zero-drift
statistical baseline — it answers "how wide could the move plausibly be
given recent volatility", not "which direction will it go" (that's what
`signal` is for). Blending the signal engine's directional confidence in as
drift is a reasonable future step, but doing it now would make the cone
inherit the signal engine's own unvalidated accuracy rather than standing on
independent statistical footing.

**Known limitations, not hidden:**
- GBM assumes normally-distributed returns; real markets have fatter tails
  (gap opens, event-day jumps) than this captures.
- Volatility is held constant over the horizon; real volatility clusters
  and regime-shifts, which this simulation doesn't model.
- Calibrated from whatever daily history exists — with only a few days of
  collected data the volatility estimate (and therefore the whole cone) is
  unreliable. `forecastEngine.ts` prints an explicit warning under 20 days
  of history rather than silently producing a confident-looking chart from
  thin data.

Planned next, not yet built: a meta-model that scores how reliable the
signal engine's own directional calls have historically been (distinct from
this cone, which says nothing about direction) — that one is genuinely
gated on weeks of accumulated backtest history existing first.
