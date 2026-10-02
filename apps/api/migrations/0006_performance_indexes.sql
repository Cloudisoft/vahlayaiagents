-- Indexes for the Voice AI dashboard, analytics, call records, leads and
-- callbacks pages (all filter by org/campaign/lead and sort by recency).
create index if not exists idx_calls_campaign_created on calls(campaign_id, created_at desc);
create index if not exists idx_calls_lead_created on calls(lead_id, created_at desc);
create index if not exists idx_calls_disposition on calls(disposition_id);
create index if not exists idx_calls_phone_number on calls(phone_number_id);
create index if not exists idx_campaign_leads_lead on campaign_leads(lead_id);
create index if not exists idx_campaign_leads_callbacks on campaign_leads(campaign_id, last_disposition, status, next_attempt_at);
create index if not exists idx_leads_org_last_called on leads(organization_id, last_called_at desc nulls last, created_at desc);
create index if not exists idx_call_transfers_call on call_transfers(call_id);
create index if not exists idx_campaign_versions_campaign on campaign_versions(campaign_id, version desc);
