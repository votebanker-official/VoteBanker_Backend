-- Allow anyone (including anon) to read shared VRM catalog rows.
-- Private rows remain owner-only.
drop policy if exists "Users read own or shared vrm voter records" on public.vrm_voter_records;
drop policy if exists "Public read shared vrm voter records" on public.vrm_voter_records;
drop policy if exists "Users read own private vrm voter records" on public.vrm_voter_records;

create policy "Public read shared vrm voter records"
  on public.vrm_voter_records for select
  using (is_shared = true);

create policy "Users read own private vrm voter records"
  on public.vrm_voter_records for select
  using (auth.uid() = owner_user_id);
