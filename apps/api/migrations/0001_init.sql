-- Vahlay AI — Phase 1 schema
-- Covers spec §3 (global tables). Business-logic tables for Coverage/LeadGen/
-- Voice AI/Auditor are created here (structure) but populated by later phases.

create extension if not exists "pgcrypto";

-- ============================================================
-- CORE: organizations, users, roles, sessions
-- ============================================================

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique, -- super_admin, company_admin, hr, recruiter, agent_manager, user
  name text not null,
  description text
);

insert into roles (key, name, description) values
  ('super_admin', 'Super Admin', 'Full platform access across all organizations'),
  ('company_admin', 'Company Admin', 'Full access within their organization'),
  ('hr', 'HR', 'Manages jobs, candidates, interviews'),
  ('recruiter', 'Recruiter', 'Manages candidates and applications'),
  ('agent_manager', 'Agent Manager', 'Manages Voice AI agents and campaigns'),
  ('user', 'User', 'Basic authenticated access');

create table users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  email text not null,
  password_hash text not null,
  first_name text,
  last_name text,
  role_id uuid not null references roles(id),
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);
create index idx_users_org on users(organization_id);
create index idx_users_email on users(email);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  refresh_token_hash text not null,
  user_agent text,
  ip_address text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_sessions_user on sessions(user_id);
create index idx_sessions_expires on sessions(expires_at);

create table password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_password_resets_user on password_resets(user_id);

-- ============================================================
-- FILES (shared object storage metadata)
-- ============================================================

create table files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  owner_id uuid references users(id) on delete set null,
  file_path text not null,
  file_name text not null,
  file_type text not null,
  mime_type text,
  file_size bigint not null default 0,
  processing_status text not null default 'uploaded', -- uploaded, processing, completed, failed
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_files_org on files(organization_id);
create index idx_files_owner on files(owner_id);

-- ============================================================
-- SHARED: contacts, leads (cross-module), notifications, logs
-- ============================================================

create table contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  first_name text,
  last_name text,
  email text,
  phone text,
  company text,
  source_module text, -- hr, coverage, leadgen, voice
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_contacts_org on contacts(organization_id);
create index idx_contacts_phone on contacts(phone);
create index idx_contacts_email on contacts(email);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_notifications_org on notifications(organization_id);
create index idx_notifications_user on notifications(user_id, read_at);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_logs_org on audit_logs(organization_id);
create index idx_audit_logs_entity on audit_logs(entity_type, entity_id);

create table system_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete set null,
  level text not null default 'info', -- info, warn, error
  source text not null, -- e.g. 'plivo.webhook', 'resume.parser'
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_system_logs_org on system_logs(organization_id);
create index idx_system_logs_source on system_logs(source);

create table usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  category text not null, -- openai, vapi, twilio, plivo, cartesia, storage, coverage_verification, lead_enrichment
  units numeric not null default 0,
  cost_usd numeric(12,4) not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_usage_org_category on usage(organization_id, category, created_at);

create table api_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null, -- openai, vapi, twilio, plivo, exotel, cartesia, google_places, smtp, resend, storage
  encrypted_value text not null,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);
create index idx_api_credentials_org on api_credentials(organization_id);

create table background_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) on delete cascade,
  queue_name text not null,
  job_type text not null,
  status text not null default 'queued', -- queued, processing, completed, failed
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index idx_background_jobs_org on background_jobs(organization_id);
create index idx_background_jobs_status on background_jobs(status, queue_name);

-- ============================================================
-- VAHLAYHR
-- ============================================================

create table jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  title text not null,
  description text,
  responsibilities text,
  required_skills text[] not null default '{}',
  preferred_skills text[] not null default '{}',
  min_experience_years numeric,
  education text,
  certifications text[] not null default '{}',
  salary_min numeric,
  salary_max numeric,
  location text,
  employment_type text, -- full_time, part_time, contract
  screening_questions jsonb not null default '[]'::jsonb,
  ai_criteria jsonb not null default '{}'::jsonb, -- AI-generated structured requirements, editable
  status text not null default 'draft', -- draft, published, unpublished, archived
  public_slug text unique,
  score_reject_threshold int not null default 49,
  score_review_threshold int not null default 64,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_jobs_org on jobs(organization_id, status);
create index idx_jobs_slug on jobs(public_slug);

create table candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  phone_normalized text,
  location text,
  current_company text,
  years_experience numeric,
  current_salary numeric,
  expected_salary numeric,
  notice_period text,
  work_authorization text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_candidates_org on candidates(organization_id);
create index idx_candidates_email on candidates(email);
create index idx_candidates_phone on candidates(phone_normalized);

create table resumes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  parsed_data jsonb, -- extracted skills, companies, titles, education, etc.
  parsing_status text not null default 'pending', -- pending, processing, completed, failed
  created_at timestamptz not null default now()
);
create index idx_resumes_candidate on resumes(candidate_id);

create table applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  resume_id uuid references resumes(id) on delete set null,
  cover_letter text,
  answers jsonb not null default '{}'::jsonb, -- job-specific screening question answers
  status text not null default 'submitted', -- submitted, processing, reviewed, qualified, hr_review, rejected, interviewing, hired
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, candidate_id)
);
create index idx_applications_org on applications(organization_id, status);
create index idx_applications_job on applications(job_id);

create table candidate_scores (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  overall_score int not null,
  skill_match int,
  experience_match int,
  education_match int,
  industry_match int,
  responsibility_match int,
  salary_compatibility int,
  missing_requirements text[] not null default '{}',
  strengths text[] not null default '{}',
  concerns text[] not null default '{}',
  explanation text,
  decision text not null, -- reject, hr_review, qualified
  model text,
  created_at timestamptz not null default now()
);
create index idx_candidate_scores_application on candidate_scores(application_id);

create table rejection_emails (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  template_used text,
  subject text,
  body text,
  status text not null default 'pending', -- pending, sent, failed
  provider_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (application_id)
);

create table interview_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  interview_type text not null default 'initial_screening',
  ai_behavior text not null default 'professional',
  telephony_provider text not null default 'plivo',
  provider_call_id text,
  phone_number text,
  phone_normalized text,
  status text not null default 'pending', -- pending, calling, in_progress, completed, failed, no_answer
  attempt_number int not null default 1,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,
  recording_file_id uuid references files(id) on delete set null,
  transcript text,
  summary text,
  overall_score int,
  communication_score int,
  technical_score int,
  red_flags text[] not null default '{}',
  recommended_action text,
  processing_status text not null default 'pending',
  created_at timestamptz not null default now()
);
create index idx_interview_sessions_org on interview_sessions(organization_id);
create index idx_interview_sessions_application on interview_sessions(application_id);

create table interview_questions (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  question text not null,
  expected_answer_criteria text,
  follow_up_instructions text,
  is_required boolean not null default true,
  order_index int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_interview_questions_job on interview_questions(job_id, order_index);

create table interview_answers (
  id uuid primary key default gen_random_uuid(),
  interview_session_id uuid not null references interview_sessions(id) on delete cascade,
  interview_question_id uuid references interview_questions(id) on delete set null,
  question_text text not null,
  answer_text text,
  relevance_score int,
  analysis text,
  order_index int not null default 0,
  created_at timestamptz not null default now()
);
create index idx_interview_answers_session on interview_answers(interview_session_id);

-- ============================================================
-- VAHLAY COVERAGE
-- ============================================================

create table carrier_records (
  id uuid primary key default gen_random_uuid(),
  npa text not null,
  nxx text not null,
  carrier text,
  rate_center text,
  state text,
  city text,
  line_type text, -- mobile, landline, voip
  source text not null, -- internal, twilio, imported
  confidence numeric not null default 0, -- 0..1
  verification_status text not null default 'unverified', -- unverified, predicted, verified
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (npa, nxx)
);
create index idx_carrier_records_npa_nxx on carrier_records(npa, nxx);

create table coverage_lookups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  requested_by uuid references users(id) on delete set null,
  phone_original text not null,
  phone_e164 text not null,
  npa text,
  nxx text,
  predicted_carrier text,
  confidence numeric,
  used_cache boolean not null default false,
  verification_id uuid,
  created_at timestamptz not null default now()
);
create index idx_coverage_lookups_org on coverage_lookups(organization_id);
create index idx_coverage_lookups_phone on coverage_lookups(phone_e164);

create table coverage_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  phone_e164 text not null,
  provider text not null default 'twilio',
  provider_carrier text,
  provider_line_type text,
  raw_response jsonb,
  cost_usd numeric(10,4) not null default 0,
  status text not null default 'completed', -- completed, failed
  error text,
  created_at timestamptz not null default now()
);
create index idx_coverage_verifications_org on coverage_verifications(organization_id);
create index idx_coverage_verifications_phone on coverage_verifications(phone_e164);

alter table coverage_lookups
  add constraint fk_coverage_lookups_verification
  foreign key (verification_id) references coverage_verifications(id) on delete set null;

create table coverage_accuracy_stats (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  total_predictions bigint not null default 0,
  verified_predictions bigint not null default 0,
  correct_predictions bigint not null default 0,
  incorrect_predictions bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

create table coverage_budgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  budget_usd numeric(10,2) not null default 7.00,
  spent_usd numeric(10,4) not null default 0,
  period_start timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id)
);

-- ============================================================
-- VAHLAY LEADGEN
-- ============================================================

create table lead_sources (
  id uuid primary key default gen_random_uuid(),
  key text not null unique, -- google_places, search_api, user_upload, licensed_provider
  name text not null,
  is_enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb
);

create table lead_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_lead_lists_org on lead_lists(organization_id);

create table leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  lead_list_id uuid references lead_lists(id) on delete set null,
  business_name text not null,
  owner_name text,
  decision_maker_name text,
  address text,
  city text,
  state text,
  zip text,
  website text,
  main_phone text,
  main_phone_e164 text,
  alt_phone text,
  business_email text,
  decision_maker_email text,
  industry text,
  category text,
  company_size text,
  social_urls text[] not null default '{}',
  source text,
  source_url text,
  data_confidence numeric,
  quality_score int,
  tags text[] not null default '{}',
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_leads_org on leads(organization_id);
create index idx_leads_list on leads(lead_list_id);
create index idx_leads_state_industry on leads(state, industry);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'draft', -- draft, active, paused, completed
  ai_agent_id uuid,
  voice_id uuid,
  phone_number_id uuid,
  lead_list_id uuid references lead_lists(id) on delete set null,
  sop_document_id uuid,
  script_id uuid,
  transfer_number text,
  transfer_conditions jsonb not null default '{}'::jsonb,
  concurrency int not null default 1,
  retry_count int not null default 0,
  max_attempts int not null default 3,
  calling_hours jsonb not null default '{}'::jsonb,
  time_zone text not null default 'America/New_York',
  max_call_duration_seconds int not null default 600,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_campaigns_org on campaigns(organization_id, status);

create table campaign_leads (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  status text not null default 'queued', -- queued, calling, called, failed, dnc_skipped
  attempts int not null default 0,
  last_call_id uuid,
  created_at timestamptz not null default now(),
  unique (campaign_id, lead_id)
);
create index idx_campaign_leads_campaign on campaign_leads(campaign_id, status);

-- ============================================================
-- VAHLAY VOICE AI
-- ============================================================

create table ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  agent_type text not null default 'custom', -- sales, support, front_desk, appointment_setter, lead_qualification, recruitment_interviewer, follow_up, custom
  purpose text,
  system_prompt text,
  personality text,
  tone text not null default 'professional',
  sop_document_id uuid,
  script_id uuid,
  knowledge_file_ids uuid[] not null default '{}',
  faqs jsonb not null default '[]'::jsonb,
  objection_handling jsonb not null default '[]'::jsonb,
  transfer_rules jsonb not null default '{}'::jsonb,
  working_hours jsonb not null default '{}'::jsonb,
  max_call_duration_seconds int not null default 600,
  voice_id uuid,
  language text not null default 'en-US',
  greeting text,
  ending_behavior text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_ai_agents_org on ai_agents(organization_id);

create table voices (
  id uuid primary key default gen_random_uuid(),
  provider text not null, -- cartesia, vapi
  provider_voice_id text not null,
  name text not null,
  language text,
  accent text,
  style text,
  preview_url text,
  created_at timestamptz not null default now(),
  unique (provider, provider_voice_id)
);

create table phone_numbers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  provider text not null, -- twilio, plivo, exotel
  provider_number_id text,
  phone_e164 text not null,
  country text,
  status text not null default 'active',
  assigned_agent_id uuid references ai_agents(id) on delete set null,
  assigned_campaign_id uuid references campaigns(id) on delete set null,
  inbound_route jsonb not null default '{}'::jsonb,
  outbound_route jsonb not null default '{}'::jsonb,
  transfer_number text,
  created_at timestamptz not null default now(),
  unique (organization_id, phone_e164)
);
create index idx_phone_numbers_org on phone_numbers(organization_id);

create table call_routes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  phone_number_id uuid not null references phone_numbers(id) on delete cascade,
  direction text not null, -- inbound, outbound
  target_agent_id uuid references ai_agents(id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  agent_id uuid references ai_agents(id) on delete set null,
  voice_id uuid references voices(id) on delete set null,
  phone_number_id uuid references phone_numbers(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  candidate_id uuid references candidates(id) on delete set null, -- shared infra with VahlayHR interviews
  telephony_provider text not null,
  provider_call_id text,
  direction text not null default 'outbound',
  to_number text,
  from_number text,
  status text not null default 'queued', -- queued, ringing, answered, completed, failed, no_answer, voicemail
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,
  cost_usd numeric(10,4) default 0,
  created_at timestamptz not null default now()
);
create index idx_calls_org on calls(organization_id, status);
create index idx_calls_campaign on calls(campaign_id);
create index idx_calls_provider_call_id on calls(provider_call_id);

create table call_transcripts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  full_text text,
  turns jsonb not null default '[]'::jsonb, -- [{speaker, text, ts}]
  summary text,
  created_at timestamptz not null default now(),
  unique (call_id)
);

create table call_recordings (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  file_id uuid references files(id) on delete set null,
  provider_recording_url text,
  duration_seconds int,
  processing_status text not null default 'pending',
  created_at timestamptz not null default now(),
  unique (call_id)
);

create table call_dispositions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  key text not null,
  label text not null,
  is_custom boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);

create table call_transfers (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  transfer_to text not null,
  reason text,
  status text not null default 'initiated', -- initiated, completed, failed
  created_at timestamptz not null default now()
);

-- calls.disposition_id added after call_dispositions exists
alter table calls add column disposition_id uuid references call_dispositions(id) on delete set null;
alter table calls add column ai_analysis jsonb;

-- ============================================================
-- AI CALL AUDITOR
-- ============================================================

create table audit_criteria (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  weight numeric not null default 1,
  passing_score int not null default 70,
  is_required boolean not null default true,
  ai_evaluation_instructions text,
  created_at timestamptz not null default now()
);
create index idx_audit_criteria_org on audit_criteria(organization_id);

create table call_audits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  call_id uuid references calls(id) on delete set null,
  source_file_id uuid references files(id) on delete set null, -- for uploaded recordings not tied to a call
  overall_score int,
  criterion_scores jsonb not null default '[]'::jsonb,
  strengths text[] not null default '{}',
  improvements text[] not null default '{}',
  missed_opportunities text[] not null default '{}',
  key_moments jsonb not null default '[]'::jsonb,
  script_deviations text[] not null default '{}',
  coaching_notes text,
  processing_status text not null default 'pending', -- pending, transcribing, analyzing, completed, failed
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_call_audits_org on call_audits(organization_id, processing_status);

-- ============================================================
-- SOP / SCRIPTS (shared by HR interviews + Voice AI agents)
-- ============================================================

create table sop_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  file_id uuid references files(id) on delete set null,
  content text,
  created_at timestamptz not null default now()
);

create table scripts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  content text,
  created_at timestamptz not null default now()
);

-- foreign keys deferred until referenced tables exist
alter table campaigns add constraint fk_campaigns_agent foreign key (ai_agent_id) references ai_agents(id) on delete set null;
alter table campaigns add constraint fk_campaigns_voice foreign key (voice_id) references voices(id) on delete set null;
alter table campaigns add constraint fk_campaigns_phone foreign key (phone_number_id) references phone_numbers(id) on delete set null;
alter table campaigns add constraint fk_campaigns_sop foreign key (sop_document_id) references sop_documents(id) on delete set null;
alter table campaigns add constraint fk_campaigns_script foreign key (script_id) references scripts(id) on delete set null;
alter table ai_agents add constraint fk_ai_agents_voice foreign key (voice_id) references voices(id) on delete set null;
alter table ai_agents add constraint fk_ai_agents_sop foreign key (sop_document_id) references sop_documents(id) on delete set null;
alter table ai_agents add constraint fk_ai_agents_script foreign key (script_id) references scripts(id) on delete set null;
alter table campaign_leads add constraint fk_campaign_leads_last_call foreign key (last_call_id) references calls(id) on delete set null;

-- Do Not Call / suppression (compliance, §50)
create table dnc_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  phone_e164 text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (organization_id, phone_e164)
);
create index idx_dnc_org on dnc_entries(organization_id);
