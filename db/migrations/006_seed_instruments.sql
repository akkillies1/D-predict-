-- Deterministic reference data required for a usable fresh installation.
insert into instruments (symbol, exchange, lot_size, name, instrument_type, provider_symbol, canonical_source)
values
  ('NIFTY', 'NSE', 75, 'NIFTY 50', 'INDEX', '^NSEI', 'seed'),
  ('BANKNIFTY', 'NSE', 30, 'NIFTY Bank', 'INDEX', '^NSEBANK', 'seed')
on conflict (symbol) do update set
  name = excluded.name,
  exchange = excluded.exchange,
  lot_size = excluded.lot_size,
  instrument_type = excluded.instrument_type,
  provider_symbol = excluded.provider_symbol,
  canonical_source = excluded.canonical_source;
