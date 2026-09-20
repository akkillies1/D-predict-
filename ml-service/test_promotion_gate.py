import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import _promotion_report  # noqa: E402


def _actual(rows=120):
    return np.asarray(([0, 1, 2] * ((rows + 2) // 3))[:rows], dtype=int)


def test_strong_oos_evidence_is_promotion_ready():
    actual = _actual()
    probabilities = np.asarray([
        [0.8, 0.1, 0.1] if value == 0 else
        [0.1, 0.8, 0.1] if value == 1 else
        [0.1, 0.1, 0.8]
        for value in actual
    ])
    report = _promotion_report(probabilities, actual)
    assert report["promotion_ready"] is True
    assert report["checks"]["minimum_examples"] is True
    assert report["checks"]["beats_majority_baseline"] is True
    assert report["checks"]["probability_quality"] is True
    assert report["checks"]["directional_accuracy"] is True


def test_baseline_level_oos_evidence_abstains():
    actual = _actual()
    probabilities = np.tile([0.1, 0.8, 0.1], (len(actual), 1))
    report = _promotion_report(probabilities, actual)
    assert report["promotion_ready"] is False
    assert report["checks"]["beats_majority_baseline"] is False
    assert report["checks"]["directional_accuracy"] is False
