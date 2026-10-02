-- Vahlay Lead Discovery: target → discover (many sources) → raw → normalize
-- → enrich → validate → AI qualify → score → export / CRM.

-- A discovery run: what the user is looking for and how it is going.
create table if not exists discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  name text not null,
  criteria jsonb not null,                       -- industry, keywords, locations, must-haves, opportunities, ideal customer…
  sources text[] not null,
  max_results int not null default 300,
  lead_list_id uuid references lead_lists(id) on delete set null,
  status text not null default 'queued',          -- queued, running, enriching, completed, partial, failed, cancelled
  counts jsonb not null default '{}'::jsonb,      -- found, new, merged, enriched, qualified, errors…
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_discovery_jobs_org on discovery_jobs(organization_id, created_at desc);

-- One request to one source (a location × query, or one result page).
-- Tasks fail and retry independently, so one bad request never sinks a job.
create table if not exists discovery_tasks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references discovery_jobs(id) on delete cascade,
  source text not null,
  query jsonb not null,
  page int not null default 1,
  page_token text,
  status text not null default 'queued',          -- queued, running, done, failed, skipped
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  found int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists idx_discovery_tasks_queue on discovery_tasks(status, next_attempt_at) where status in ('queued','running');
create index if not exists idx_discovery_tasks_job on discovery_tasks(job_id);

-- Every record exactly as a source returned it (the RAW layer).
create table if not exists lead_source_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  job_id uuid references discovery_jobs(id) on delete set null,
  source text not null,
  source_ref text not null,                       -- the source's own id (place id, osm node/way id)
  source_url text,
  raw jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (organization_id, source, source_ref)
);
create index if not exists idx_lead_source_records_lead on lead_source_records(lead_id);

-- Which leads each job found (new or matched to an existing lead).
create table if not exists discovery_job_leads (
  job_id uuid not null references discovery_jobs(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  was_new boolean not null,
  created_at timestamptz not null default now(),
  primary key (job_id, lead_id)
);
create index if not exists idx_discovery_job_leads_lead on discovery_job_leads(lead_id);

alter table leads
  add column if not exists description text,
  add column if not exists country text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists name_key text,                     -- normalized name for de-duplication
  add column if not exists website_domain text,
  add column if not exists field_meta jsonb not null default '{}'::jsonb,   -- per field: source, at, validation
  add column if not exists pipeline_status text,              -- discovered, enriching, enriched, qualifying, qualified, enrich_failed, qualify_failed
  add column if not exists pipeline_error text,
  add column if not exists pipeline_attempts int not null default 0,
  add column if not exists pipeline_locked_at timestamptz,
  add column if not exists pipeline_next_at timestamptz,
  add column if not exists enrichment jsonb,                  -- website signals and what was found where
  add column if not exists enriched_at timestamptz,
  add column if not exists validation jsonb,                  -- per field verdicts
  add column if not exists website_status text,               -- none, unreachable, weak, ok
  add column if not exists completeness int,
  add column if not exists lead_score int,
  add column if not exists fit_score int,
  add column if not exists qualification jsonb,               -- scores, opportunities, summary, reasons
  add column if not exists qualification_status text,         -- qualified, needs_review, disqualified
  add column if not exists qualified_at timestamptz,
  add column if not exists qualified_for_job uuid,
  add column if not exists primary_opportunity text,
  add column if not exists opportunities text[] not null default '{}',
  add column if not exists sources text[] not null default '{}',
  add column if not exists first_discovered_at timestamptz,
  add column if not exists last_discovered_at timestamptz,
  add column if not exists notes_count int not null default 0;

create index if not exists idx_leads_name_key on leads(organization_id, name_key);
create index if not exists idx_leads_domain on leads(organization_id, website_domain);
create index if not exists idx_leads_pipeline on leads(pipeline_status, pipeline_next_at) where pipeline_status in ('discovered','enriched','enriching','qualifying');
create index if not exists idx_leads_score on leads(organization_id, lead_score desc nulls last);

create table if not exists lead_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_notes_lead on lead_notes(lead_id, created_at desc);

-- Every hand-off of leads to a file, campaign or CRM.
create table if not exists lead_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  destination text not null,                      -- csv, xlsx, crm_webhook, voice_campaign
  target text,
  lead_count int not null default 0,
  status text not null default 'done',            -- done, failed
  error text,
  created_at timestamptz not null default now()
);

alter table discovery_jobs enable row level security;
alter table discovery_tasks enable row level security;
alter table lead_source_records enable row level security;
alter table discovery_job_leads enable row level security;
alter table lead_notes enable row level security;
alter table lead_exports enable row level security;
