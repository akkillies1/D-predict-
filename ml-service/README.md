# D-Predict ML service

The FastAPI service is **inference-only**. `POST /predict` loads a validated artifact from `MODEL_ARTIFACT_DIR` and never retrains during a request. If no artifact exists, it returns `MODEL_ARTIFACT_UNAVAILABLE` and the caller must abstain.

## Training

Run the separate training job after collecting and validating real market data:

```bash
DATABASE_URL=postgresql://... \
MODEL_ARTIFACT_DIR=/app/models/live \
python ml-service/train_artifact.py --symbols NIFTY BANKNIFTY --horizons 1d 3d 5d
```

The job performs the existing purge-aware walk-forward evaluation, calibration, and promotion gates, then atomically replaces each artifact only after successful training. A failed run leaves the previous validated artifact untouched.

## Provenance

Each prediction exposes the artifact model version, feature-set version, training cutoff, OOS example count, calibration count, and promotion checks. Historical OOS metrics describe validation forecasts; they are not a guarantee of current or future performance.

## Current model contract

The current artifact feature set is `market-v3`. It extends the technical baseline with backward-looking price-state and regime features: opening gap, intraday range, close location, trend strength, volatility-regime z-score, and volume-price trend. Every feature is computed from observations available at or before the prediction timestamp.

Directional labels use `volatility-normalized-v1`: the raw future return is retained for regression, while the UP/DOWN boundary is the greater of 0.1% or half the ATR-scaled volatility expected over the requested horizon. This reduces the risk of treating a negligible move and a large move as the same directional event. The label definition and feature version are persisted in the artifact metadata and exposed by `/health` and `/predict`; changing either invalidates older artifacts until they are retrained.

The service remains deliberately honest about scope. The current production artifact is still a per-instrument temporal model. Intraday bars, option-chain snapshots, macro/news events, and cross-sectional multi-instrument training are not silently treated as model inputs merely because those datasets exist elsewhere in the repository. Those inputs require point-in-time joins and their own leakage-safe validation before promotion.

## Uncertainty-aware action gate

By default, a directional prediction is actionable only when its uncertainty interval also clears the configured round-trip cost: a long requires `p10 > cost`, while a short requires `p90 < -cost`. A favorable point estimate alone is therefore not enough when the downside/upside tail still crosses the estimated trading cost. The response reports `interval_edge_required` and the relevant abstention reason. For controlled research comparisons only, set `REQUIRE_INTERVAL_EDGE=false`; production deployments should keep the default enabled.
