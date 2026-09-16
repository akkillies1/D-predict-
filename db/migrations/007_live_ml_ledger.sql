-- Make the live ML prediction ledger idempotent across engine polling cycles.
create unique index if not exists uq_prediction_ledger_live
    on prediction_ledger (symbol, timestamp, horizon, model_version);
