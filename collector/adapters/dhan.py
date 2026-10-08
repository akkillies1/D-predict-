"""Optional DhanHQ option-chain provider.

The provider is disabled unless DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN are
configured. It resolves underlyings and contract metadata from Dhan's
instrument master rather than a hard-coded symbol/lot-size table.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, timezone
from typing import Any

import requests

from collector.canonical.options import CanonicalOptionSnapshot
from collector.config import config

DHAN_API = "https://api.dhan.co/v2"
DHAN_MASTER = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv"


class DhanOptionChainProvider:
    name = "dhan"
    version = "dhan_option_chain_v2"

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update({"Accept": "application/json", "User-Agent": "D-Predict/2.0"})
        self._master: list[dict[str, str]] | None = None

    def _configured(self) -> bool:
        return bool(config.dhan_client_id and config.dhan_access_token)

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "access-token": config.dhan_access_token or "",
            "client-id": config.dhan_client_id or "",
        }

    def _load_master(self) -> list[dict[str, str]]:
        if self._master is not None:
            return self._master
        response = self._session.get(DHAN_MASTER, timeout=config.dhan_request_timeout_seconds)
        response.raise_for_status()
        self._master = list(csv.DictReader(io.StringIO(response.text)))
        return self._master

    @staticmethod
    def _value(row: dict[str, str], *names: str) -> str:
        for name in names:
            value = row.get(name)
            if value:
                return value.strip()
        return ""

    def _resolve_underlying(self, symbol: str) -> dict[str, str] | None:
        target = symbol.strip().upper()
        candidates = []
        for row in self._load_master():
            row_symbol = self._value(row, "SYMBOL_NAME", "SM_SYMBOL_NAME").upper()
            display = self._value(row, "DISPLAY_NAME", "SM_CUSTOM_SYMBOL").upper()
            instrument = self._value(row, "INSTRUMENT", "SEM_INSTRUMENT_NAME").upper()
            exchange = self._value(row, "EXCH_ID", "SEM_EXM_EXCH_ID").upper()
            segment = self._value(row, "SEGMENT", "SEM_SEGMENT").upper()
            if exchange != "NSE":
                continue
            if row_symbol != target and display != target:
                continue
            if instrument == "INDEX":
                candidates.append(row)
            elif segment == "E":
                candidates.append(row)
        return candidates[0] if candidates else None

    def supports(self, symbol: str) -> bool:
        if not self._configured() or not symbol.strip():
            return False
        return self._resolve_underlying(symbol) is not None

    def fetch_option_chain(self, symbol: str) -> list[CanonicalOptionSnapshot]:
        if not self._configured():
            return []

        underlying = self._resolve_underlying(symbol)
        if underlying is None:
            return []

        security_id = self._value(underlying, "SECURITY_ID", "SEM_SMST_SECURITY_ID")
        if not security_id:
            return []

        instrument = self._value(underlying, "INSTRUMENT", "SEM_INSTRUMENT_NAME").upper()
        segment = "IDX_I" if instrument == "INDEX" else "NSE_EQ"

        expiry_response = self._session.post(
            f"{DHAN_API}/optionchain/expirylist",
            headers=self._headers(),
            json={"UnderlyingScrip": int(float(security_id)), "UnderlyingSeg": segment},
            timeout=config.dhan_request_timeout_seconds,
        )
        expiry_response.raise_for_status()
        expiries = expiry_response.json().get("data") or []
        if not expiries:
            return []
        expiry = sorted(str(item) for item in expiries)[0]

        response = self._session.post(
            f"{DHAN_API}/optionchain",
            headers=self._headers(),
            json={"UnderlyingScrip": int(float(security_id)), "UnderlyingSeg": segment, "Expiry": expiry},
            timeout=config.dhan_request_timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        chain = payload.get("data", {})
        spot = chain.get("last_price")
        if not isinstance(chain.get("oc"), dict):
            return []

        contract_meta: dict[tuple[str, float, str], dict[str, str]] = {}
        for row in self._load_master():
            if self._value(row, "EXCH_ID", "SEM_EXM_EXCH_ID").upper() != "NSE":
                continue
            row_symbol = self._value(row, "UNDERLYING_SYMBOL").upper()
            if row_symbol != symbol.upper():
                continue
            row_expiry = self._value(row, "SM_EXPIRY_DATE", "SEM_EXPIRY_DATE")
            if row_expiry and row_expiry != expiry:
                continue
            option_type = self._value(row, "OPTION_TYPE", "SEM_OPTION_TYPE").upper()
            strike_text = self._value(row, "STRIKE_PRICE", "SEM_STRIKE_PRICE")
            lot_text = self._value(row, "LOT_SIZE", "SEM_LOT_UNITS")
            if option_type not in {"CE", "PE"} or not strike_text:
                continue
            try:
                strike = float(strike_text)
            except ValueError:
                continue
            contract_meta[(row_expiry or expiry, strike, option_type)] = {"lot_size": lot_text}

        now = datetime.now(timezone.utc)
        snapshots: list[CanonicalOptionSnapshot] = []
        for strike_text, sides in chain["oc"].items():
            try:
                strike = float(strike_text)
            except (TypeError, ValueError):
                continue
            for option_type, key in (("CE", "ce"), ("PE", "pe")):
                item = sides.get(key) if isinstance(sides, dict) else None
                if not isinstance(item, dict):
                    continue
                meta = contract_meta.get((expiry, strike, option_type), {})
                lot_text = meta.get("lot_size", "")
                try:
                    lot_size = int(float(lot_text)) if lot_text else None
                except ValueError:
                    lot_size = None
                greeks = item.get("greeks") or {}
                snapshot = CanonicalOptionSnapshot(
                    instrument_symbol=symbol.upper(),
                    expiry_date=datetime.fromisoformat(expiry).date(),
                    strike=strike,
                    option_type=option_type,
                    market_timestamp=now,
                    ltp=float(item["last_price"]) if item.get("last_price") is not None else None,
                    bid=float(item["top_bid_price"]) if item.get("top_bid_price") is not None else None,
                    ask=float(item["top_ask_price"]) if item.get("top_ask_price") is not None else None,
                    volume=int(item["volume"]) if item.get("volume") is not None else None,
                    oi=int(item["oi"]) if item.get("oi") is not None else None,
                    oi_change=(int(item["oi"]) - int(item["previous_oi"])) if item.get("oi") is not None and item.get("previous_oi") is not None else None,
                    iv=float(item["implied_volatility"]) if item.get("implied_volatility") is not None else None,
                    delta=float(greeks["delta"]) if greeks.get("delta") is not None else None,
                    gamma=float(greeks["gamma"]) if greeks.get("gamma") is not None else None,
                    theta=float(greeks["theta"]) if greeks.get("theta") is not None else None,
                    vega=float(greeks["vega"]) if greeks.get("vega") is not None else None,
                    lot_size=lot_size,
                    source="dhan",
                    source_version=self.version,
                )
                snapshot.validate_shape()
                snapshots.append(snapshot)
        return snapshots
