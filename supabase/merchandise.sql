-- Campaign merchandise. The Flutter app never talks to this database.
-- The VOTE BANKER backend uses the secret key, which bypasses these policies.

create table if not exists public.merchandise_products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  kind text not null,
  sizes text[] not null default '{}',
  colors text[] not null default '{}',
  sort_order integer not null default 0,
  active boolean not null default true
);

create table if not exists public.merchandise_orders (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles (id) on delete set null,
  product_slug text not null,
  product_name text not null,
  campaign_line text not null,
  size text not null default '',
  color text not null default '',
  quantity integer not null check (quantity between 1 and 500),
  contact_name text not null,
  contact_phone text not null default '',
  notes text not null default '',
  status text not null default 'requested',
  created_at timestamptz not null default now()
);

create index if not exists merchandise_orders_profile_created_idx
  on public.merchandise_orders (profile_id, created_at desc);

alter table public.merchandise_products enable row level security;
alter table public.merchandise_orders enable row level security;
