"""Provider-neutral option-chain contracts.

The collector orchestrator depends on this protocol rather than a concrete
market-data vendor. Providers return canonical snapshots; provider-specific
authentication, HTTP quirks, and response mapping stay inside adapters.
"""

from typing import Protocol

from collector.canonical.options import CanonicalOptionSnapshot


class OptionChainProvider(Protocol):
    name: str
    version: str

    def supports(self, symbol: str) -> bool:
        """Return whether the provider can serve an option chain for symbol."""

    def fetch_option_chain(self, symbol: str) -> list[CanonicalOptionSnapshot]:
        """Return canonical snapshots only; never fabricate missing fields."""
