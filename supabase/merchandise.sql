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
  active boolean not null default true,
  price_slabs jsonb not null default '[]'::jsonb
);

create table if not exists public.merchandise_orders (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles (id) on delete set null,
  product_slug text not null,
  product_name text not null,
  campaign_line text not null,
  campaign_photo text not null default '',
  size text not null default '',
  color text not null default '',
  quantity integer not null check (quantity >= 50 and quantity <= 100000 and quantity % 50 = 0),
  contact_name text not null,
  contact_phone text not null default '',
  notes text not null default '',
  unit_price_paise bigint,
  line_total_paise bigint,
  status text not null default 'requested',
  created_at timestamptz not null default now()
);

alter table public.merchandise_orders
  add column if not exists campaign_photo text not null default '';

alter table public.merchandise_products
  add column if not exists price_slabs jsonb not null default '[]'::jsonb;

alter table public.merchandise_orders
  add column if not exists unit_price_paise bigint,
  add column if not exists line_total_paise bigint;

alter table public.merchandise_orders drop constraint if exists merchandise_orders_quantity_check;
alter table public.merchandise_orders
  add constraint merchandise_orders_quantity_check
  check (quantity >= 50 and quantity <= 100000 and quantity % 50 = 0)
  not valid;

create index if not exists merchandise_orders_profile_created_idx
  on public.merchandise_orders (profile_id, created_at desc);

alter table public.merchandise_products enable row level security;
alter table public.merchandise_orders enable row level security;
