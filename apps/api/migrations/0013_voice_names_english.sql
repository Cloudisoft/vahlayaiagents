-- Voices show their name only ("Aadhya", not "Aadhya - Soother"); the
-- descriptor moves to style. The library keeps English voices only.
update voices set style = coalesce(nullif(style, ''), nullif(split_part(name, ' - ', 2), '')), name = split_part(name, ' - ', 1)
where name like '% - %';

-- Non-English library voices: delete if nothing uses them, otherwise hide.
update voices set hidden = true
where organization_id is null and coalesce(language, 'en') not like 'en%'
  and (exists (select 1 from ai_agents a where a.voice_id = voices.id) or exists (select 1 from campaigns c where c.voice_id = voices.id));
delete from voices
where organization_id is null and coalesce(language, 'en') not like 'en%'
  and not exists (select 1 from ai_agents a where a.voice_id = voices.id)
  and not exists (select 1 from campaigns c where c.voice_id = voices.id)
  and not exists (select 1 from calls k where k.voice_id = voices.id);
