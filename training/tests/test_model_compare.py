import pandas as pd

from training import model_compare


def _frame(rows: int = 330) -> pd.DataFrame:
    timestamps = pd.date_range("2020-01-01", periods=rows, freq="D", tz="UTC")
    data = {
        "timestamp": timestamps,
        "target_class": ["DOWN", "FLAT", "UP"] * (rows // 3) + ["DOWN"] * (rows % 3),
        "target_return": [(-0.01 + (i % 7) * 0.003) for i in range(rows)],
    }
    for idx, name in enumerate(model_compare.FEATURE_COLUMNS):
        data[name] = [(i + idx) / 100.0 for i in range(rows)]
    return pd.DataFrame(data).set_index("timestamp")


def test_candidate_factory_is_bounded_and_cpu_friendly():
    for name in model_compare.CANDIDATES:
        classifier, regressor = model_compare._models(name)
        assert classifier is not None
        assert regressor is not None


def test_compare_uses_purge_and_does_not_promote(monkeypatch, tmp_path):
    monkeypatch.setattr(model_compare, "load_frame", lambda symbol, horizon: _frame())
    monkeypatch.setattr(model_compare, "REPORT_DIR", tmp_path)

    report = model_compare.compare("TEST", "1d", 3, ("hist_gradient_boosting", "logistic_ridge"))

    assert report["purge_rows"] == 1
    assert report["promotion"] == "NONE"
    assert len(report["candidates"]) == 2
    assert all(candidate["oos_examples"] > 0 for candidate in report["candidates"])
    assert (tmp_path / "test_1d_model_comparison.json").exists()
