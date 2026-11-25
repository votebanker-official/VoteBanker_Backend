-- Registered user accounts for email/mobile + password authentication.
-- Passwords are stored as secure hashes; never plain text.
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  mobile text not null,
  hashed_password text not null,
  created_at timestamptz not null default now(),
  constraint users_email_format check (position('@' in email) > 1),
  constraint users_mobile_format check (mobile ~ '^\+[1-9][0-9]{7,14}$'),
  constraint users_hashed_password_present check (char_length(hashed_password) > 0)
);

create unique index if not exists users_email_lower_uidx on public.users (lower(email));
create unique index if not exists users_mobile_uidx on public.users (mobile);
create index if not exists users_created_at_idx on public.users (created_at desc);

alter table public.users enable row level security;

-- Users can read only their own account row through authenticated APIs.
drop policy if exists "users_select_own" on public.users;
create policy "users_select_own" on public.users
  for select to authenticated
  using ((select auth.uid()) = id);

-- Inserts/updates are performed by the backend service role after validation.
drop policy if exists "users_insert_service" on public.users;
create policy "users_insert_service" on public.users
  for insert to service_role
  with check (true);

drop policy if exists "users_update_service" on public.users;
create policy "users_update_service" on public.users
  for update to service_role
  using (true)
  with check (true);

notify pgrst, 'reload schema';
