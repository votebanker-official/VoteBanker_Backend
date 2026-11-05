create table if not exists public.demo_accounts (
  phone text primary key,
  profile jsonb,
  last_route text not null default '/profile',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.demo_accounts enable row level security;

create trigger demo_accounts_set_updated_at
  before update on public.demo_accounts
  for each row execute function public.set_updated_at();
