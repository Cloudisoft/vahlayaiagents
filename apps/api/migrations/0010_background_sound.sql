-- Office ambience behind the agent's voice, per campaign (on by default).
alter table campaigns add column if not exists background_sound boolean not null default true;
