-- VRM voter records: Name, Age, Gender, EPIC only (+ ownership / import metadata).
create table if not exists public.vrm_voter_records (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  age integer,
  gender text,
  epic_number text,
  source_serial integer,
  import_batch_id text,
  needs_review boolean not null default false,
  review_notes text,
  created_at timestamptz not null default now(),
  constraint vrm_voter_records_name_nonempty check (char_length(trim(name)) > 0),
  constraint vrm_voter_records_age_range check (age is null or (age >= 0 and age <= 130)),
  constraint vrm_voter_records_gender_len check (gender is null or char_length(gender) <= 40),
  constraint vrm_voter_records_epic_len check (epic_number is null or char_length(epic_number) <= 20)
);

-- Same EPIC cannot be stored twice for one owner (when EPIC is present).
create unique index if not exists vrm_voter_records_owner_epic_uidx
  on public.vrm_voter_records (owner_user_id, epic_number)
  where epic_number is not null;

-- Idempotent re-import of the same batch + serial for one owner.
create unique index if not exists vrm_voter_records_owner_batch_serial_uidx
  on public.vrm_voter_records (owner_user_id, import_batch_id, source_serial)
  where import_batch_id is not null and source_serial is not null;

create index if not exists vrm_voter_records_owner_user_id_idx
  on public.vrm_voter_records (owner_user_id);

create index if not exists vrm_voter_records_owner_name_idx
  on public.vrm_voter_records (owner_user_id, lower(name));

create index if not exists vrm_voter_records_owner_epic_idx
  on public.vrm_voter_records (owner_user_id, epic_number);

alter table public.vrm_voter_records enable row level security;

drop policy if exists "Users read own vrm voter records" on public.vrm_voter_records;
create policy "Users read own vrm voter records"
  on public.vrm_voter_records for select
  using (auth.uid() = owner_user_id);

drop policy if exists "Users insert own vrm voter records" on public.vrm_voter_records;
create policy "Users insert own vrm voter records"
  on public.vrm_voter_records for insert
  with check (auth.uid() = owner_user_id);

drop policy if exists "Users update own vrm voter records" on public.vrm_voter_records;
create policy "Users update own vrm voter records"
  on public.vrm_voter_records for update
  using (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

drop policy if exists "Users delete own vrm voter records" on public.vrm_voter_records;
create policy "Users delete own vrm voter records"
  on public.vrm_voter_records for delete
  using (auth.uid() = owner_user_id);
