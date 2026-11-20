-- Per-product quantity slabs. Prices stay empty until an administrator sets them.
-- Unit prices are stored in paise. No tax columns are added here.

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
