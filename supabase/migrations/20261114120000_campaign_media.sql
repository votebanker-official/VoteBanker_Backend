-- Logo and additional onboarding photos for the signed-in user.
create table if not exists public.campaign_media (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  storage_path text not null,
  public_url text not null,
  created_at timestamptz not null default now(),
  constraint campaign_media_kind_check check (kind in ('logo', 'photo')),
  constraint campaign_media_path_unique unique (user_id, storage_path)
);

create unique index if not exists campaign_media_one_logo_idx
  on public.campaign_media (user_id)
  where kind = 'logo';

create index if not exists campaign_media_user_created_idx
  on public.campaign_media (user_id, created_at);

alter table public.campaign_media enable row level security;

drop policy if exists "Users read own campaign media" on public.campaign_media;
create policy "Users read own campaign media"
  on public.campaign_media for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own campaign media" on public.campaign_media;
create policy "Users insert own campaign media"
  on public.campaign_media for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users delete own campaign media" on public.campaign_media;
create policy "Users delete own campaign media"
  on public.campaign_media for delete
  using (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('campaign-media', 'campaign-media', true)
on conflict (id) do nothing;
