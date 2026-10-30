-- Optional location and profile photo URL for volunteer directory UI.
alter table public.volunteers
  add column if not exists location text,
  add column if not exists photo_url text;

alter table public.volunteers
  drop constraint if exists volunteers_location_len;
alter table public.volunteers
  add constraint volunteers_location_len
  check (location is null or char_length(location) <= 160);

alter table public.volunteers
  drop constraint if exists volunteers_photo_url_len;
alter table public.volunteers
  add constraint volunteers_photo_url_len
  check (photo_url is null or char_length(photo_url) <= 500);
