"""Tests for the official NSE permitted-lot CSV parser."""
from collector.adapters.nse import _parse_lot_size_csv, _parse_nse_response_timestamp


def test_parses_exact_symbol_and_positive_market_lot():
    csv_text = "\ufeffSYMBOL,MARKET LOT\nNIFTY,25\nRELIANCE,250\nINVALID,0\nBAD,unknown\n"

    assert _parse_lot_size_csv(csv_text) == {"NIFTY": 25, "RELIANCE": 250}


def test_parses_official_expiry_column_format():
    csv_text = (
        "UNDERLYING,SYMBOL,OCT-26,NOV-26,DEC-26\n"
        "NIFTY 50,NIFTY,65,65,65\n"
        "NIFTY BANK,BANKNIFTY,30,30,30\n"
        "Derivatives on Individual Securities,Symbol,OCT-26,NOV-26,DEC-26\n"
        "RELIANCE,RELIANCE,250,250,250\n"
    )

    assert _parse_lot_size_csv(csv_text) == {"NIFTY": 65, "BANKNIFTY": 30, "RELIANCE": 250}


def test_conflicting_expiry_columns_are_unavailable():
    csv_text = "UNDERLYING,SYMBOL,OCT-26,NOV-26\nNIFTY 50,NIFTY,65,75\n"

    assert _parse_lot_size_csv(csv_text) == {}


def test_unknown_schema_and_empty_csv_fail_closed():
    assert _parse_lot_size_csv("") == {}
    assert _parse_lot_size_csv("name,value\nNIFTY,25\n") == {}


def test_conflicting_duplicate_symbol_is_not_sized():
    csv_text = "SYMBOL,MARKET LOT\nNIFTY,25\nNIFTY,50\nNIFTY,75\nRELIANCE,250\n"

    parsed = _parse_lot_size_csv(csv_text)

    assert "NIFTY" not in parsed
    assert parsed["RELIANCE"] == 250


def test_missing_or_invalid_source_timestamp_is_not_replaced_with_local_time():
    assert _parse_nse_response_timestamp({"records": {}}) is None
    assert _parse_nse_response_timestamp({"records": {"timestamp": "not-a-timestamp"}}) is None
    assert _parse_nse_response_timestamp({"records": {"timestamp": "13-Oct-2026 14:32:01"}}) is not None
