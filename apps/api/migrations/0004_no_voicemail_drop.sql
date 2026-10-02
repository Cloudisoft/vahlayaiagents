-- Campaigns never leave voicemails; the agent hangs up on detection.
alter table campaigns
  drop column voicemail_enabled,
  drop column voicemail_script;
