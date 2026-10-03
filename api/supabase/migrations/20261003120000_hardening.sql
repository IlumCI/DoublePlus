-- Hardening for the comments API (api/src/index.ts).
--
-- 1. post_comment(): the per-author cooldown and the insert in one
--    transaction, serialised per author by an advisory lock. The worker used
--    to read the author's last comment and then insert, so a burst of
--    concurrent posts all read the same "last" and all got through.
-- 2. security_events: honeypot hits, decoy-key use, bot submissions and
--    blocks, kept longer than the worker's log retention. Service key only.

create or replace function public.post_comment(
  p_token text, p_author text, p_body text, p_holder boolean, p_is_dev boolean, p_cooldown integer
) returns public.comments
language plpgsql
set search_path = public
as $$
declare
  last_at timestamptz;
  row public.comments;
begin
  perform pg_advisory_xact_lock(hashtextextended('comment:' || p_author, 0));
  select created_at into last_at from public.comments
    where author = p_author order by id desc limit 1;
  if last_at is not null and now() - last_at < make_interval(secs => p_cooldown) then
    raise exception 'cooldown:%', ceil(p_cooldown - extract(epoch from now() - last_at))::int
      using errcode = 'P0001';
  end if;
  insert into public.comments (token, author, body, holder, is_dev)
    values (p_token, p_author, p_body, p_holder, p_is_dev)
    returning * into row;
  return row;
end;
$$;

revoke all on function public.post_comment(text, text, text, boolean, boolean, integer) from public, anon, authenticated;
grant execute on function public.post_comment(text, text, text, boolean, boolean, integer) to service_role;

create table public.security_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  kind    text        not null check (char_length(kind) <= 40),
  ip      text        check (char_length(ip) <= 64),
  path    text        check (char_length(path) <= 300),
  ua      text        check (char_length(ua) <= 300),
  country text        check (char_length(country) <= 8),
  detail  jsonb
);
create index security_events_at_idx on public.security_events (at desc);
create index security_events_ip_idx on public.security_events (ip, at desc);
alter table public.security_events enable row level security;
