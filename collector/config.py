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

    # Instruments to collect
    instruments: tuple[str, ...] = tuple(
        os.environ.get("COLLECTOR_INSTRUMENTS", "NIFTY").split(",")
    )

    # NSE adapter
    nse_base_url: str = "https://www.nseindia.com"
    nse_option_chain_path: str = "/api/option-chain-indices"
    nse_request_timeout_seconds: int = 10
    nse_max_retries: int = 3

    # Yahoo adapter
    yahoo_symbol_map: dict = None  # set in __post_init__

    def __post_init__(self):
        object.__setattr__(
            self,
            "yahoo_symbol_map",
            {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK"},
        )


config = Config()
