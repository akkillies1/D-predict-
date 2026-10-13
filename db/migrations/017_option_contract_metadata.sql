-- Provider-neutral option contract metadata.
-- Lot size belongs to the contract, not the underlying instrument. NULL means
-- the provider has not supplied authoritative contract sizing yet; execution
-- must remain blocked until it is known.
alter table option_contracts
    add column if not exists lot_size integer;

alter table option_contracts
    drop constraint if exists option_contracts_lot_size_positive;

alter table option_contracts
    add constraint option_contracts_lot_size_positive
    check (lot_size is null or lot_size > 0);
