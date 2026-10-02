-- Vahlay HR: job → posting → screening → outreach → scheduling → AI voice
-- interview → evaluation → HR decision → communication, all linked to one
-- application with a full timeline and audit of AI decisions/overrides.

alter table jobs
  add column if not exists department text,
  add column if not exists salary_currency text not null default 'USD',
  add column if not exists requirements text,
  add column if not exists posting jsonb,                 -- generated posting package
  add column if not exists scoring_criteria jsonb not null default '{}'::jsonb,
  add column if not exists interview_settings jsonb not null default '{}'::jsonb,
  add column if not exists good_fit_threshold int not null default 75,
  add column if not exists review_fit_threshold int not null default 55,
  add column if not exists published_at timestamptz;

alter table applications
  add column if not exists stage text not null default 'APPLIED',
  add column if not exists processing_status text not null default 'QUEUED', -- QUEUED, PARSING, SCORING, DONE, PARSE_FAILED, AI_FAILED
  add column if not exists processing_error text,
  add column if not exists processing_detail text,
  add column if not exists attempts int not null default 0,
  add column if not exists locked_at timestamptz,
  add column if not exists ai_fit text,                  -- GOOD_FIT, REVIEW, NOT_A_FIT
  add column if not exists hr_fit text,                  -- HR override of ai_fit
  add column if not exists hr_fit_reason text,
  add column if not exists source text not null default 'upload',
  add column if not exists batch_id uuid,
  add column if not exists stage_changed_at timestamptz not null default now();
create index if not exists idx_applications_stage on applications(job_id, stage);
create index if not exists idx_applications_queue on applications(processing_status, created_at)
  where processing_status in ('QUEUED', 'PARSING', 'SCORING');

-- Existing applications keep their meaning.
update applications set stage = case status
    when 'rejected' then 'REJECTED' when 'hired' then 'HIRED' when 'interviewing' then 'AI_INTERVIEW'
    when 'qualified' then 'SHORTLISTED' when 'hr_review' then 'SCREENING' else 'APPLIED' end,
  processing_status = case when status in ('submitted', 'processing') then 'QUEUED' else 'DONE' end
where stage = 'APPLIED' and status <> 'submitted';

alter table resumes
  add column if not exists text_content text,
  add column if not exists parse_error text;

alter table candidate_scores
  add column if not exists fit text,
  add column if not exists summary text,
  add column if not exists requirement_gaps jsonb not null default '[]'::jsonb,
  add column if not exists evidence jsonb not null default '{}'::jsonb,
  add column if not exists criteria_scores jsonb not null default '[]'::jsonb,
  add column if not exists evidence_stats jsonb;

-- Every message to a candidate: drafted, approved by HR, sent, tracked.
create table if not exists candidate_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  channel text not null,                    -- email, sms
  kind text not null,                       -- invite, confirmation, reminder, next_round, info_request, rejection, custom
  to_address text not null,
  subject text,
  body text not null,
  status text not null default 'draft',     -- draft, queued, sent, delivered, opened, replied, failed
  provider text,
  provider_message_id text,
  error text,
  attempts int not null default 0,
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  replied_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_candidate_messages_app on candidate_messages(application_id, created_at desc);
create index if not exists idx_candidate_messages_queue on candidate_messages(status, created_at) where status = 'queued';
create index if not exists idx_candidate_messages_provider on candidate_messages(provider_message_id);

-- The single timeline per application.
create table if not exists candidate_activity (
  id bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  kind text not null,
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_candidate_activity_app on candidate_activity(application_id, created_at desc);

-- Interviews (VAPI voice). Reuses interview_sessions with scheduling,
-- call, transcript and evaluation fields.
alter table interview_sessions
  add column if not exists schedule_token text unique,
  add column if not exists scheduling_status text not null default 'not_invited', -- not_invited, invited, scheduled, cancelled
  add column if not exists scheduled_at timestamptz,
  add column if not exists time_zone text,
  add column if not exists reminder_24h_at timestamptz,
  add column if not exists reminder_1h_at timestamptz,
  add column if not exists call_status text not null default 'pending',  -- pending, calling, in_progress, completed, incomplete, failed, no_answer
  add column if not exists vapi_call_id text,
  add column if not exists ended_reason text,
  add column if not exists transcript_segments jsonb,
  add column if not exists recording_url text,
  add column if not exists evaluation jsonb,
  add column if not exists ai_recommendation text,      -- NEXT_ROUND, HOLD, DO_NOT_ADVANCE
  add column if not exists hr_recommendation text,
  add column if not exists hr_recommendation_reason text,
  add column if not exists completeness jsonb,
  add column if not exists error text,
  add column if not exists locked_at timestamptz,
  add column if not exists call_attempts int not null default 0;
create unique index if not exists idx_interview_vapi_call on interview_sessions(vapi_call_id) where vapi_call_id is not null;
create index if not exists idx_interview_due on interview_sessions(scheduled_at) where scheduling_status = 'scheduled' and call_status = 'pending';

alter table candidate_messages enable row level security;
alter table candidate_activity enable row level security;

-- Bulk uploads may not contain an email or a name; never invent one.
alter table candidates alter column email drop not null;
alter table candidates alter column first_name set default '';
alter table candidates alter column last_name set default '';
alter table resumes add column if not exists file_name text;
alter table candidate_messages add column if not exists open_token text unique;
alter table candidate_messages add column if not exists next_attempt_at timestamptz;
