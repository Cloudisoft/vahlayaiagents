-- Licensed company behind each bulk result ("New Cingular Wireless PCS"),
-- next to its network family ("AT&T Wireless").
alter table coverage_bulk_results add column if not exists carrier_entity text;

-- "Cellcom" (Wisconsin) was grouped under Verizon Wireless by a loose match.
update phone_observations set carrier = 'Cellcom' where carrier = 'Verizon Wireless' and carrier_raw ilike '%cellcom%';
update phone_intelligence set carrier = 'Cellcom' where carrier = 'Verizon Wireless' and carrier_raw ilike '%cellcom%';
