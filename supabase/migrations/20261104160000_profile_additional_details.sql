alter table public.profiles
  add column if not exists additional_profile jsonb not null default '{}'::jsonb;

insert into storage.buckets (id, name, public)
values ('profile-media', 'profile-media', true)
on conflict (id) do nothing;
