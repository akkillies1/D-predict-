"""Provider-selection regressions for canonical option metadata quality."""
from __future__ import annotations

from datetime import date, datetime, timezone
from types import SimpleNamespace

import collector.scheduler.poller as poller_module
from collector.canonical.options import CanonicalOptionSnapshot
from collector.scheduler.poller import Poller


def _snapshot(source: str, lot_size: int | None) -> CanonicalOptionSnapshot:
    return CanonicalOptionSnapshot(
        instrument_symbol="TEST",
        expiry_date=date(2026, 10, 30),
        strike=100.0,
        option_type="CE",
        market_timestamp=datetime.now(timezone.utc),
        ltp=10.0,
        bid=9.9,
        ask=10.1,
        volume=100,
        oi=1000,
        oi_change=10,
        iv=20.0,
        delta=None,
        gamma=None,
        theta=None,
        vega=None,
        lot_size=lot_size,
        source=source,
        source_version="fixture",
    )


class Provider:
    def __init__(self, name: str, lot_size: int | None):
        self.name = name
        self.version = "fixture"
        self.lot_size = lot_size

    def supports(self, symbol: str) -> bool:
        return symbol == "TEST"

    def fetch_option_chain(self, symbol: str):
        return [_snapshot(self.name, self.lot_size)]


class Persistence:
    def __init__(self):
        self.saved = []

    def active_symbols(self):
        return ["TEST"]

    def save_option_snapshots(self, rows, run_id):
        self.saved.extend(rows)


def _poller(monkeypatch, providers):
    """Construct a real Poller while replacing external adapters and DB."""
    monkeypatch.setattr(poller_module, "nse_session_active", lambda now=None: True)
    by_name = {provider.name: provider for provider in providers}
    monkeypatch.setattr(poller_module, "NSEAdapter", lambda: by_name["nse"])
    monkeypatch.setattr(poller_module, "DhanOptionChainProvider", lambda: by_name["dhan"])
    monkeypatch.setattr(poller_module, "YahooAdapter", lambda: object())
    persistence = Persistence()
    monkeypatch.setattr(poller_module, "PostgresPersistence", lambda: persistence)
    monkeypatch.setattr(
        poller_module,
        "config",
        SimpleNamespace(option_chain_providers=tuple(provider.name for provider in providers)),
    )

    poller = Poller()
    assert poller._db is persistence
    assert poller._yahoo is not None
    assert poller._radar_cursor == 0
    assert poller._chain_empties == {}
    assert poller._chain_muted_until == {}
    assert poller._option_providers == providers
    return poller


def test_provider_with_authoritative_lot_size_beats_incomplete_first_provider(monkeypatch):
    providers = [Provider("nse", None), Provider("dhan", 25)]
    poller = _poller(monkeypatch, providers)

    poller.run_option_chain_poll()

    assert len(poller._db.saved) == 1
    assert poller._db.saved[0].source == "dhan"
    assert poller._db.saved[0].lot_size == 25


def test_first_valid_chain_is_kept_for_research_if_no_provider_has_lot_size(monkeypatch):
    providers = [Provider("nse", None), Provider("dhan", None)]
    poller = _poller(monkeypatch, providers)

    poller.run_option_chain_poll()

    assert len(poller._db.saved) == 1
    assert poller._db.saved[0].source == "nse"
    assert poller._db.saved[0].lot_size is None
