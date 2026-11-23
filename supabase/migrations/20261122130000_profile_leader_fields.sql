-- Leader profile saves select and write these location columns.
-- The location catalog tables are not required for a profile row, so the
-- ids are plain numbers. The assembly name is stored as text beside the role.
alter table public.profiles
  add column if not exists country_code text,
  add column if not exists state_id integer,
  add column if not exists district_id integer,
  add column if not exists assembly_constituency_id bigint,
  add column if not exists assembly_constituency text;

notify pgrst, 'reload schema';
