import pytest

from training.position_ledger import Position, PositionLedger


def position(position_id="p1", symbol="RELIANCE", direction="LONG"):
    return Position(
        position_id=position_id,
        symbol=symbol,
        direction=direction,
        entry_timestamp="2026-09-15T10:00:00Z",
        entry_price=100.0,
        planned_exit_timestamp="2026-09-17T10:00:00Z",
        position_weight=0.25,
        capital_allocated=25_000.0,
    )


def test_open_close_releases_exposure():
    ledger = PositionLedger()
    ledger.open(position())
    assert ledger.gross_exposure() == pytest.approx(0.25)
    assert ledger.current_capital() == pytest.approx(25_000.0)

    closed = ledger.close("p1", "2026-09-17T10:00:00Z", 110.0)
    assert closed.status == "CLOSED"
    assert closed.realized_pnl == pytest.approx(2500.0)
    assert ledger.gross_exposure() == pytest.approx(0.0)
    assert ledger.current_capital() == pytest.approx(0.0)


def test_overlapping_same_symbol_is_rejected_without_pyramiding():
    ledger = PositionLedger()
    ledger.open(position("p1"))
    with pytest.raises(ValueError, match="overlapping active position"):
        ledger.open(position("p2"))


def test_short_pnl_direction_is_inverted():
    ledger = PositionLedger()
    ledger.open(position("p1", direction="SHORT"))
    closed = ledger.close("p1", "2026-09-17T10:00:00Z", 90.0)
    assert closed.realized_pnl == pytest.approx(2500.0)


def test_duplicate_id_and_invalid_price_are_rejected():
    ledger = PositionLedger()
    ledger.open(position())
    with pytest.raises(ValueError, match="duplicate position id"):
        ledger.open(position())
    with pytest.raises(ValueError, match="exit price"):
        ledger.close("p1", "2026-09-17T10:00:00Z", 0)
