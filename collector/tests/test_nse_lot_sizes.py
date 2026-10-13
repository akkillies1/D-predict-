"""Tests for the official NSE permitted-lot CSV parser."""
from collector.adapters.nse import _parse_lot_size_csv


def test_parses_exact_symbol_and_positive_market_lot():
    csv_text = "\ufeffSYMBOL,MARKET LOT\nNIFTY,25\nRELIANCE,250\nINVALID,0\nBAD,unknown\n"

    assert _parse_lot_size_csv(csv_text) == {"NIFTY": 25, "RELIANCE": 250}


def test_unknown_schema_and_empty_csv_fail_closed():
    assert _parse_lot_size_csv("") == {}
    assert _parse_lot_size_csv("name,value\nNIFTY,25\n") == {}


def test_conflicting_duplicate_symbol_is_not_sized():
    csv_text = "SYMBOL,MARKET LOT\nNIFTY,25\nNIFTY,50\nRELIANCE,250\n"

    parsed = _parse_lot_size_csv(csv_text)

    assert "NIFTY" not in parsed
    assert parsed["RELIANCE"] == 250
