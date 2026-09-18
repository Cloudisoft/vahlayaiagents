-- Adds username-based login and per-user module access control (Admin Panel).

alter table users add column username text;
create unique index idx_users_org_username on users(organization_id, username) where username is not null;

create table modules (
  key text primary key,
  name text not null,
  description text
);

insert into modules (key, name, description) values
  ('hr', 'VahlaySmartHR', 'AI-Driven Hiring & Workforce Intelligence'),
  ('coverage', 'Vahlay Coverage Intelligence', 'Real-Time Phone Number Coverage & Compliance Intelligence'),
  ('leadgen', 'Vahlay Lead Discovery', 'B2B Business Discovery & Enrichment'),
  ('voice_agents', 'Vahlay AI Agents', 'Unified Voice Agent Platform'),
  ('call_auditor', 'Vahlay QCs', 'AI Call Quality & Compliance Analyst');

create table user_module_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  module_key text not null references modules(key) on delete cascade,
  enabled boolean not null default true,
  granted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, module_key)
);
create index idx_user_module_access_user on user_module_access(user_id);
