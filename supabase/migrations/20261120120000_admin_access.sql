-- Admin access, activity history, and audit records.
-- Existing client tables stay in place. New users remain clients.

alter table public.profiles
  add column if not exists app_role text not null default 'client',
  add column if not exists account_status text not null default 'active',
  add column if not exists last_login_at timestamptz,
  add column if not exists contact_email text;

alter table public.profiles drop constraint if exists profiles_app_role_check;
alter table public.profiles
  add constraint profiles_app_role_check check (app_role in ('admin', 'client'));

alter table public.profiles drop constraint if exists profiles_account_status_check;
alter table public.profiles
  add constraint profiles_account_status_check check (account_status in ('active', 'inactive'));

alter table public.profiles drop constraint if exists profiles_contact_email_len;
alter table public.profiles
  add constraint profiles_contact_email_len check (
    contact_email is null or char_length(contact_email) <= 160
  );

create index if not exists profiles_app_role_idx on public.profiles (app_role);
create index if not exists profiles_account_status_idx on public.profiles (account_status);
create index if not exists profiles_created_at_idx on public.profiles (created_at desc);
create index if not exists profiles_last_login_idx on public.profiles (last_login_at desc);
create index if not exists profiles_phone_idx on public.profiles (phone);

create index if not exists merchandise_orders_created_idx
  on public.merchandise_orders (created_at desc);
create index if not exists merchandise_orders_status_idx
  on public.merchandise_orders (status);

-- Meaningful application events. No passwords, tokens, or message bodies.
create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles (id) on delete cascade,
  event_type text not null,
  description text not null,
  resource_type text,
  resource_id text,
  status text not null default 'recorded',
  dedupe_key text,
  created_at timestamptz not null default now(),
  constraint activity_events_type_len check (char_length(event_type) <= 80),
  constraint activity_events_description_len check (char_length(description) <= 400),
  constraint activity_events_status_len check (char_length(status) <= 40),
  constraint activity_events_resource_len check (
    resource_id is null or char_length(resource_id) <= 80
  )
);

create unique index if not exists activity_events_dedupe_uidx
  on public.activity_events (dedupe_key)
  where dedupe_key is not null;

create index if not exists activity_events_profile_created_idx
  on public.activity_events (profile_id, created_at desc);
create index if not exists activity_events_type_created_idx
  on public.activity_events (event_type, created_at desc);
create index if not exists activity_events_created_idx
  on public.activity_events (created_at desc);

alter table public.activity_events enable row level security;

-- Admin actions. Clients have no policy, so they cannot read or change these rows.
create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles (id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  outcome text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint admin_audit_action_len check (char_length(action) <= 80),
  constraint admin_audit_outcome_len check (char_length(outcome) <= 40),
  constraint admin_audit_detail_len check (detail is null or char_length(detail) <= 400)
);

create index if not exists admin_audit_created_idx
  on public.admin_audit_logs (created_at desc);
create index if not exists admin_audit_admin_idx
  on public.admin_audit_logs (admin_id, created_at desc);

alter table public.admin_audit_logs enable row level security;

-- Promote an operator from the SQL editor after this migration:
--   update public.profiles set app_role = 'admin' where phone = '+91XXXXXXXXXX';
-- Or set ADMIN_PHONES on the API. New registrations stay app_role = 'client'.
