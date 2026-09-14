import json
from pathlib import Path

from training.stability_gate import evaluate


def _report(tmp_path: Path, weak: bool = False) -> Path:
    report = {
        "overall": {},
        "confidence_buckets": [],
        "calibration": [
            {"bucket": "0.50-0.60", "examples": 20, "absolute_calibration_gap": 0.04 if not weak else 0.20}
        ],
        "fold_stability": {
            "accuracy_std": 0.04 if not weak else 0.20,
            "folds": [
                {"accuracy_lift_vs_majority": 0.02},
                {"accuracy_lift_vs_majority": 0.01 if not weak else -0.20},
            ],
        },
        "regime_stability": {
            "regimes": [
                {"interpretable": True, "accuracy_lift_vs_majority": 0.01},
                {"interpretable": True, "accuracy_lift_vs_majority": 0.00 if not weak else -0.20},
            ]
        },
    }
    path = tmp_path / "stability.json"
    path.write_text(json.dumps(report), encoding="utf-8")
    return path


def test_stable_report_is_ready(tmp_path):
    result = evaluate(_report(tmp_path))
    assert result["promotion_stability_ready"] is True
    assert all(result["checks"].values())


def test_unstable_report_fails(tmp_path):
    result = evaluate(_report(tmp_path, weak=True))
    assert result["promotion_stability_ready"] is False
    assert result["checks"]["calibration_quality"] is False
    assert result["checks"]["fold_accuracy_stability"] is False
    assert result["checks"]["regime_stability"] is False
