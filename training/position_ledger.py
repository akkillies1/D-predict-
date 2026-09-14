"""Deterministic active-position ledger for shadow/backtest integration.

This module models portfolio state, not broker execution. A position must move
OPEN -> CLOSED and capital/exposure is released at close. Overlap is rejected by
default so 3d/5d predictions cannot silently create concurrent exposure.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Iterable


@dataclass
class Position:
    position_id: str
    symbol: str
    direction: str
    entry_timestamp: str
    entry_price: float
    planned_exit_timestamp: str
    position_weight: float
    capital_allocated: float
    status: str = "OPEN"
    actual_exit_timestamp: str | None = None
    exit_price: float | None = None
    realized_pnl: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class PositionLedger:
    def __init__(self, allow_pyramiding: bool = False):
        self.allow_pyramiding = allow_pyramiding
        self.positions: dict[str, Position] = {}

    def open(self, position: Position) -> None:
        if position.position_id in self.positions:
            raise ValueError(f"duplicate position id: {position.position_id}")
        if position.entry_price <= 0 or position.position_weight <= 0 or position.capital_allocated <= 0:
            raise ValueError("position sizing and entry price must be positive")
        if position.direction not in {"LONG", "SHORT"}:
            raise ValueError("direction must be LONG or SHORT")
        if not self.allow_pyramiding and self.has_open(position.symbol):
            raise ValueError(f"overlapping active position for {position.symbol}")
        self.positions[position.position_id] = position

    def close(self, position_id: str, exit_timestamp: str, exit_price: float) -> Position:
        position = self.positions.get(position_id)
        if position is None:
            raise KeyError(position_id)
        if position.status != "OPEN":
            raise ValueError(f"position {position_id} is not open")
        if exit_price <= 0:
            raise ValueError("exit price must be positive")
        gross_return = (exit_price / position.entry_price) - 1.0
        if position.direction == "SHORT":
            gross_return = -gross_return
        position.actual_exit_timestamp = exit_timestamp
        position.exit_price = float(exit_price)
        position.realized_pnl = position.capital_allocated * gross_return
        position.status = "CLOSED"
        return position

    def has_open(self, symbol: str) -> bool:
        return any(p.symbol == symbol and p.status == "OPEN" for p in self.positions.values())

    def open_positions(self) -> list[Position]:
        return [p for p in self.positions.values() if p.status == "OPEN"]

    def gross_exposure(self) -> float:
        return sum(p.position_weight for p in self.open_positions())

    def symbol_exposure(self, symbol: str) -> float:
        return sum(p.position_weight for p in self.open_positions() if p.symbol == symbol)

    def current_capital(self) -> float:
        return sum(p.capital_allocated for p in self.open_positions())

    def snapshot(self) -> list[dict]:
        return [p.to_dict() for p in self.positions.values()]
