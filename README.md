# Nifty Options Signal Engine

Personal research/trading tool for generating rule-based entry/exit cues on
Nifty options — direction, strike/expiry, position sizing, and hedging —
with backtesting inserted between each engine layer.

## Architecture

```
Data collector (Python)  →  Postgres/Supabase  →  Feature layer  →  Signal engine (TS)
                                                                  →  Trade construction (TS)
                                                                  →  Risk engine (TS)
                                                                  →  Hedging engine (TS)
```

Hard rules this repo follows:
- The collector never makes trading decisions — only validated historical facts.
- Every engine decision (signal, trade construction, risk, execution, exit) is
  logged with full inputs, so any past recommendation is reproducible.
- Numerical outputs (strike, lots, SL, target) always come from the
  deterministic engine, never from an LLM. AI is used only to explain context.

## Structure

```
db/           Canonical Postgres/Supabase schema (raw, derived, decision-log tables)
collector/    Python service: NSE/Yahoo adapters -> normalize -> validate -> persist
engine/       TypeScript: feature engine -> signal engine -> trade construction -> backtests
```

Risk and hedging engines are next, gated behind results from `backtest-construction`.

## Status

- [x] Canonical data schema (`db/schema.sql`)
- [x] Python data collector skeleton (`collector/`)
- [x] Feature engine, incl. PCR/max-pain/MACD/volume-zscore (`engine/src/features/`)
- [x] Phase 1 signal engine (trend/momentum/RSI/regime + MACD/volume/PCR/max-pain confirmation) + backtest harness w/ reason-code breakdown
- [x] Phase 2 trade construction engine + backtest with real SL/target path-crossing detection (`engine/src/construction/`)
- [x] Monte Carlo probability cone forecast (`engine/src/forecast/`)
- [ ] Meta-model: historical reliability of the signal engine's own calls
- [ ] Phase 3 risk engine (deterministic lot sizing, exposure caps)
- [ ] Phase 4 hedging engine (naked / vertical spread / event hedge)
- [ ] TS decision engine / UI / order card
