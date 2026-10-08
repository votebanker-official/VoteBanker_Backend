-- Official location catalog. Assembly constituency rows are not loaded until an
-- Election Commission / Chief Electoral Officer list, including any official
-- district mapping, is available. state_region and constituency remain the
-- older free-text profile fields.

create table if not exists public.states (
  id integer primary key,
  official_state_code text not null unique,
  name text not null,
  local_name text,
  state_or_ut text not null check (state_or_ut in ('STATE', 'UNION_TERRITORY')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.districts (
  id integer primary key,
  official_district_code text not null unique,
  state_id integer not null references public.states (id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists districts_state_id_idx on public.districts (state_id);

create table if not exists public.assembly_constituencies (
  id bigint generated always as identity primary key,
  state_id integer not null references public.states (id),
  constituency_number integer not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (state_id, constituency_number),
  unique (state_id, name)
);

create index if not exists assembly_constituencies_state_id_idx
  on public.assembly_constituencies (state_id);

create table if not exists public.district_assembly_constituency (
  district_id integer not null references public.districts (id),
  assembly_constituency_id bigint not null references public.assembly_constituencies (id),
  primary key (district_id, assembly_constituency_id)
);

create index if not exists district_assembly_constituency_ac_idx
  on public.district_assembly_constituency (assembly_constituency_id);

alter table public.profiles
  add column if not exists country_code text,
  add column if not exists state_id integer references public.states (id),
  add column if not exists district_id integer references public.districts (id),
  add column if not exists assembly_constituency_id bigint references public.assembly_constituencies (id);
