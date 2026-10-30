-- Volunteer Management: teams, volunteers, applications, tasks, activity.

create table if not exists public.volunteer_teams (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  constraint volunteer_teams_name_nonempty check (char_length(trim(name)) > 0),
  constraint volunteer_teams_name_len check (char_length(name) <= 120),
  constraint volunteer_teams_description_len check (description is null or char_length(description) <= 400)
);

create unique index if not exists volunteer_teams_owner_name_uidx
  on public.volunteer_teams (owner_user_id, lower(trim(name)));

create index if not exists volunteer_teams_owner_idx
  on public.volunteer_teams (owner_user_id);

create table if not exists public.volunteers (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  volunteer_code text not null,
  full_name text not null,
  mobile text not null,
  email text,
  role text not null,
  team_id uuid references public.volunteer_teams (id) on delete set null,
  skills text,
  availability text,
  status text not null default 'active',
  notes text,
  registered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint volunteers_name_nonempty check (char_length(trim(full_name)) > 0),
  constraint volunteers_name_len check (char_length(full_name) <= 120),
  constraint volunteers_mobile_len check (char_length(mobile) <= 24),
  constraint volunteers_email_len check (email is null or char_length(email) <= 160),
  constraint volunteers_role_len check (char_length(role) <= 80),
  constraint volunteers_skills_len check (skills is null or char_length(skills) <= 800),
  constraint volunteers_availability_len check (availability is null or char_length(availability) <= 400),
  constraint volunteers_notes_len check (notes is null or char_length(notes) <= 800),
  constraint volunteers_status_check check (status in ('active', 'inactive', 'pending')),
  constraint volunteers_code_nonempty check (char_length(trim(volunteer_code)) > 0)
);

create unique index if not exists volunteers_owner_code_uidx
  on public.volunteers (owner_user_id, volunteer_code);

create unique index if not exists volunteers_owner_mobile_uidx
  on public.volunteers (owner_user_id, mobile);

create index if not exists volunteers_owner_idx
  on public.volunteers (owner_user_id);

create index if not exists volunteers_owner_status_idx
  on public.volunteers (owner_user_id, status);

create index if not exists volunteers_owner_team_idx
  on public.volunteers (owner_user_id, team_id);

create table if not exists public.volunteer_applications (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  full_name text not null,
  mobile text not null,
  email text,
  role text not null,
  skills text,
  availability text,
  notes text,
  status text not null default 'pending',
  volunteer_id uuid references public.volunteers (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint volunteer_applications_name_nonempty check (char_length(trim(full_name)) > 0),
  constraint volunteer_applications_status_check check (status in ('pending', 'approved', 'rejected'))
);

create index if not exists volunteer_applications_owner_idx
  on public.volunteer_applications (owner_user_id, status, created_at desc);

create table if not exists public.volunteer_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  description text,
  volunteer_id uuid references public.volunteers (id) on delete set null,
  team_id uuid references public.volunteer_teams (id) on delete set null,
  due_date date,
  priority text not null default 'medium',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint volunteer_tasks_title_nonempty check (char_length(trim(title)) > 0),
  constraint volunteer_tasks_title_len check (char_length(title) <= 160),
  constraint volunteer_tasks_description_len check (description is null or char_length(description) <= 2000),
  constraint volunteer_tasks_priority_check check (priority in ('low', 'medium', 'high')),
  constraint volunteer_tasks_status_check check (status in ('pending', 'in_progress', 'completed'))
);

create index if not exists volunteer_tasks_owner_idx
  on public.volunteer_tasks (owner_user_id, status, created_at desc);

create table if not exists public.volunteer_activity (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  volunteer_id uuid references public.volunteers (id) on delete set null,
  action text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint volunteer_activity_action_len check (char_length(action) <= 80),
  constraint volunteer_activity_detail_len check (detail is null or char_length(detail) <= 400)
);

create index if not exists volunteer_activity_owner_idx
  on public.volunteer_activity (owner_user_id, created_at desc);

alter table public.volunteer_teams enable row level security;
alter table public.volunteers enable row level security;
alter table public.volunteer_applications enable row level security;
alter table public.volunteer_tasks enable row level security;
alter table public.volunteer_activity enable row level security;

drop policy if exists "Users manage own volunteer teams" on public.volunteer_teams;
create policy "Users manage own volunteer teams"
  on public.volunteer_teams for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "Users manage own volunteers" on public.volunteers;
create policy "Users manage own volunteers"
  on public.volunteers for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "Users manage own volunteer applications" on public.volunteer_applications;
create policy "Users manage own volunteer applications"
  on public.volunteer_applications for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "Users manage own volunteer tasks" on public.volunteer_tasks;
create policy "Users manage own volunteer tasks"
  on public.volunteer_tasks for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "Users manage own volunteer activity" on public.volunteer_activity;
create policy "Users manage own volunteer activity"
  on public.volunteer_activity for all
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);
