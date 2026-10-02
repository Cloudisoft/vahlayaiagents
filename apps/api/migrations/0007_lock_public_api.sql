-- On Supabase every table in "public" is reachable through the Data API with
-- the (public) anon key. Row-level security with no policies denies that API
-- entirely; the app connects as the table owner, which RLS doesn't restrict.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
