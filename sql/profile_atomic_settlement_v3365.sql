begin;
create table if not exists public.pd_match_settlements (
 match_id uuid primary key,
 winner_hash text not null,
 loser_hash text not null,
 created_at timestamptz not null default now(),
 check(winner_hash <> loser_hash)
);
alter table public.pd_match_settlements enable row level security;
revoke all on public.pd_match_settlements from public, anon, authenticated;
grant select, insert on public.pd_match_settlements to service_role;
create or replace function public.pd_settle_match_v3365(
 p_match_id uuid, p_winner text, p_loser text, p_win_entry jsonb, p_lose_entry jsonb, p_forfeit boolean
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
 n integer;
 h text;
 b jsonb;
 o jsonb;
 hist jsonb;
 won boolean;
begin
 if p_match_id is null or p_winner is null or p_loser is null or p_winner=p_loser then raise exception 'BAD_MATCH'; end if;
 insert into public.pd_match_settlements(match_id,winner_hash,loser_hash)
 values(p_match_id,p_winner,p_loser) on conflict(match_id) do nothing;
 get diagnostics n = row_count;
 if n=0 then
  if not exists(select 1 from public.pd_match_settlements where match_id=p_match_id and winner_hash=p_winner and loser_hash=p_loser) then raise exception 'MATCH_ID_CONFLICT'; end if;
  return jsonb_build_object('ok',true,'duplicate',true);
 end if;
 for h,b in select profile_hash,baseline_json from public.player_stats_profiles where profile_hash in(p_winner,p_loser) order by profile_hash for update loop
  won := h=p_winner;
  o := coalesce(b->'online','{}'::jsonb);
  o := o || jsonb_build_object('played',coalesce((o->>'played')::bigint,0)+1,'wins',coalesce((o->>'wins')::bigint,0)+case when won then 1 else 0 end,'losses',coalesce((o->>'losses')::bigint,0)+case when won then 0 else 1 end,'forfeits',coalesce((o->>'forfeits')::bigint,0)+case when not won and p_forfeit then 1 else 0 end);
  select coalesce(jsonb_agg(v order by ord),'[]'::jsonb) into hist from (select v,ord from jsonb_array_elements(jsonb_build_array(case when won then p_win_entry else p_lose_entry end)||coalesce(b->'history','[]'::jsonb)) with ordinality as t(v,ord) order by ord limit 20) q;
  update public.player_stats_profiles set baseline_json=b||jsonb_build_object('online',o,'history',hist),updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') where profile_hash=h;
 end loop;
 select count(*) into n from public.player_stats_profiles where profile_hash in(p_winner,p_loser);
 if n<>2 then raise exception 'STATS_PROFILE_NOT_FOUND'; end if;
 return jsonb_build_object('ok',true,'duplicate',false);
end;
$$;
revoke all on function public.pd_settle_match_v3365(uuid,text,text,jsonb,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.pd_settle_match_v3365(uuid,text,text,jsonb,jsonb,boolean) to service_role;
commit;