-- Booth details and a storage path for the leader photo.
-- Existing profile rows are left unchanged.
alter table public.profiles
  add column if not exists booth_number text,
  add column if not exists booth_name text,
  add column if not exists profile_photo_path text;

insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', true)
on conflict (id) do nothing;
