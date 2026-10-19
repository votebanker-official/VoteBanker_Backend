-- Shared VRM catalog: any authenticated user can read shared voter rows.
alter table public.vrm_voter_records
  add column if not exists is_shared boolean not null default false;

create index if not exists vrm_voter_records_shared_idx
  on public.vrm_voter_records (is_shared)
  where is_shared = true;

-- Existing electoral-roll seed is a shared catalog for every signed-in user.
update public.vrm_voter_records
set is_shared = true
where is_shared = false;

drop policy if exists "Users read own vrm voter records" on public.vrm_voter_records;
create policy "Users read own or shared vrm voter records"
  on public.vrm_voter_records for select
  using (auth.uid() = owner_user_id or is_shared = true);

-- Keep write policies owner-scoped (imports stay server-side / owner-bound).
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
