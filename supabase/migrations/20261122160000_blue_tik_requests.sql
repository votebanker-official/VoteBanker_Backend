-- Verification assistance requests from the Blue Tik booking form.
-- The API writes these with the service role. Clients do not read the table directly.

create table if not exists public.blue_tik_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  offer_id text not null,
  service_name text not null,
  price_inr integer not null,
  leader_name text not null,
  mobile text not null,
  email text not null,
  profile_urls jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

alter table public.blue_tik_requests drop constraint if exists blue_tik_requests_offer_check;
alter table public.blue_tik_requests
  add constraint blue_tik_requests_offer_check
  check (offer_id in ('instagram', 'facebook', 'whatsapp', 'bundle'));

alter table public.blue_tik_requests drop constraint if exists blue_tik_requests_status_check;
alter table public.blue_tik_requests
  add constraint blue_tik_requests_status_check
  check (status in ('pending'));

alter table public.blue_tik_requests drop constraint if exists blue_tik_requests_price_check;
alter table public.blue_tik_requests
  add constraint blue_tik_requests_price_check
  check (price_inr > 0);

create index if not exists blue_tik_requests_created_idx
  on public.blue_tik_requests (created_at desc);

create index if not exists blue_tik_requests_user_idx
  on public.blue_tik_requests (user_id);

alter table public.blue_tik_requests enable row level security;

notify pgrst, 'reload schema';
