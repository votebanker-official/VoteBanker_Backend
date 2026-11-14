-- Create a profile row when Supabase Auth registers a user.
-- Existing policies already limit each user to their own row:
-- profiles_select_own, profiles_insert_own, profiles_update_own
-- all use auth.uid() = id.
-- The Google email stays on the auth user (user_metadata.contact_email).
-- profiles has no email column, so this trigger does not add one.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'name'), ''), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
