-- Staff members shown on the My Team dashboard. Separate from volunteer campaign teams.

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  full_name text not null,
  mobile text not null,
  email text,
  designation text,
  location text,
  role text not null,
  permissions text[] not null default '{}',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint team_members_name_nonempty check (char_length(trim(full_name)) > 0),
  constraint team_members_name_len check (char_length(full_name) <= 120),
  constraint team_members_mobile_len check (char_length(mobile) <= 24),
  constraint team_members_email_len check (email is null or char_length(email) <= 160),
  constraint team_members_designation_len check (designation is null or char_length(designation) <= 80),
  constraint team_members_location_len check (location is null or char_length(location) <= 120),
  constraint team_members_role_len check (char_length(role) <= 80),
  constraint team_members_status_check check (status in ('active', 'inactive', 'pending'))
);

create unique index if not exists team_members_owner_mobile_uidx
  on public.team_members (owner_user_id, mobile);

create index if not exists team_members_owner_status_idx
  on public.team_members (owner_user_id, status);

alter table public.team_members enable row level security;

drop policy if exists "Users manage own team members" on public.team_members;
create policy "Users manage own team members"
  on public.team_members for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);
