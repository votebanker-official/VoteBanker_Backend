alter table public.users
  add column if not exists password_reset_token_hash text,
  add column if not exists password_reset_expires_at timestamptz;

create unique index if not exists users_password_reset_token_hash_uidx
  on public.users (password_reset_token_hash)
  where password_reset_token_hash is not null;

notify pgrst, 'reload schema';
