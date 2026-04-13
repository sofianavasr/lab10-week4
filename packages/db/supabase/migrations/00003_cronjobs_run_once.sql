-- Add run_once support to cronjobs.
-- When true, the job is automatically deactivated after its first successful execution.
alter table public.cronjobs
  add column if not exists run_once boolean not null default false;
