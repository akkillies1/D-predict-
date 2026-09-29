-- Widen buy_alerts rules for option-evidence alerts (collector/options_radar.py).
-- Same honesty contract as the price rules: closed-form, auditable evidence.
alter table buy_alerts drop constraint if exists buy_alerts_rule_check;
alter table buy_alerts add constraint buy_alerts_rule_check check (
    rule in (
        'momentum_turn', 'sma20_cross_up', 'volume_z20_spike',
        'pcr_band_cross', 'atm_iv_spike', 'atm_oi_buildup'
    )
);
