"""Radar universe + closed-form buy-evidence rules.

The radar list is a broad set of liquid NSE tickers used for DISCOVERY only —
it is a candidate watchlist, not a claim about any index composition. Rules
here are pure formulas over real daily closes/volumes; each returns the exact
numbers that fired it so an alert can always be audited. No ML: every current
artifact fails the OOS promotion gate, so a model trigger would be noise.
"""

from __future__ import annotations

from datetime import datetime, timezone
from math import sqrt
from zoneinfo import ZoneInfo

MIN_BARS_PRICE = 22          # momentum_turn (needs two overlapping 20-bar windows) + SMA cross prev window
MIN_BARS_VOLUME = 21         # volume_z20_spike
MOM_NET_GATE = 0.003         # 20-session return must clear ~0.30% — above a CNC round trip's costs
VOL_Z_THRESHOLD = 2.0        # spikes at least 2 std above the prior 20-session mean
VOL_Z_REQUIRE_UPDAY = 0.0    # 5-session drift must be strictly above this when the spike lands
SUSPECT_JUMP = 0.25          # |1-day move| this large reads as a split/corporate-action artifact, not momentum
IST = ZoneInfo("Asia/Kolkata")


def drop_partial_last_bar(items, timestamp_of, now: datetime | None = None):
    """Yahoo timestamps each NSE daily bar at that session's midnight IST, so
    an intraday sweep sees TODAY's bar still being written — a cross measured
    on it can vanish at the close. Today's bar is therefore only usable after
    the 15:30 IST close (plus a 10-minute settling buffer); earlier sessions
    are always complete. Bars are oldest-first; only the tail can be live."""
    if not items:
        return items
    ts = timestamp_of(items[-1])
    if ts is None:
        return items
    now_ist = (now or datetime.now(timezone.utc)).astimezone(IST)
    ts_ist = ts.astimezone(IST) if ts.tzinfo else datetime.fromtimestamp(ts.timestamp(), IST)
    if ts_ist.date() != now_ist.date():
        return items
    session_closed = (now_ist.hour, now_ist.minute) >= (15, 40)
    return items if session_closed else items[:-1]

RADAR_SYMBOLS: tuple[str, ...] = (
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "ITC", "HINDUNILVR", "SBIN",
    "BHARTIARTL", "LT", "AXISBANK", "KOTAKBANK", "BAJFINANCE", "ASIANPAINT",
    "MARUTI", "SUNPHARMA", "TITAN", "ULTRACEMCO", "ONGC", "NTPC", "POWERGRID",
    "M&M", "TATASTEEL", "JSWSTEEL", "ADANIENT", "ADANIPORTS", "COALINDIA",
    "HCLTECH", "WIPRO", "TECHM", "NESTLEIND", "INDUSINDBK", "HINDALCO",
    "GRASIM", "PIDILITIND", "VEDL", "DLF", "DMART", "TRENT", "ZOMATO",
    "GODREJCP", "SIEMENS", "HAVELLS", "BEL", "BHEL", "IRFC", "RECLTD",
    "PNB", "SAIL", "NMDC", "MIDC", "HEROMOTOCO", "EICHERMOT", "MOTHERSON",
    "TVSMOTOR", "BAJAJ-AUTO", "BAJAJFINSV", "SHRIRAMFIN", "CHOLAFIN",
    "AUROPHARMA", "DIVISLAB", "LUPIN", "DRREDDY", "CIPLA", "APOLLOHOSP",
    "TORNTPHARM", "BPCL", "IOC", "GAIL", "UPL", "CONCOR", "IDFCFIRSTB",
    "FEDERALBNK", "IKFEL", "IDEA", "IDEFP", "SUNTV", "PVR", "POLYCAB",
    "VOLTAS", "CCD", "LAURION", "MPHASIS", "COFORGE", "LTIM", "CUMMINS",
    "BOSCHLTD", "MRF", "DELHIVERY", "OFSS", "SBILIFE", "HDFCLIFE", "IEX",
    "NHPC", "SJVN", "IRCON", "RITES", "RVNL", "METROBRAND", "KEI",
)


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def _std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    m = _mean(values)
    return sqrt(sum((v - m) ** 2 for v in values) / (len(values) - 1))


def momentum_turn(closes: list[float]) -> dict | None:
    """20-session return crosses, from below, a net-of-cost gate (costs and
    buffer included in the gate itself)."""
    if len(closes) < MIN_BARS_PRICE or closes[-21] <= 0 or closes[-22] <= 0:
        return None
    now = closes[-1] / closes[-21] - 1
    prev = closes[-2] / closes[-22] - 1
    if prev <= MOM_NET_GATE < now:
        return {
            "momentum20d_now": round(now, 5),
            "momentum20d_prev": round(prev, 5),
            "net_gate": MOM_NET_GATE,
        }
    return None


def sma20_cross_up(closes: list[float]) -> dict | None:
    """Close crosses above its own trailing 20-session mean (the exact
    condition the sma_trend backtest rule trades)."""
    if len(closes) < MIN_BARS_PRICE:
        return None
    sma_now = _mean(closes[-20:])
    sma_prev = _mean(closes[-21:-1])
    if closes[-2] <= sma_prev and closes[-1] > sma_now:
        return {
            "close": round(closes[-1], 2),
            "sma20": round(sma_now, 2),
            "prev_close": round(closes[-2], 2),
            "prev_sma20": round(sma_prev, 2),
        }
    return None


def volume_z20_spike(closes: list[float], volumes: list[float | None]) -> dict | None:
    """Volume at least 2 std above the prior 20-session mean on a day inside
    a rising 5-session drift — volume_z20 carried the strongest panel IC
    (data/reports/edge_1d_all.json)."""
    if len(closes) < MIN_BARS_PRICE or len(volumes) < MIN_BARS_VOLUME:
        return None
    window = volumes[-21:-1]
    latest = volumes[-1]
    if latest is None or any(v is None for v in window):
        return None
    window_values = [float(v) for v in window]
    mean = _mean(window_values)
    std = _std(window_values)
    if std <= 0:
        return None
    z = (float(latest) - mean) / std
    drift5 = closes[-1] / closes[-6] - 1
    if z >= VOL_Z_THRESHOLD and drift5 > VOL_Z_REQUIRE_UPDAY:
        return {
            "volume_z20": round(z, 2),
            "volume": int(latest),
            "mean_volume20": round(mean, 0),
            "drift5d": round(drift5, 5),
        }
    return None


def evaluate_rules(closes: list[float], volumes: list[float | None]) -> list[tuple[str, dict]]:
    """Every rule is evaluated independently; one bar window can raise more
    than one alert (each is separately deduped and auditable)."""
    fired: list[tuple[str, dict]] = []
    if len(closes) >= 2 and closes[-2] > 0 and abs(closes[-1] / closes[-2] - 1) > SUSPECT_JUMP:
        # A one-day re-pricing this large is almost always a split/data
        # artifact in an unadjusted series; every rule below would misfire.
        return fired
    for name, evidence in (
        ("momentum_turn", momentum_turn(closes)),
        ("sma20_cross_up", sma20_cross_up(closes)),
        ("volume_z20_spike", volume_z20_spike(closes, volumes)),
    ):
        if evidence is not None:
            fired.append((name, evidence))
    return fired
