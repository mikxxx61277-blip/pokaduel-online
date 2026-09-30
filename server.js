begin;

create table if not exists public.player_stats_profiles (
  profile_hash text primary key,
  baseline_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.player_stats_events (
  profile_hash text not null
    references public.player_stats_profiles(profile_hash)
    on delete cascade,
  event_id text not null,
  event_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key (profile_hash, event_id)
);

create index if not exists player_stats_events_profile_time_idx
  on public.player_stats_events(profile_hash, created_at asc);

alter table public.player_stats_profiles enable row level security;
alter table public.player_stats_events enable row level security;

revoke all on table public.player_stats_profiles from anon;
revoke all on table public.player_stats_profiles from authenticated;

revoke all on table public.player_stats_events from anon;
revoke all on table public.player_stats_events from authenticated;

grant select, insert, update, delete
  on table public.player_stats_profiles
  to service_role;

grant select, insert, update, delete
  on table public.player_stats_events
  to service_role;

commit;

select
  has_table_privilege(
    'anon',
    'public.player_stats_profiles',
    'INSERT'
  ) as anon_profiles_insert,

  has_table_privilege(
    'authenticated',
    'public.player_stats_profiles',
    'INSERT'
  ) as auth_profiles_insert,

  has_table_privilege(
    'anon',
    'public.player_stats_events',
    'INSERT'
  ) as anon_events_insert,

  has_table_privilege(
    'authenticated',
    'public.player_stats_events',
    'INSERT'
  ) as auth_events_insert;
