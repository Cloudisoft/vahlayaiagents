-- Agents mirror to a VAPI assistant and pick any model VAPI offers.
alter table ai_agents
  add column if not exists llm_provider text not null default 'openai',
  add column if not exists vapi_synced_at timestamptz,
  add column if not exists vapi_sync_error text;

-- Inbound: a number answers with its campaign's agent once enabled.
alter table phone_numbers
  add column if not exists inbound_enabled boolean not null default false,
  add column if not exists friendly_name text;

-- Cloned / imported voices belong to the organisation that made them;
-- catalog voices stay shared (organization_id null).
alter table voices
  add column if not exists organization_id uuid references organizations(id) on delete cascade,
  add column if not exists is_cloned boolean not null default false,
  add column if not exists hidden boolean not null default false,
  add column if not exists gender text,
  add column if not exists description text;
create index if not exists idx_voices_org on voices(organization_id);

-- AI coaching review of each conversation.
alter table calls
  add column if not exists ai_review jsonb,
  add column if not exists ai_review_at timestamptz,
  add column if not exists ai_review_error text;
create index if not exists idx_calls_review_pending on calls(created_at desc)
  where ai_review is null and talk_seconds >= 15;

alter table call_recordings
  add column if not exists channels int,
  add column if not exists source text;

update phone_numbers set inbound_enabled = true where inbound_route->>'mode' = 'campaign_agent';
