-- Onboarding progress for resume-after-login. Stored server-side so progress
-- survives logout, refresh, and device changes.
alter table public.profiles
  add column if not exists onboarding_current_step text not null default '/profile',
  add column if not exists onboarding_completed_steps jsonb not null default '[]'::jsonb,
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists onboarding_completed_at timestamptz;

notify pgrst, 'reload schema';
