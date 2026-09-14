"""Poll D-predict's local market API into a persistent live-shadow session.

This adapter deliberately does not manufacture model probabilities. Predictions
must arrive through a validated JSONL prediction stream and are recorded by the
same restart-safe shadow engine. Market observations are real upstream values;
no synthetic prices are created.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

from training.live_shadow import LiveShadowConfig, load_session, observe_bar, record_prediction, save_session


def fetch_quote(api_base: str, symbol: str) -> dict:
    url = f"{api_base.rstrip('/')}/api/market/{quote(symbol, safe='')}/live"
    request = Request(url, headers={"User-Agent": "D-predict-live-shadow/1.0"})
    with urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        raise RuntimeError(payload.get("error", "MARKET_DATA_UNAVAILABLE"))
    if payload.get("close") is None:
        raise RuntimeError("LIVE_QUOTE_HAS_NO_CLOSE")
    return {
        "timestamp": payload["timestamp"],
        "symbol": payload["symbol"],
        "close": payload["close"],
        "source": payload.get("source", "market-api"),
        "status": payload.get("status", "UNKNOWN"),
    }


def run_once(api_base: str, symbols: list[str], state_path: Path, config: LiveShadowConfig | None = None, session_id: str = "default") -> dict:
    state = load_session(state_path, config=config, session_id=session_id)
    for symbol in symbols:
        observe_bar(state, fetch_quote(api_base, symbol))
    save_session(state_path, state)
    from training.live_shadow import summary
    return summary(state)


def ingest_predictions(path: Path, state_path: Path, config: LiveShadowConfig | None = None, session_id: str = "default") -> None:
    state = load_session(state_path, config=config, session_id=session_id)
    if not path.exists():
        return
    lines = path.read_text(encoding="utf-8").splitlines()
    consumed = int(state.get("prediction_stream_offset", 0))
    for index, line in enumerate(lines[consumed:], start=consumed):
        if not line.strip():
            consumed = index + 1
            continue
        event = json.loads(line)
        record_prediction(state, event)
        consumed = index + 1
        save_session(state_path, state)
    state["prediction_stream_offset"] = consumed
    save_session(state_path, state)


def main() -> None:
    parser = argparse.ArgumentParser(description="Feed D-predict live market observations into a persistent shadow session")
    parser.add_argument("symbols", nargs="+", help="Symbols supported by the local market API")
    parser.add_argument("--api-base", default="http://127.0.0.1:4100")
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--predictions", type=Path, help="Optional append-only JSONL stream of model predictions")
    parser.add_argument("--interval", type=float, default=15.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--session-id", default="default")
    args = parser.parse_args()
    config = LiveShadowConfig()
    while True:
        try:
            if args.predictions:
                ingest_predictions(args.predictions, args.state, config, args.session_id)
            result = run_once(args.api_base, [symbol.upper() for symbol in args.symbols], args.state, config, args.session_id)
            print(json.dumps(result, indent=2), flush=True)
        except Exception as error:
            print(json.dumps({"mode": "LIVE_SHADOW", "ok": False, "error": str(error)}), flush=True)
        if args.once:
            return
        time.sleep(max(1.0, args.interval))


if __name__ == "__main__":
    main()
