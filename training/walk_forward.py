"""Walk-forward evaluation for the market baseline.

Each validation prediction is made using only earlier observations, with a
label-horizon purge between training and validation. The resulting
out-of-sample ledger is the material used by calibration and meta-model work.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss

from .dataset import DatasetSpec, PointInTimeDataset, make_segments
from .train_baseline import CLASS_MAP, CLASS_NAMES, FEATURE_COLUMNS

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "training"
PRED_DIR = ROOT / "data" / "predictions"

PURGE_ROWS = {"1d": 1, "3d": 3, "5d": 5}


def load_frame(symbol: str, horizon: str) -> pd.DataFrame:
    path = DATA_DIR / f"{symbol.lower()}_{horizon}.csv"
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}; run build_dataset.py first")
    df = pd.read_csv(path, parse_dates=["timestamp"]).sort_values("timestamp")
    df = df.dropna(subset=FEATURE_COLUMNS + ["target_class", "target_return"]).copy()
    if len(df) < 300:
        raise RuntimeError(f"Only {len(df)} examples; need at least 300 for walk-forward validation")
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df.set_index("timestamp")


def evaluate(symbol: str, horizon: str, folds: int) -> dict:
    frame = load_frame(symbol, horizon)
    purge = PURGE_ROWS.get(horizon, 1)
    spec = DatasetSpec(
        instrument=symbol,
        frequency="1d",
        start=frame.index.min(),
        end=frame.index.max() + pd.Timedelta(nanoseconds=1),
        feature_set_version=str(frame["feature_set_version"].iloc[0]) if "feature_set_version" in frame else "market-v1",
        label_horizon=horizon,
    )
    dataset = PointInTimeDataset(spec, frame, make_segments(frame.index, purge_rows=purge))
    dataset.validate()

    # Expanding-window folds. The validation block is strictly later than the
    # training block and separated by the label-horizon purge.
    min_train = max(200, len(frame) // (folds + 2))
    remaining = len(frame) - min_train
    block = max(1, remaining // folds)
    rows: list[dict] = []

    for fold in range(folds):
        train_end = min_train + fold * block
        valid_start = min(len(frame) - 1, train_end + purge)
        valid_end = min(len(frame), valid_start + block)
        if valid_end <= valid_start:
            continue
        train = frame.iloc[:train_end]
        valid = frame.iloc[valid_start:valid_end]
        if train.empty or valid.empty:
            continue

        model = HistGradientBoostingClassifier(
            learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
            l2_regularization=1.0, random_state=42,
        )
        model.fit(train[FEATURE_COLUMNS], train["target_class"].map(CLASS_MAP))
        probs = model.predict_proba(valid[FEATURE_COLUMNS])
        pred = model.predict(valid[FEATURE_COLUMNS])
        for idx, (timestamp, row) in enumerate(valid.iterrows()):
            p = probs[idx]
            rows.append({
                "timestamp": timestamp.isoformat(),
                "symbol": symbol.upper(),
                "horizon": horizon,
                "fold": fold + 1,
                "train_end": train.index[-1].isoformat(),
                "purge_rows": purge,
                "market_probability_down": float(p[0]),
                "market_probability_flat": float(p[1]),
                "market_probability_up": float(p[2]),
                "prediction": CLASS_NAMES[int(pred[idx])],
                "actual": row["target_class"],
                "target_return": float(row["target_return"]),
            })

    if not rows:
        raise RuntimeError("No walk-forward validation rows were produced")
    result = pd.DataFrame(rows)
    PRED_DIR.mkdir(parents=True, exist_ok=True)
    out = PRED_DIR / f"{symbol.lower()}_{horizon}_walk_forward.csv"
    result.to_csv(out, index=False)

    y_true = result["actual"].map(CLASS_MAP)
    y_pred = result["prediction"].map(CLASS_MAP)
    proba = result[["market_probability_down", "market_probability_flat", "market_probability_up"]].to_numpy()
    metrics = {
        "symbol": symbol.upper(),
        "horizon": horizon,
        "folds": folds,
        "purge_rows": purge,
        "oos_examples": len(result),
        "accuracy": round(float(accuracy_score(y_true, y_pred)), 6),
        "balanced_accuracy": round(float(balanced_accuracy_score(y_true, y_pred)), 6),
        "log_loss": round(float(log_loss(y_true, proba, labels=[0, 1, 2])), 6),
        "prediction_file": str(out),
    }
    print(json.dumps(metrics, indent=2))
    return metrics


def main() -> None:
    parser = argparse.ArgumentParser(description="Walk-forward evaluate D-Predict market models")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--horizons", nargs="+", default=["1d", "3d", "5d"])
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()
    if args.folds < 2:
        raise SystemExit("--folds must be >= 2")
    for symbol in args.symbols:
        for horizon in args.horizons:
            evaluate(symbol.upper(), horizon, args.folds)


if __name__ == "__main__":
    main()
