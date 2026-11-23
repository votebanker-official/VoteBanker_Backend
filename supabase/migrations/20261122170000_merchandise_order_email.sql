-- Buyer email captured with a campaign merchandise order.
alter table public.merchandise_orders
  add column if not exists contact_email text not null default '';

notify pgrst, 'reload schema';
