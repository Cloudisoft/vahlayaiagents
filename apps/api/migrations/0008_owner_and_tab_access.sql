-- Account owner (the org's first admin) always has full access. Other admins
-- now follow module/tab grants like everyone else, so they keep exactly what
-- they had: every module, explicitly granted.
alter table users add column is_owner boolean not null default false;

update users u set is_owner = true
from (
  select distinct on (u2.organization_id) u2.id
  from users u2 join roles r on r.id = u2.role_id
  where r.key in ('company_admin', 'super_admin')
  order by u2.organization_id, u2.created_at
) first_admin
where u.id = first_admin.id;

insert into user_module_access (user_id, module_key, enabled)
select u.id, m.key, true
from users u join roles r on r.id = u.role_id cross join modules m
where r.key = 'company_admin' and not u.is_owner
on conflict (user_id, module_key) do nothing;

-- Tabs inside a module (e.g. 'voice_agents.campaigns'). A tab is open unless
-- a row turns it off, so new tabs don't silently lock people out.
create table user_tab_access (
  user_id uuid not null references users(id) on delete cascade,
  tab_key text not null,
  enabled boolean not null default true,
  granted_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, tab_key)
);
alter table user_tab_access enable row level security;
