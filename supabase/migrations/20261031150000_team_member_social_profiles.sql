-- Profile links collected on Add Team Member. The WhatsApp number stays in mobile.

alter table public.team_members
  add column if not exists facebook_url text,
  add column if not exists instagram_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'team_members_facebook_url_len'
  ) then
    alter table public.team_members
      add constraint team_members_facebook_url_len
      check (facebook_url is null or char_length(facebook_url) <= 300);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'team_members_instagram_url_len'
  ) then
    alter table public.team_members
      add constraint team_members_instagram_url_len
      check (instagram_url is null or char_length(instagram_url) <= 300);
  end if;
end $$;
