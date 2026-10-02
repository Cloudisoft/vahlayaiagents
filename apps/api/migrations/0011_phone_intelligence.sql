-- Phone Intelligence: historical evidence -> per-number and NPA-NXX
-- intelligence -> calibrated confidence -> selective Twilio validation ->
-- write-back. The intelligence tables are shared knowledge (not per org);
-- budgets and lookups stay per organisation.

-- Every observation ever seen (historical files and Twilio), kept as
-- evidence. Nothing is overwritten; current state is derived from it.
create table if not exists phone_observations (
  id bigserial primary key,
  phone_e164 text not null,
  npa text,
  nxx text,
  line_type text not null,          -- mobile, landline, voip, unknown
  carrier text,                     -- normalised family, e.g. "Verizon Wireless"
  carrier_raw text,
  observed_at timestamptz not null,
  source text not null,             -- historical, twilio
  import_id uuid,
  unique (phone_e164, observed_at, source)
);
create index if not exists idx_phone_obs_phone on phone_observations(phone_e164);
create index if not exists idx_phone_obs_prefix on phone_observations(npa, nxx);

-- Current best knowledge per number, derived from its observations.
create table if not exists phone_intelligence (
  phone_e164 text primary key,
  npa text,
  nxx text,
  line_type text not null,
  carrier text,
  carrier_raw text,
  observed_at timestamptz not null,  -- newest observation
  source text not null,              -- historical, twilio
  verified boolean not null default false,
  observations int not null default 1,
  conflicts int not null default 0,  -- distinct known line types seen minus one
  twilio_validated_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_phone_intel_prefix on phone_intelligence(npa, nxx);

create table if not exists prefix_intelligence (
  npa text not null,
  nxx text not null,
  total_obs int not null default 0,       -- numbers with evidence in this prefix
  known_obs int not null default 0,
  mobile_n int not null default 0,
  landline_n int not null default 0,
  voip_n int not null default 0,
  unknown_n int not null default 0,
  w_mobile double precision not null default 0,   -- recency/verification weighted
  w_landline double precision not null default 0,
  w_voip double precision not null default 0,
  w_unknown double precision not null default 0,
  dominant_type text,
  dominant_share double precision,
  wilson_lower double precision,
  confidence double precision not null default 0, -- calibrated probability the dominant type is right
  trust text not null default 'uncertain',        -- trusted, probable, uncertain, drifting
  carrier_dist jsonb not null default '{}'::jsonb,
  top_carrier text,
  top_carrier_share double precision,
  conflicted_numbers int not null default 0,
  contradiction_rate double precision not null default 0,
  twilio_validations int not null default 0,
  twilio_agreements int not null default 0,
  twilio_contradictions int not null default 0,
  last_twilio_at timestamptz,
  first_seen timestamptz,
  last_seen timestamptz,
  updated_at timestamptz not null default now(),
  primary key (npa, nxx)
);
create index if not exists idx_prefix_trust on prefix_intelligence(trust);

create table if not exists carrier_statistics (
  carrier text primary key,
  total int not null default 0,
  mobile_n int not null default 0,
  landline_n int not null default 0,
  voip_n int not null default 0,
  unknown_n int not null default 0,
  dominant_type text,
  dominant_share double precision,
  confidence double precision not null default 0,
  updated_at timestamptz not null default now()
);

-- Ported numbers and carrier changes caught by validation.
create table if not exists portability_events (
  id bigserial primary key,
  phone_e164 text not null,
  npa text,
  nxx text,
  previous_type text,
  current_type text,
  previous_carrier text,
  current_carrier text,
  previous_observed_at timestamptz,
  kind text not null,               -- line_type_change, carrier_change
  detected_at timestamptz not null default now()
);
create index if not exists idx_portability_prefix on portability_events(npa, nxx, detected_at desc);

-- One row per imported file; the hash makes imports idempotent.
create table if not exists intel_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  sha256 text not null unique,
  status text not null default 'processing',  -- processing, completed, failed
  rows_total int not null default 0,
  rows_valid int not null default 0,
  rows_invalid int not null default 0,
  duplicates int not null default 0,
  phones int not null default 0,
  observed_from timestamptz,
  observed_to timestamptz,
  error text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- Daily Twilio budget with atomic reservations (shared by single, bulk
-- and background validation).
create table if not exists lookup_budget_days (
  organization_id uuid not null references organizations(id) on delete cascade,
  day date not null,
  spent_usd numeric(10,4) not null default 0,
  reserved_usd numeric(10,4) not null default 0,
  twilio_lookups int not null default 0,
  local_lookups int not null default 0,
  primary key (organization_id, day)
);
alter table coverage_budgets add column if not exists price_per_lookup_usd numeric(10,5) not null default 0.008;

-- Accuracy measurement. Holdout = offline backtest on historical data;
-- audit = random Twilio checks of confident local answers (unbiased);
-- correction = Twilio checks chosen because the answer was uncertain.
create table if not exists intel_quality_samples (
  id bigserial primary key,
  organization_id uuid references organizations(id) on delete cascade,
  phone_e164 text not null,
  kind text not null,               -- audit, correction
  predicted_type text,
  predicted_carrier text,
  predicted_source text,
  predicted_confidence double precision,
  actual_type text,
  actual_carrier text,
  correct boolean,
  created_at timestamptz not null default now()
);
create index if not exists idx_quality_kind_time on intel_quality_samples(kind, created_at desc);

create table if not exists intel_quality_runs (
  id bigserial primary key,
  kind text not null,               -- holdout
  evaluated int not null,
  correct int not null,
  coverage double precision,
  by_type jsonb not null default '{}'::jsonb,
  by_bucket jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Empirical accuracy per (signal, confidence bucket) from the holdout, so
-- reported confidence is a measured probability, not a raw score.
create table if not exists intel_calibration (
  signal text not null,
  bucket int not null,              -- floor(raw score * 10)
  n int not null,
  correct int not null,
  primary key (signal, bucket)
);

create table if not exists coverage_bulk_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  file_name text,
  status text not null default 'queued',  -- queued, processing, completed, failed
  phones text[] not null,
  total int not null default 0,
  processed int not null default 0,
  summary jsonb not null default '{}'::jsonb,
  error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_bulk_jobs_status on coverage_bulk_jobs(status, created_at);

create table if not exists coverage_bulk_results (
  job_id uuid not null references coverage_bulk_jobs(id) on delete cascade,
  idx int not null,
  phone_original text,
  phone_e164 text,
  line_type text,
  carrier text,
  confidence double precision,
  source text,
  verified boolean not null default false,
  twilio_used boolean not null default false,
  error text,
  primary key (job_id, idx)
);

alter table coverage_lookups
  add column if not exists line_type text,
  add column if not exists source text,
  add column if not exists twilio_used boolean not null default false;

alter table phone_observations enable row level security;
alter table phone_intelligence enable row level security;
alter table prefix_intelligence enable row level security;
alter table carrier_statistics enable row level security;
alter table portability_events enable row level security;
alter table intel_imports enable row level security;
alter table lookup_budget_days enable row level security;
alter table intel_quality_samples enable row level security;
alter table intel_quality_runs enable row level security;
alter table intel_calibration enable row level security;
alter table coverage_bulk_jobs enable row level security;
alter table coverage_bulk_results enable row level security;
