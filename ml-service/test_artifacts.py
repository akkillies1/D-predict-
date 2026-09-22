import tempfile
from pathlib import Path

import pytest

import app


def test_missing_artifact_is_explicit_abstention(monkeypatch):
    with tempfile.TemporaryDirectory() as directory:
        monkeypatch.setattr(app, "MODEL_ARTIFACT_DIR", Path(directory))
        with pytest.raises(app.HTTPException) as error:
            app._load_bundle("NIFTY", "1d")
        assert error.value.status_code == 503
        assert error.value.detail["code"] == "MODEL_ARTIFACT_UNAVAILABLE"


def test_artifact_path_is_symbol_and_horizon_scoped(monkeypatch):
    monkeypatch.setattr(app, "MODEL_ARTIFACT_DIR", Path("/tmp/dpredict-artifacts"))
    assert app._artifact_path("nifty", "3d").name == "NIFTY_3d_market_v1.joblib"
