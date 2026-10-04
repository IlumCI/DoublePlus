-- Token comment threads for doubleplus.fun.
--
-- Written and read only by the API worker (backend/src/index.ts) with the
-- service key: RLS is on with no policies, so the anon key sees nothing.
-- Addresses are stored lowercased.

create table public.comments (
  id          bigint generated always as identity primary key,
  token       text        not null check (token ~ '^0x[0-9a-f]{40}$'),
  author      text        not null check (author ~ '^0x[0-9a-f]{40}$'),
  body        text        not null check (char_length(body) between 1 and 280),
  -- Snapshot at posting time: what the badge on the comment shows.
  holder      boolean     not null default false,
  is_dev      boolean     not null default false,
  hidden      boolean     not null default false,
  created_at  timestamptz not null default now()
);

create index comments_token_id_idx on public.comments (token, id desc) where not hidden;
create index comments_author_id_idx on public.comments (author, id desc);

alter table public.comments enable row level security;
