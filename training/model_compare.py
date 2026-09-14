"""Leakage-safe lightweight model comparison for D-Predict.

This module is a research benchmark, not an automatic model promotion path.
Every candidate is evaluated on the same expanding-window, purge-aware OOS
folds. The OOS results are kept separate so a candidate cannot silently replace
the production baseline merely because it looked better on one split.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, ExtraTreesRegressor, HistGradientBoostingClassifier, HistGradientBoostingRegressor, RandomForestClassifier, RandomForestRegressor
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import accuracy_score, balanced_accuracy_score, log_loss, mean_absolute_error, mean_squared_error
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .train_baseline import CLASS_MAP, CLASS_NAMES, FEATURE_COLUMNS
from .walk_forward import PURGE_ROWS, load_frame

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "data" / "reports"

CANDIDATES = ("hist_gradient_boosting", "extra_trees", "random_forest", "logistic_ridge")


def _models(name: str):
    if name == "hist_gradient_boosting":
        return (
            HistGradientBoostingClassifier(
                learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
                l2_regularization=1.0, random_state=42,
            ),
            HistGradientBoostingRegressor(
                learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
                l2_regularization=1.0, random_state=42,
            ),
        )
    if name == "extra_trees":
        return (
            ExtraTreesClassifier(n_estimators=150, min_samples_leaf=4, max_features=0.8, random_state=42, n_jobs=1),
            ExtraTreesRegressor(n_estimators=150, min_samples_leaf=4, max_features=0.8, random_state=42, n_jobs=1),
        )
    if name == "random_forest":
        return (
            RandomForestClassifier(n_estimators=150, min_samples_leaf=4, max_features=0.8, random_state=42, n_jobs=1),
            RandomForestRegressor(n_estimators=150, min_samples_leaf=4, max_features=0.8, random_state=42, n_jobs=1),
        )
    if name == "logistic_ridge":
        return (
            make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=500, random_state=42)),
            make_pipeline(StandardScaler(), Ridge(alpha=1.0)),
        )
    raise ValueError(f"Unknown candidate: {name}")


def compare(symbol: str, horizon: str, folds: int, candidates: tuple[str, ...] = CANDIDATES) -> dict:
    frame = load_frame(symbol, horizon)
    purge = PURGE_ROWS.get(horizon, 1)
    min_train = max(200, len(frame) // (folds + 2))
    remaining = len(frame) - min_train
    block = max(1, remaining // folds)
    results: list[dict] = []

    for name in candidates:
        fold_rows: list[dict] = []
        for fold in range(folds):
            train_end = min_train + fold * block
            valid_start = min(len(frame) - 1, train_end + purge)
            valid_end = min(len(frame), valid_start + block)
            if valid_end <= valid_start:
                continue
            train = frame.iloc[:train_end]
            valid = frame.iloc[valid_start:valid_end]
            clf, reg = _models(name)
            clf.fit(train[FEATURE_COLUMNS], train["target_class"].map(CLASS_MAP))
            reg.fit(train[FEATURE_COLUMNS], train["target_return"])
            probs = clf.predict_proba(valid[FEATURE_COLUMNS])
            pred = clf.predict(valid[FEATURE_COLUMNS])
            reg_pred = reg.predict(valid[FEATURE_COLUMNS])
            y_true = valid["target_class"].map(CLASS_MAP)
            fold_rows.append({
                "fold": fold + 1,
                "examples": len(valid),
                "accuracy": float(accuracy_score(y_true, pred)),
                "balanced_accuracy": float(balanced_accuracy_score(y_true, pred)),
                "log_loss": float(log_loss(y_true, probs, labels=[0, 1, 2])),
                "return_mae": float(mean_absolute_error(valid["target_return"], reg_pred)),
                "return_rmse": float(mean_squared_error(valid["target_return"], reg_pred) ** 0.5),
            })

        if not fold_rows:
            raise RuntimeError(f"No OOS folds produced for {name}")
        fold_frame = pd.DataFrame(fold_rows)
        results.append({
            "model": name,
            "folds": len(fold_rows),
            "oos_examples": int(fold_frame["examples"].sum()),
            "accuracy_mean": round(float(fold_frame["accuracy"].mean()), 6),
            "accuracy_std": round(float(fold_frame["accuracy"].std(ddof=0)), 6),
            "balanced_accuracy_mean": round(float(fold_frame["balanced_accuracy"].mean()), 6),
            "log_loss_mean": round(float(fold_frame["log_loss"].mean()), 6),
            "return_mae_mean": round(float(fold_frame["return_mae"].mean()), 8),
            "return_rmse_mean": round(float(fold_frame["return_rmse"].mean()), 8),
            "folds_detail": fold_rows,
        })

    # Ranking is diagnostic only. Lower log-loss/MAE and higher balanced accuracy
    # are desirable, but no candidate is promoted by this module.
    results.sort(key=lambda r: (r["log_loss_mean"], r["return_mae_mean"]))
    report = {
        "symbol": symbol.upper(),
        "horizon": horizon,
        "folds": folds,
        "purge_rows": purge,
        "feature_set": "market-v1",
        "candidates": results,
        "promotion": "NONE",
        "note": "Diagnostic OOS comparison only; candidate selection requires an independent promotion protocol.",
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / f"{symbol.lower()}_{horizon}_model_comparison.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare lightweight D-Predict models using purge-aware walk-forward OOS folds")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--horizons", nargs="+", default=["1d", "3d", "5d"])
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--candidates", nargs="+", choices=CANDIDATES, default=list(CANDIDATES))
    args = parser.parse_args()
    if args.folds < 2:
        raise SystemExit("--folds must be >= 2")
    for symbol in args.symbols:
        for horizon in args.horizons:
            compare(symbol.upper(), horizon, args.folds, tuple(args.candidates))


if __name__ == "__main__":
    main()
