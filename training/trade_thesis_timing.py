"""Attach probabilistic time-to-target estimates to a trade thesis."""
from __future__ import annotations

import pandas as pd

from training.target_timing import TargetTimingConfig, estimate_first_passage_times


def attach_target_timing(thesis: dict, bars: pd.DataFrame, config: TargetTimingConfig | None = None) -> dict:
    """Enrich an existing thesis with ETA distributions for every target.

    The target price is never changed. Timing is estimated independently from
    historical first-passage events and is explicit when history is insufficient.
    """
    if thesis.get("decision") != "EXECUTABLE":
        return thesis
    entry = float(thesis["entry_price"])
    direction = str(thesis["direction"])
    enriched = dict(thesis)
    targets = []
    for target in thesis.get("targets", []):
        timing = estimate_first_passage_times(
            bars,
            entry_price=entry,
            target_price=float(target["price"]),
            direction=direction,
            config=config,
        )
        item = dict(target)
        item["time_to_target"] = timing
        targets.append(item)
    enriched["targets"] = targets
    enriched["timing_model"] = "empirical_first_passage_time"
    enriched["timing_warning"] = "Target arrival time is probabilistic, not an exact timestamp."
    return enriched
