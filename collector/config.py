"""Central configuration, loaded from environment variables (.env supported)."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    # Persistence
    database_url: str = os.environ.get("DATABASE_URL", "")  # postgres connection string (Supabase)

    # Polling
    option_chain_poll_seconds: int = int(os.environ.get("OPTION_CHAIN_POLL_SECONDS", "60"))
    price_bar_poll_seconds: int = int(os.environ.get("PRICE_BAR_POLL_SECONDS", "60"))

    # Radar alert sweep
    alert_sweep_seconds: int = int(os.environ.get("ALERT_SWEEP_SECONDS", "300"))
    radar_sweep_chunk: int = int(os.environ.get("RADAR_SWEEP_CHUNK", "8"))
    radar_max_onboarded: int = int(os.environ.get("RADAR_MAX_ONBOARDED", "20"))
    alert_cooldown_hours: int = int(os.environ.get("ALERT_COOLDOWN_HOURS", "24"))

    # Instruments to collect
    instruments: tuple[str, ...] = tuple(
        os.environ.get("COLLECTOR_INSTRUMENTS", "NIFTY").split(",")
    )

    # NSE adapter
    nse_base_url: str = "https://www.nseindia.com"
    nse_option_chain_indices_path: str = "/api/option-chain-v3"
    nse_option_chain_equities_path: str = "/api/option-chain-equities"
    nse_request_timeout_seconds: int = 10
    # Provider preference order. This contains provider names only; no
    # symbols, strikes, expiries, or lot sizes are encoded here.
    option_chain_providers: tuple[str, ...] = tuple(
        name.strip().lower() for name in os.environ.get("OPTION_CHAIN_PROVIDERS", "nse").split(",") if name.strip()
    )
    nse_max_retries: int = 3
    dhan_client_id: str | None = os.environ.get("DHAN_CLIENT_ID")
    dhan_access_token: str | None = os.environ.get("DHAN_ACCESS_TOKEN")
    dhan_request_timeout_seconds: int = 10

    # Yahoo adapter. Add symbols as plain Yahoo tickers (for example
    # RELIANCE.NS) or use the built-in index aliases below.
    yahoo_symbol_map: dict = None  # set in __post_init__

    def __post_init__(self):
        object.__setattr__(
            self,
            "yahoo_symbol_map",
            {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "SBI": "SBIN.NS"},
        )


config = Config()
