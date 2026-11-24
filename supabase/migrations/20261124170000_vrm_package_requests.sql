create table if not exists public.vrm_package_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  user_name text not null,
  user_phone text not null,
  package_code text not null,
  voter_count integer not null,
  amount_inr integer not null,
  status text not null default 'requested',
  created_at timestamptz not null default now(),
  constraint vrm_package_requests_package check (
    (package_code = 'voters_100' and voter_count = 100 and amount_inr = 100)
    or (package_code = 'voters_1000' and voter_count = 1000 and amount_inr = 999)
    or (package_code = 'voters_10000' and voter_count = 10000 and amount_inr = 9999)
  ),
  constraint vrm_package_requests_status check (status in ('requested', 'paid', 'cancelled')),
  constraint vrm_package_requests_name_len check (char_length(user_name) between 1 and 160),
  constraint vrm_package_requests_phone_len check (char_length(user_phone) between 7 and 40)
);

create index if not exists vrm_package_requests_created_at_idx
  on public.vrm_package_requests (created_at desc);
create index if not exists vrm_package_requests_user_id_idx
  on public.vrm_package_requests (user_id);

alter table public.vrm_package_requests enable row level security;
revoke all on public.vrm_package_requests from anon, authenticated;
grant all on public.vrm_package_requests to service_role;
