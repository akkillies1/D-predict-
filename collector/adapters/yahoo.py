"""Yahoo Finance adapter — underlying index price bars (NIFTY, BANKNIFTY)."""

from datetime import timezone
from zoneinfo import ZoneInfo

import yfinance as yf

from collector.canonical.price import CanonicalPriceBar
from collector.config import config
from collector.logging_config import get_logger

logger = get_logger(__name__)

ADAPTER_VERSION = "yahoo_adapter_v1"
IST = ZoneInfo("Asia/Kolkata")


class YahooAdapter:
    def fetch_price_bars(
        self, symbol: str, period: str = "1d", interval: str = "1m"
    ) -> list[CanonicalPriceBar]:
        yahoo_symbol = config.yahoo_symbol_map.get(symbol, symbol)

        df = yf.download(
            yahoo_symbol, period=period, interval=interval, progress=False
        )
        bars: list[CanonicalPriceBar] = []

        for ts, row in df.iterrows():
            market_ts = ts.to_pydatetime()
            if market_ts.tzinfo is None:
                # yfinance sometimes returns naive timestamps for index data;
                # ^NSEI/^NSEBANK bars are in IST, not UTC.
                market_ts = market_ts.replace(tzinfo=IST)
            market_ts = market_ts.astimezone(timezone.utc)  # store everything in UTC

            bars.append(
                CanonicalPriceBar(
                    instrument_symbol=symbol,
                    market_timestamp=market_ts,
                    timeframe=interval,
                    open=float(row["Open"]),
                    high=float(row["High"]),
                    low=float(row["Low"]),
                    close=float(row["Close"]),
                    volume=int(row["Volume"]) if "Volume" in row else None,
                    source="yfinance",
                    source_version=ADAPTER_VERSION,
                )
            )
        logger.info("yahoo_adapter fetched %d bars for %s", len(bars), symbol)
        return bars
