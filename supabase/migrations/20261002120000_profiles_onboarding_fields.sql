-- Onboarding fields collected by the app (all optional).
alter table public.profiles
  add column if not exists designation text,
  add column if not exists organization text,
  add column if not exists country text,
  add column if not exists state_region text,
  add column if not exists constituency text,
  add column if not exists public_contact text,
  add column if not exists website_template text,
  add column if not exists social_channels text[] not null default '{}',
  add column if not exists vrm_requested boolean not null default false;
