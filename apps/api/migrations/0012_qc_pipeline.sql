-- QC Auditor pipeline: explicit state machine, durations, complete
-- persisted transcript with coverage, full report, PDF and retries.
alter table call_audits
  add column if not exists status text not null default 'UPLOADED',
  add column if not exists status_message text,       -- user-facing
  add column if not exists error_technical text,      -- server-side detail
  add column if not exists failed_stage text,
  add column if not exists attempts int not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists batch_id uuid,
  add column if not exists agent_name text,
  add column if not exists business_name text,
  add column if not exists original_file_name text,
  add column if not exists original_mime text,
  add column if not exists original_size_bytes bigint,
  add column if not exists audio_info jsonb,          -- ffprobe summary
  add column if not exists original_duration_sec double precision,
  add column if not exists converted_duration_sec double precision,
  add column if not exists audible_end_sec double precision,
  add column if not exists transcript jsonb,          -- [{start,end,speaker,role,text}]
  add column if not exists transcript_text text,
  add column if not exists transcript_end_sec double precision,
  add column if not exists transcript_coverage double precision,
  add column if not exists transcript_model text,
  add column if not exists report jsonb,              -- full QC report
  add column if not exists pass boolean,
  add column if not exists needs_review boolean,
  add column if not exists pdf_file_id uuid references files(id) on delete set null,
  add column if not exists stage_log jsonb not null default '[]'::jsonb;

create index if not exists idx_call_audits_queue on call_audits(status, created_at)
  where status in ('UPLOADED', 'VALIDATING', 'CONVERTING', 'TRANSCRIBING', 'VALIDATING_TRANSCRIPT', 'ANALYZING', 'SAVING_REPORT');
create index if not exists idx_call_audits_transcript_fts on call_audits using gin (to_tsvector('english', coalesce(transcript_text, '')));

-- Existing rows keep their history but are marked by their old state.
update call_audits set status = case processing_status
    when 'completed' then 'READY' when 'failed' then 'ANALYSIS_FAILED' else 'UPLOADED' end
  where status = 'UPLOADED' and processing_status <> 'pending';

-- Custom QC rules checked on every call (PASS / FAIL / PARTIAL with evidence).
create table if not exists audit_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  rule text not null,
  mandatory boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_rules_org on audit_rules(organization_id);
alter table audit_rules enable row level security;
