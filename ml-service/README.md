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
