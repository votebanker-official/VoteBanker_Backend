-- Connected social accounts for the signed-in VoteBanker user.
-- Tokens are encrypted by the backend before insert. The service role bypasses RLS.

create table if not exists public.social_account_connections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  account_id text not null default '',
  account_name text not null default '',
  account_username text not null default '',
  access_token_enc text not null default '',
  refresh_token_enc text not null default '',
  expires_at timestamptz,
  scopes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'connected',
  updated_at timestamptz not null default now(),
  unique (profile_id, provider)
);

alter table public.social_account_connections enable row level security;

create policy "social_connections_select_own"
  on public.social_account_connections
  for select to authenticated
  using ((select auth.uid()) = profile_id);
