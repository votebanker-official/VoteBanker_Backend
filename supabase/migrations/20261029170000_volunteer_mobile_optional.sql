-- Phone is optional on the volunteer form. Keep uniqueness only when a number is present.

alter table public.volunteers alter column mobile drop not null;

drop index if exists public.volunteers_owner_mobile_uidx;

create unique index if not exists volunteers_owner_mobile_uidx
  on public.volunteers (owner_user_id, mobile)
  where mobile is not null and char_length(trim(mobile)) > 0;
