-- NOTE: pg_cron and pg_net must be enabled manually via the Supabase dashboard
-- (Database → Extensions) before running this migration.
--
-- After running this migration, schedule the recurring job once with your
-- actual deployment URL and CRON_SECRET by running in the SQL Editor:
--
--   select cron.schedule(
--     'execute-cronjobs',
--     '* * * * *',
--     $$
--     select net.http_post(
--       url     := 'https://YOUR-APP-URL/api/cron/execute',
--       headers := jsonb_build_object(
--                    'Content-Type', 'application/json',
--                    'x-cron-secret', 'YOUR-CRON-SECRET'
--                  ),
--       body    := '{}'::jsonb
--     ) as request_id;
--     $$
--   );

-- ============================================================
-- cronjobs
-- ============================================================
create table public.cronjobs (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  jobname          text not null,
  description      text not null,        -- prompt sent to the agent when fired
  expression       text not null,        -- cron expression (e.g. "0 9 * * 1")
  active           boolean not null default true,
  last_executed_at timestamptz,
  created_at       timestamptz not null default now()
);

alter table public.cronjobs enable row level security;

-- Users can manage their own jobs via the web/agent
create policy "Users can manage own cronjobs"
  on public.cronjobs for all
  using (auth.uid() = user_id);

-- Service role (used by the cron API route) bypasses RLS automatically,
-- so no extra policy is needed for server-side access.
