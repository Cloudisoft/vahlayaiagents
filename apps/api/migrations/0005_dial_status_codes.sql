-- Switch call results to Vahlay's dial status codes, and add what the Hari
-- SOP needs: call categories, per-department transfer targets and a
-- recording disclosure.

create temporary table disp_map (old_key text primary key, new_key text not null) on commit drop;
insert into disp_map values
  ('do_not_call','DNC'), ('voicemail','AA'), ('transferred','XFER'), ('interested_transferred','XFER'),
  ('disconnected_in_transfer','DA'), ('no_answer','NA'), ('busy','AB'), ('hung_up','HangUp'),
  ('not_in_service','ADC'), ('disconnected','DA'), ('connected','PU'), ('interested','FL'),
  ('not_interested','NI'), ('callback','CALLBK'), ('appointment_booked','CALLBK'),
  ('not_decision_maker','NoAvl'), ('decision_maker_callback','CALLBK'), ('already_with_provider','NI'),
  ('contract_locked','NoQua'), ('wrong_number','WN');

-- Make sure every target code exists for each org that has an old key.
insert into call_dispositions (organization_id, key, label, is_custom)
select distinct cd.organization_id, m.new_key, m.new_key, false
from call_dispositions cd join disp_map m on m.old_key = cd.key
on conflict (organization_id, key) do nothing;

update calls c set disposition_id = nd.id
from call_dispositions od
join disp_map m on m.old_key = od.key
join call_dispositions nd on nd.organization_id = od.organization_id and nd.key = m.new_key
where c.disposition_id = od.id;

delete from call_dispositions cd using disp_map m where cd.key = m.old_key and cd.is_custom = false;

update campaign_leads cl set last_disposition = m.new_key from disp_map m where cl.last_disposition = m.old_key;
update leads l set call_status = m.new_key from disp_map m where l.call_status = m.old_key;
update leads set call_status = 'NEW' where call_status = 'new';
update leads set call_status = 'INCALL' where call_status = 'calling';
alter table leads alter column call_status set default 'NEW';

update calls set ai_outcome = m.new_key from disp_map m where calls.ai_outcome = m.old_key;

alter table calls add column call_category text;

alter table campaigns
  add column transfer_targets jsonb not null default '{}'::jsonb,
  add column recording_disclosure boolean not null default false;
