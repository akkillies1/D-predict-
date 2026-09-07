"""NSE option-chain adapter.

NSE's site requires an initial 'warm-up' GET to the homepage to receive cookies
before the API endpoint will respond (it rejects cold requests). This adapter
owns that quirk, along with retry/backoff and raw->canonical mapping, so
nothing downstream ever needs to know NSE-specific details.

NOTE: NSE frequently changes response shape and rate-limits aggressively.
Treat the field-mapping section as the part most likely to need adjustment
once you're running this against live responses.
"""

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

from collector.canonical.options import CanonicalOptionSnapshot
from collector.config import config
from collector.logging_config import get_logger

logger = get_logger(__name__)

ADAPTER_VERSION = "nse_adapter_v1"
IST = ZoneInfo("Asia/Kolkata")

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json",
}


class NSEAdapter:
    """Owns a warmed-up session; reuse one instance across polls rather than
    creating a fresh session every call."""

    def __init__(self):
        self._session = requests.Session()
        self._session.headers.update(_HEADERS)
        self._warmed_up = False

    def _warm_up(self) -> None:
        self._session.get(config.nse_base_url, timeout=config.nse_request_timeout_seconds)
        self._warmed_up = True

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=10),
    )
    def _get(self, path: str, params: dict) -> dict:
        if not self._warmed_up:
            self._warm_up()
        resp = self._session.get(
            f"{config.nse_base_url}{path}",
            params=params,
            timeout=config.nse_request_timeout_seconds,
        )
        if resp.status_code == 401:
            # cookies expired mid-session — re-warm and let @retry try again
            self._warmed_up = False
            resp.raise_for_status()
        resp.raise_for_status()
        return resp.json()

    def fetch_option_chain(self, symbol: str) -> list[CanonicalOptionSnapshot]:
        """Fetch the full option chain for a symbol and return canonical snapshots."""
        raw = self._get(config.nse_option_chain_path, params={"symbol": symbol})
        collected_now = datetime.now(timezone.utc)
        snapshots: list[CanonicalOptionSnapshot] = []

        for record in raw.get("records", {}).get("data", []):
            expiry_raw = record.get("expiryDate")  # e.g. '18-Sep-2026'
            expiry = _parse_nse_date(expiry_raw)
            strike = record.get("strikePrice")

            for opt_type, key in (("CE", "CE"), ("PE", "PE")):
                leg = record.get(key)
                if not leg:
                    continue
                snapshots.append(
                    CanonicalOptionSnapshot(
                        instrument_symbol=symbol,
                        expiry_date=expiry,
                        strike=float(strike),
                        option_type=opt_type,
                        # NSE doesn't give a precise per-record market timestamp in this
                        # endpoint — fall back to the response's overall timestamp field.
                        market_timestamp=_parse_nse_response_timestamp(raw, fallback=collected_now),
                        ltp=leg.get("lastPrice"),
                        bid=leg.get("bidprice"),
                        ask=leg.get("askPrice"),
                        volume=leg.get("totalTradedVolume"),
                        oi=leg.get("openInterest"),
                        oi_change=leg.get("changeinOpenInterest"),
                        iv=leg.get("impliedVolatility"),
                        delta=None,   # NSE doesn't provide greeks — compute in feature layer
                        gamma=None,
                        theta=None,
                        vega=None,
                        source="nse",
                        source_version=ADAPTER_VERSION,
                    )
                )
        logger.info("nse_adapter fetched %d option legs for %s", len(snapshots), symbol)
        return snapshots


def _parse_nse_date(raw: str) -> date:
    return datetime.strptime(raw, "%d-%b-%Y").date()


def _parse_nse_response_timestamp(raw: dict, fallback: datetime) -> datetime:
    ts = raw.get("records", {}).get("timestamp")
    if not ts:
        return fallback
    try:
        # NSE format observed: '18-Sep-2026 14:32:01', stated in IST.
        naive = datetime.strptime(ts, "%d-%b-%Y %H:%M:%S")
        ist = naive.replace(tzinfo=IST)
        return ist.astimezone(timezone.utc)  # store everything in UTC
    except ValueError:
        return fallback
