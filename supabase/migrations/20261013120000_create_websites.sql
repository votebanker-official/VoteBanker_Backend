-- Website builder drafts / publication state for signed-in users.
create table if not exists public.websites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  template_id text not null default 'professional',
  website_name text not null default '',
  slug text,
  status text not null default 'draft',
  profile_data jsonb not null default '{}'::jsonb,
  template_content jsonb not null default '{}'::jsonb,
  design_settings jsonb not null default '{}'::jsonb,
  published_url text,
  published_at timestamptz,
  payment_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint websites_template_id_check check (
    template_id in ('professional', 'official', 'community', 'modern', 'traditional', 'peopleFirst')
  ),
  constraint websites_status_check check (
    status in ('draft', 'pending_payment', 'ready_to_publish', 'published')
  ),
  constraint websites_user_unique unique (user_id)
);

create index if not exists websites_user_id_idx on public.websites (user_id);
create index if not exists websites_status_idx on public.websites (status);

alter table public.websites enable row level security;

drop policy if exists "Users read own websites" on public.websites;
create policy "Users read own websites"
  on public.websites for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own websites" on public.websites;
create policy "Users insert own websites"
  on public.websites for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own websites" on public.websites;
create policy "Users update own websites"
  on public.websites for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
