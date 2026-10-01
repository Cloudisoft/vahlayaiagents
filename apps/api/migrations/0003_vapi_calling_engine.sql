-- Vahlay Voice AI on VAPI (Twilio numbers + Cartesia voices): call engine,
-- dialer safeguards, campaign versions / number pools, B2B telecom leads.

-- Leads: person + business fields for AT&T / Spectrum Business campaigns.
alter table leads
  add column first_name text,
  add column last_name text,
  add column contact_title text,
  add column service_address text,
  add column current_provider text,
  add column customer_type text,            -- alc (already Spectrum) | non_alc
  add column lines_count int,
  add column locations_count int,
  add column contract_end_date date,
  add column time_zone text,                -- IANA, used for lead-local calling windows
  add column custom_fields jsonb not null default '{}'::jsonb,
  add column call_status text not null default 'new',
  add column attempts int not null default 0,
  add column last_called_at timestamptz,
  add column is_dnc boolean not null default false;
create index idx_leads_phone on leads(organization_id, main_phone_e164);
create index idx_leads_call_status on leads(organization_id, call_status);

-- Campaign settings from the playbook.
alter table campaigns
  add column intro_name text,
  add column callback_number text,
  add column script text,
  add column knowledge_text text,
  add column voicemail_enabled boolean not null default true,
  add column voicemail_script text,
  add column retry_on_voicemail boolean not null default true,
  add column retry_delay_minutes int not null default 60,
  add column lead_cooldown_hours int not null default 24,
  add column dial_timeout_seconds int not null default 80,
  add column llm_model text not null default 'gpt-4o-mini',
  add column published_version_id uuid,
  add column published_at timestamptz,
  add column has_unpublished_changes boolean not null default true,
  add column breaker_error_count int not null default 0,
  add column breaker_last_error text,
  add column paused_reason text,
  add column scheduled_start_at timestamptz;

create table campaign_versions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  agent_updated_at timestamptz,
  published_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (campaign_id, version)
);
alter table campaigns add constraint fk_campaigns_published_version
  foreign key (published_version_id) references campaign_versions(id) on delete set null;

-- Number pool: a campaign dials from several numbers, rotating.
create table campaign_phone_numbers (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  phone_number_id uuid not null references phone_numbers(id) on delete cascade,
  last_used_at timestamptz,
  primary key (campaign_id, phone_number_id)
);

alter table phone_numbers
  add column vapi_phone_number_id text,
  add column area_code text;

alter table ai_agents
  add column vapi_assistant_id text,
  add column llm_model text,
  add column temperature numeric not null default 0.4,
  add column fallback_behavior text;

alter table campaign_leads
  add column next_attempt_at timestamptz,
  add column last_disposition text;
create index idx_campaign_leads_dialable on campaign_leads(campaign_id, status, next_attempt_at);

-- Calls: everything the disposition engine and CDR need.
alter table calls
  add column vapi_call_id text,
  add column provider_call_sid text,
  add column campaign_version_id uuid references campaign_versions(id) on delete set null,
  add column ended_reason text,
  add column answered boolean not null default false,
  add column customer_spoke boolean not null default false,
  add column voicemail_detected boolean not null default false,
  add column voicemail_method text,
  add column transfer_status text,
  add column dnc_requested boolean not null default false,
  add column ai_outcome text,
  add column callback_at timestamptz,
  add column disposition_source text not null default 'engine',
  add column talk_seconds int,
  add column summary text,
  add column evaluation_score int,
  add column evaluation jsonb,
  add column events jsonb not null default '[]'::jsonb,
  add column monitor_listen_url text,
  add column monitor_control_url text,
  add column last_signal_at timestamptz,
  add column error text;
create unique index idx_calls_vapi_call_id on calls(vapi_call_id) where vapi_call_id is not null;
create index idx_calls_org_created on calls(organization_id, created_at desc);
create index idx_calls_inflight on calls(status) where status in ('queued','ringing','answered');

create index idx_call_transcripts_fts on call_transcripts using gin (to_tsvector('english', coalesce(full_text, '')));

alter table call_dispositions
  add column color text not null default 'slate',
  add column retryable boolean not null default false;

-- One dialer at a time, even across deploys.
create table worker_leases (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null
);
