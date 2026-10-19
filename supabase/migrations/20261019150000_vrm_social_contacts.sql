-- Manual social contact fields on existing VRM voter records.
alter table public.vrm_voter_records
  add column if not exists whatsapp_contact text,
  add column if not exists instagram_contact text,
  add column if not exists facebook_contact text;

alter table public.vrm_voter_records
  drop constraint if exists vrm_voter_records_whatsapp_len;
alter table public.vrm_voter_records
  add constraint vrm_voter_records_whatsapp_len
  check (whatsapp_contact is null or char_length(whatsapp_contact) <= 40);

alter table public.vrm_voter_records
  drop constraint if exists vrm_voter_records_instagram_len;
alter table public.vrm_voter_records
  add constraint vrm_voter_records_instagram_len
  check (instagram_contact is null or char_length(instagram_contact) <= 200);

alter table public.vrm_voter_records
  drop constraint if exists vrm_voter_records_facebook_len;
alter table public.vrm_voter_records
  add constraint vrm_voter_records_facebook_len
  check (facebook_contact is null or char_length(facebook_contact) <= 200);

-- Authenticated users may update contact fields on shared rows or their own rows.
-- (API still authorizes; this keeps direct Supabase clients consistent.)
drop policy if exists "Users update own vrm voter records" on public.vrm_voter_records;
create policy "Users update own or shared vrm contact fields"
  on public.vrm_voter_records for update
  using (auth.uid() = owner_user_id or is_shared = true)
  with check (auth.uid() = owner_user_id or is_shared = true);
