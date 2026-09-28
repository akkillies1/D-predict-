"""Model-edge diagnostics: per-feature information coefficients + FLAT analysis.

The promotion gate tells us a model abstains; it does not tell us why. This
script measures what actual edge exists in the feature set:

- univariate rank IC (Spearman) of every feature against the forward return,
  whole-history and per chronological block, pooled across symbols;
- feature redundancy via Pearson correlation clusters;
- FLAT-class dominance: realized class distribution, OOF confusion matrix,
  per-class precision/recall (reusing the ledger scorer), and how the balance
  moves as the UP/DOWN threshold changes.

Proposals are derived from the measured numbers, never asserted without them.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import confusion_matrix

from .build_dataset import FEATURE_COLUMNS
from .score_prediction_ledger import _score
from .train_baseline import CLASS_MAP, CLASS_NAMES
from .walk_forward import PRED_DIR, evaluate as walk_forward_evaluate, load_frame

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "data" / "reports"
BLOCKS = 5
CURRENT_BAND = 0.001
SENSITIVITY_BANDS = [0.0005, 0.001, 0.002, 0.003, 0.005]


def _flat_share_at_band(returns: np.ndarray, band: float) -> float:
    return float(np.mean(np.abs(returns) <= band))


def _rank_ic(frame: pd.DataFrame) -> list[dict]:
    y = frame["target_return"].to_numpy()
    n = len(frame)
    edges = [int(i * n / BLOCKS) for i in range(BLOCKS + 1)]
    rows = []
    for feature in FEATURE_COLUMNS:
        x = frame[feature].to_numpy()
        ic_full = spearmanr(x, y).statistic
        ic_full = 0.0 if not math.isfinite(ic_full) else float(ic_full)
        block_ics = []
        for b in range(BLOCKS):
            rho = spearmanr(x[edges[b]:edges[b + 1]], y[edges[b]:edges[b + 1]]).statistic
            block_ics.append(0.0 if not math.isfinite(rho) else float(rho))
        sign = 1 if ic_full >= 0 else -1
        rows.append({
            "feature": feature,
            "ic_full": round(ic_full, 4),
            "ic_block_mean": round(float(np.mean(block_ics)), 4),
            "ic_block_min_abs": round(min(abs(v) for v in block_ics), 4),
            "sign_consistency": round(sum(1 for v in block_ics if (v >= 0) == (sign > 0)) / BLOCKS, 4),
        })
    return rows


def _redundant_pairs(frame: pd.DataFrame) -> list[dict]:
    corr = frame[list(FEATURE_COLUMNS)].corr(method="pearson").abs()
    pairs = []
    cols = list(corr.columns)
    for i in range(len(cols)):
        for j in range(i + 1, len(cols)):
            value = corr.iat[i, j]
            if math.isfinite(value) and value > 0.95:
                pairs.append({"a": cols[i], "b": cols[j], "abs_pearson": round(float(value), 4)})
    return sorted(pairs, key=lambda p: -p["abs_pearson"])


def _flat_analysis(symbol: str, horizon: str, folds: int) -> dict:
    walk_forward_evaluate(symbol, horizon, folds)
    ledger = pd.read_csv(PRED_DIR / f"{symbol.lower()}_{horizon}_walk_forward.csv", parse_dates=["timestamp"])
    scoring = _score(ledger)
    conf = confusion_matrix(
        ledger["actual"].map(CLASS_MAP), ledger["prediction"].map(CLASS_MAP), labels=[0, 1, 2]
    ).tolist()

    returns = ledger["target_return"].to_numpy()
    predictions = ledger["prediction"].to_numpy()
    sensitivity = []
    for band in SENSITIVITY_BANDS:
        actual = np.select([returns > band, returns < -band], ["UP", "DOWN"], default="FLAT")
        directional = np.where(actual != "FLAT")[0]
        called = [i for i in directional if predictions[i] != "FLAT"]
        hit = float(np.mean(predictions[called] == actual[called])) if called else None
        sensitivity.append({
            "band": band,
            "realized_class_share": {
                "UP": round(float(np.mean(returns > band)), 4),
                "FLAT": round(_flat_share_at_band(returns, band), 4),
                "DOWN": round(float(np.mean(returns < -band)), 4),
            },
            "predicted_nonflat_share": round(float(np.mean(predictions != "FLAT")), 4),
            "oos_accuracy": round(float(np.mean(predictions == actual)), 4),
            "directional_hit_rate": None if hit is None else round(hit, 4),
        })

    flat_share = next(s["realized_class_share"]["FLAT"] for s in sensitivity if s["band"] == CURRENT_BAND)
    return {
        "examples": int(len(ledger)),
        "realized_flat_share_at_current_band": flat_share,
        "predicted_class_share": {
            name: round(float((ledger["prediction"] == name).mean()), 4) for name in CLASS_NAMES
        },
        "confusion_matrix_rows_actual_DOWN_FLAT_UP": conf,
        "oof_scoring": {k: scoring[k] for k in (
            "accuracy", "balanced_accuracy", "majority_baseline_accuracy", "accuracy_lift_vs_majority",
            "directional_accuracy", "directional_coverage", "precision_flat", "recall_flat",
            "precision_up", "recall_up", "precision_down", "recall_down",
        )},
        "threshold_sensitivity": sensitivity,
    }


def _proposals(report: dict) -> list[str]:
    props = []
    ics = sorted(report["features"], key=lambda f: -abs(f["ic_full"]))
    strong = [f for f in ics if abs(f["ic_full"]) >= 0.05 and f["sign_consistency"] >= 0.6]
    dead = [f["feature"] for f in ics if abs(f["ic_full"]) < 0.02]
    unstable = [f["feature"] for f in ics if abs(f["ic_full"]) >= 0.05 and f["sign_consistency"] < 0.6]
    props.append(
        "Strongest rank ICs: " + (", ".join(f"{f['feature']} ({f['ic_full']:+.3f})" for f in ics[:5]) or "none")
    )
    if len(dead) > len(ics) // 2:
        props.append(
            f"{len(dead)}/{len(ics)} features have |IC|<0.02 — the flat majority of the set adds noise, not edge; "
            "candidates for removal or transformation (interaction/rank encoding) rather than more trees."
        )
    elif dead:
        props.append(f"{len(dead)} features are effectively dead (|IC|<0.02): {', '.join(dead)}.")
    if unstable:
        props.append(f"IC sign flips across time blocks for {len(unstable)} features: {', '.join(unstable[:8])} — regime-dependent, unsafe as standalone signals.")
    if report["redundant_pairs"]:
        top = report["redundant_pairs"][:5]
        props.append("Near-duplicate pairs (|Pearson|>0.95): " + ", ".join(f"{p['a']}~{p['b']} ({p['abs_pearson']})" for p in top) + " — keep one per cluster to reduce variance.")
    flat = report["flat_analysis"]["realized_flat_share_at_current_band"]
    if flat > 0.5:
        props.append(
            f"FLAT dominates labels at the fixed ±{CURRENT_BAND} band ({flat:.0%} of days). A volatility-scaled band "
            "(e.g. ±0.25×daily σ, symbol-specific) or a binary UP/DOWN target with a dead-zone filter applied at "
            "decision time would stop the classifier from winning by doing nothing."
        )
    scoring = report["flat_analysis"]["oof_scoring"]
    direction = scoring.get("directional_accuracy")
    if direction is not None and abs(direction - 0.5) < 0.03:
        props.append(f"OOS directional accuracy is {direction:.3f} — statistically indistinguishable from a coin flip; no class-boundary tuning will fix a missing signal.")
    if strong:
        props.append(f"Most consistent edge (|IC|>=0.05 with stable sign): {', '.join(f['feature'] for f in strong[:8])}.")
    return props


def diagnose(symbol: str, horizon: str, folds: int) -> dict:
    frame = load_frame(symbol, horizon)
    report = {
        "symbol": symbol.upper(),
        "horizon": horizon,
        "rows": int(len(frame)),
        "daily_sigma": round(float(frame["return_1"].std()), 5),
        "features": _rank_ic(frame),
        "redundant_pairs": _redundant_pairs(frame),
        "flat_analysis": _flat_analysis(symbol, horizon, folds),
    }
    report["proposals"] = _proposals(report)
    return report


def _pooled(reports: list[dict]) -> dict:
    pooled = []
    for feature in FEATURE_COLUMNS:
        ics = [next(f["ic_full"] for f in r["features"] if f["feature"] == feature) for r in reports]
        mean_ic = float(np.mean(ics))
        agree = float(np.mean([(v >= 0) == (mean_ic >= 0) for v in ics]))
        pooled.append({
            "feature": feature,
            "mean_ic": round(mean_ic, 4),
            "cross_symbol_sign_agreement": round(agree, 4),
            "consistency": round(float(np.mean([next(f["sign_consistency"] for f in r["features"] if f["feature"] == feature) for r in reports])), 4),
        })
    return sorted(pooled, key=lambda p: -abs(p["mean_ic"]))


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure per-feature IC and FLAT-class dominance for trained symbols")
    parser.add_argument("--symbols", nargs="+", default=["NIFTY", "BANKNIFTY"])
    parser.add_argument("--horizon", default="1d", choices=["1d", "3d", "5d"])
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()

    reports, skipped = [], []
    for symbol in args.symbols:
        try:
            reports.append(diagnose(symbol.upper(), args.horizon, args.folds))
        except (FileNotFoundError, RuntimeError) as exc:
            skipped.append({"symbol": symbol.upper(), "reason": str(exc)})
    result = {
        "feature_set": "market-v2",
        "horizon": args.horizon,
        "folds": args.folds,
        "symbols_diagnosed": [r["symbol"] for r in reports],
        "skipped": skipped,
        "pooled_feature_ic": _pooled(reports) if reports else [],
        "per_symbol": reports,
    }
    output = args.output or REPORT_DIR / f"edge_{args.horizon}_{'+'.join(s.lower() for s in reports[:3])}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    result["report_file"] = str(output)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
