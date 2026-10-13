"""Fixture tests for Dhan option contract metadata joins.

These tests deliberately use dated instrument-master rows instead of a hard-coded
symbol/lot-size table. Missing or mismatched metadata must remain unavailable.
"""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import Mock

import collector.adapters.dhan as dhan_module
from collector.adapters.dhan import DhanOptionChainProvider


class Response:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def _master_rows(expiry: str = "2026-10-28 14:30:00") -> list[dict[str, str]]:
    return [
        {
            "EXCH_ID": "NSE",
            "SYMBOL_NAME": "NIFTY",
            "INSTRUMENT": "INDEX",
            "SECURITY_ID": "13",
        },
        {
            "EXCH_ID": "NSE",
            "UNDERLYING_SYMBOL": "NIFTY",
            "SM_EXPIRY_DATE": expiry,
            "OPTION_TYPE": "CE",
            "STRIKE_PRICE": "25000",
            "LOT_SIZE": "75",
        },
        {
            "EXCH_ID": "NSE",
            "UNDERLYING_SYMBOL": "NIFTY",
            "SM_EXPIRY_DATE": expiry,
            "OPTION_TYPE": "PE",
            "STRIKE_PRICE": "25000",
            "LOT_SIZE": "75",
        },
    ]


def _provider(monkeypatch, rows):
    monkeypatch.setattr(dhan_module, "config", SimpleNamespace(
        dhan_client_id="test-client",
        dhan_access_token="test-token",
        dhan_request_timeout_seconds=1,
    ))
    provider = DhanOptionChainProvider()
    provider._master = rows
    provider._session = Mock()
    provider._session.post.side_effect = [
        Response({"data": ["2026-10-28"]}),
        Response({
            "timestamp": "2026-10-13T09:00:00Z",
            "data": {
                "last_price": 25000,
                "oc": {
                    "25000": {
                        "ce": {"last_price": 150, "top_bid_price": 149, "top_ask_price": 151, "volume": 1000, "oi": 2000, "previous_oi": 1800, "implied_volatility": 14},
                        "pe": {"last_price": 110, "top_bid_price": 109, "top_ask_price": 111, "volume": 1200, "oi": 3000, "previous_oi": 2500, "implied_volatility": 15},
                    }
                },
            }
        }),
    ]
    return provider


def test_dhan_contract_lot_size_matches_iso_datetime_master_expiry(monkeypatch):
    provider = _provider(monkeypatch, _master_rows())

    rows = provider.fetch_option_chain("NIFTY")

    assert len(rows) == 2
    assert {row.option_type for row in rows} == {"CE", "PE"}
    assert {row.lot_size for row in rows} == {75}
    assert {row.expiry_date for row in rows} == {date(2026, 10, 28)}
    assert all(row.source == "dhan" for row in rows)


def test_dhan_contract_lot_size_supports_sem_column_names(monkeypatch):
    rows = [
        {
            "SEM_EXM_EXCH_ID": "NSE",
            "SM_SYMBOL_NAME": "NIFTY",
            "SEM_INSTRUMENT_NAME": "INDEX",
            "SEM_SMST_SECURITY_ID": "13",
        },
        {
            "SEM_EXM_EXCH_ID": "NSE",
            "UNDERLYING_SYMBOL": "NIFTY",
            "SEM_EXPIRY_DATE": "28-Oct-2026",
            "SEM_OPTION_TYPE": "CE",
            "SEM_STRIKE_PRICE": "25000",
            "SEM_LOT_UNITS": "75",
        },
        {
            "SEM_EXM_EXCH_ID": "NSE",
            "UNDERLYING_SYMBOL": "NIFTY",
            "SEM_EXPIRY_DATE": "28-Oct-2026",
            "SEM_OPTION_TYPE": "PE",
            "SEM_STRIKE_PRICE": "25000",
            "SEM_LOT_UNITS": "75",
        },
    ]
    provider = _provider(monkeypatch, rows)

    snapshots = provider.fetch_option_chain("NIFTY")

    assert len(snapshots) == 2
    assert {row.lot_size for row in snapshots} == {75}


def test_dhan_does_not_invent_missing_contract_lot_size(monkeypatch):
    rows = _master_rows()
    rows = [row for row in rows if row.get("OPTION_TYPE") != "PE"]
    provider = _provider(monkeypatch, rows)

    snapshots = provider.fetch_option_chain("NIFTY")

    by_type = {row.option_type: row for row in snapshots}
    assert by_type["CE"].lot_size == 75
    assert by_type["PE"].lot_size is None


def test_dhan_drops_chain_without_source_timestamp(monkeypatch):
    provider = _provider(monkeypatch, _master_rows())
    provider._session.post.side_effect = [
        Response({"data": ["2026-10-28"]}),
        Response({
            "data": {
                "last_price": 25000,
                "oc": {"25000": {"ce": {"last_price": 150}, "pe": {"last_price": 110}}},
            }
        }),
    ]

    assert provider.fetch_option_chain("NIFTY") == []
