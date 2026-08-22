-- ═══════════════════════════════════════════════════════════════════
--  Soluna — D1 schema
--
--  Applied automatically: `npm run deploy` runs this against the remote
--  database first (the `predeploy` script in package.json calls
--  `npm run db:remote`), so a table added here is live in prod the moment
--  the deploy finishes — no separate step to remember. For local
--  development against `wrangler dev`, run `npm run db:local` yourself once.
--
--  Safe to re-run: every statement is idempotent.
--
--  Two things worth knowing about this shape, both called out again where
--  they appear:
--
--    1. There is no row level security. A database that speaks SQL over
--       HTTP could be told "a caller may only ever see rows whose user_id
--       matches their token", and enforce that beneath any bug in the app.
--       D1 has nothing equivalent. Every statement in worker/data.ts
--       therefore carries its own `where user_id = ?`, and that discipline
--       is the only thing standing between one reader's library and
--       another's.
--
--    2. The sync cursor is a per-user counter, not a clock. See below.
-- ═══════════════════════════════════════════════════════════════════

-- ── users ──────────────────────────────────────────────────────────
--
--  `seq` is the heart of sync. Every write on behalf of this user stamps
--  the affected rows with an incremented value, and the client pulls with
--  `row_seq > cursor`.
--
--  The Postgres version used `now()` for this. That works there because
--  Postgres hands out transaction timestamps that advance, but on a Worker
--  it would be Date.now() — and two writes landing in the same millisecond
--  would share a stamp. A client that pulled between them would set its
--  cursor past both and never see the second one again. Not rarely: every
--  time a sync happens to interleave with a fast double-write.
--
--  A counter has no such tie. It is monotonic by construction, it needs no
--  clock to be correct, and it survives the server's clock being wrong.
create table if not exists users (
  id            text primary key,
  email         text not null unique,
  -- lower-cased email, the form every lookup uses
  email_key     text not null unique,
  created_at    integer not null,
  -- there is no unverified state here: the only way to obtain an account is
  -- to open a link sent to the address, so possession is proven at signup
  verified_at   integer not null,
  seq           integer not null default 0
);

-- ── auth sessions ──────────────────────────────────────────────────
--
--  Named `auth_sessions` because `sessions` already means something in this
--  app: a stretch of reading. Confusing the two would be a bad afternoon.
--
--  Only the SHA-256 of the token is stored. A leaked database backup then
--  yields nothing usable — the same reason the token tables below hash too.
--  Plain SHA-256 is right here, and would be wrong for a password: these
--  secrets are 256 bits of CSPRNG output, so there is no dictionary to run
--  and nothing for a slow KDF to buy.
create table if not exists auth_sessions (
  token_hash text primary key,
  user_id    text not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null,
  -- rough provenance, shown on the account screen so a stolen session is
  -- something you can notice and revoke
  user_agent text
);

create index if not exists auth_sessions_user_idx on auth_sessions (user_id);
create index if not exists auth_sessions_expiry_idx on auth_sessions (expires_at);

-- ── login tokens ───────────────────────────────────────────────────
--
--  One row per magic link in flight. Single use: verification deletes the
--  row inside the same statement that reads it, so a link forwarded to
--  someone else — or replayed from a mail scanner that pre-fetches URLs —
--  is already spent.
create table if not exists login_tokens (
  token_hash text primary key,
  email_key  text not null,
  created_at integer not null,
  expires_at integer not null
);

create index if not exists login_tokens_email_idx on login_tokens (email_key);
create index if not exists login_tokens_expiry_idx on login_tokens (expires_at);

-- ── passkey credentials ────────────────────────────────────────────
--
--  What the browser gives us at registration and what we need to check an
--  assertion later: the credential id, its public key, and the signature
--  counter. `counter` is the clone detector — an authenticator increments
--  it every assertion, so a value that fails to advance means two copies of
--  a key that was supposed to be unclonable. Apple's keychain reports zero
--  throughout, which is expected and not a red flag.
create table if not exists credentials (
  id           text primary key,          -- base64url credential id
  user_id      text not null references users(id) on delete cascade,
  public_key   text not null,             -- base64url COSE key
  counter      integer not null default 0,
  transports   text,                      -- json array, hints for the next prompt
  label        text,                      -- e.g. "iPad", shown when revoking
  created_at   integer not null,
  last_used_at integer
);

create index if not exists credentials_user_idx on credentials (user_id);

-- ── WebAuthn challenges ────────────────────────────────────────────
--
--  A challenge must be server-generated, single-use and short-lived, or the
--  signature it protects proves nothing. Kept in the database rather than a
--  cookie so that it cannot be chosen by the client.
create table if not exists challenges (
  challenge  text primary key,
  -- null for a sign-in attempt: we don't know who it is until they answer
  user_id    text,
  purpose    text not null,               -- 'register' | 'login'
  created_at integer not null,
  expires_at integer not null
);

create index if not exists challenges_expiry_idx on challenges (expires_at);

-- ── rate limiting ──────────────────────────────────────────────────
--
--  Coarse and good enough: a counter per key per window. Without it the
--  magic-link endpoint is a free email cannon pointed at any address
--  somebody cares to type, which is both an abuse vector and the fastest
--  way to get a sending domain blacklisted.
create table if not exists rate_limits (
  key        text primary key,
  count      integer not null default 0,
  window_at  integer not null
);

-- ═══════════════════════════════════════════════════════════════════
--  Reading data
-- ═══════════════════════════════════════════════════════════════════

-- ── books ──────────────────────────────────────────────────────────
create table if not exists books (
  user_id     text    not null references users(id) on delete cascade,
  id          text    not null,
  title       text    not null default '',
  author      text    not null default '',
  meta        text    not null default '{}',
  spine       text    not null default '[]',
  toc         text    not null default '[]',
  total_words integer not null default 0,
  hue         integer not null default 0,
  added_at    integer not null default 0,
  finished_at integer,
  file_path   text,
  file_size   integer,
  cover_path  text,
  updated_at  integer not null default 0,   -- client clock, drives last-write-wins
  deleted     integer not null default 0,
  row_seq     integer not null default 0,   -- server counter, drives the cursor
  primary key (user_id, id)
);

create index if not exists books_seq_idx on books (user_id, row_seq);

-- ── progress ───────────────────────────────────────────────────────
create table if not exists progress (
  user_id     text    not null references users(id) on delete cascade,
  book_id     text    not null,
  spine_index integer not null default 0,
  word_index  integer not null default 0,
  percent     real    not null default 0,
  updated_at  integer not null default 0,
  row_seq     integer not null default 0,
  primary key (user_id, book_id)
);

create index if not exists progress_seq_idx on progress (user_id, row_seq);

-- ── reading sessions ───────────────────────────────────────────────
--  Append-only: every statistic in the app derives from these, so they are
--  inserted and never edited.
create table if not exists read_sessions (
  user_id  text    not null references users(id) on delete cascade,
  uid      text    not null,
  book_id  text    not null,
  start_at integer not null,
  end_at   integer not null,
  ms       integer not null default 0,
  words    integer not null default 0,
  pages    integer not null default 0,
  paced_ms integer not null default 0,
  source   text    not null default 'app',
  row_seq  integer not null default 0,
  primary key (user_id, uid)
);

create index if not exists read_sessions_seq_idx on read_sessions (user_id, row_seq);
create index if not exists read_sessions_start_idx on read_sessions (user_id, start_at);

-- ── device books ───────────────────────────────────────────────────
create table if not exists device_books (
  user_id      text    not null references users(id) on delete cascade,
  id           text    not null,
  title        text    not null default '',
  author       text    not null default '',
  pages        integer not null default 1,
  start_page   integer not null default 1,
  current_page integer not null default 0,
  book_id      text,
  link_pinned  integer not null default 0,
  device       text,
  added_at     integer not null default 0,
  finished_at  integer,
  hue          integer not null default 0,
  updated_at   integer not null default 0,
  deleted      integer not null default 0,
  row_seq      integer not null default 0,
  primary key (user_id, id)
);

create index if not exists device_books_seq_idx on device_books (user_id, row_seq);

-- ── device sessions ────────────────────────────────────────────────
create table if not exists device_sessions (
  user_id        text    not null references users(id) on delete cascade,
  uid            text    not null,
  device_book_id text    not null,
  start_at       integer not null,
  end_at         integer not null,
  ms             integer not null default 0,
  from_page      integer not null default 0,
  to_page        integer not null default 0,
  pages          integer not null default 0,
  words          integer not null default 0,
  mirror_uid     text,
  note           text,
  updated_at     integer not null default 0,
  deleted        integer not null default 0,
  row_seq        integer not null default 0,
  primary key (user_id, uid)
);

create index if not exists device_sessions_seq_idx on device_sessions (user_id, row_seq);
create index if not exists device_sessions_book_idx on device_sessions (user_id, device_book_id);

-- ── bookmarks ──────────────────────────────────────────────────────
create table if not exists bookmarks (
  user_id     text    not null references users(id) on delete cascade,
  uid         text    not null,
  book_id     text    not null,
  spine_index integer not null default 0,
  word_index  integer not null default 0,
  excerpt     text    not null default '',
  created_at  integer not null default 0,
  updated_at  integer not null default 0,
  deleted     integer not null default 0,
  row_seq     integer not null default 0,
  primary key (user_id, uid)
);

create index if not exists bookmarks_seq_idx on bookmarks (user_id, row_seq);

-- ── ratings ────────────────────────────────────────────────────────
--  Not a column on `books`, for two reasons that both come down to the
--  same thing: a verdict is not a property of a file. It survives the EPUB
--  being deleted to free space, and it can be about a book only ever read
--  on a physical e-reader. So both pointers are nullable, both may be null
--  at once, and the title travels with the row.
create table if not exists ratings (
  user_id        text    not null references users(id) on delete cascade,
  id             text    not null,
  book_id        text,
  device_book_id text,
  title          text    not null default '',
  author         text    not null default '',
  overall        real    not null default 0,
  axes           text    not null default '{}',   -- json, as everywhere here
  mood           text,
  note           text,
  favourite      integer not null default 0,
  words          integer,
  rated_at       integer not null default 0,
  updated_at     integer not null default 0,
  deleted        integer not null default 0,
  row_seq        integer not null default 0,
  primary key (user_id, id)
);

create index if not exists ratings_seq_idx on ratings (user_id, row_seq);
create index if not exists ratings_book_idx on ratings (user_id, book_id);

-- ── edition cache ──────────────────────────────────────────────────
--
--  What a book looks like in the world: publisher, page count, cover, and
--  the opening of its Wikipedia article. Filled by worker/editions.ts from
--  Open Library, Google Books and Wikidata.
--
--  The only table here with no `user_id`, which is worth saying out loud
--  given the note at the top of this file. It is sound because nothing in
--  it came from a reader — every row is a copy of a public catalogue
--  record, keyed by a title and an author that any two people might both
--  own, and two readers of the same novel *should* share the row. What
--  would be private is who looked up what, and that is not recorded: there
--  is no column for it. The endpoint still requires a session, because
--  making outbound requests on an anonymous caller's behalf is how you
--  become somebody else's rate limit problem.
--
--  `payload` is the whole answer as json rather than a column per field.
--  It is a cache of somebody else's schema, so a shape that can absorb a
--  new field without a migration is the right trade here — the opposite
--  of the reading tables above, which are ours and are queried by column.
create table if not exists edition_cache (
  -- `editionKey(title, author)` from src/engine/edition.ts — normalised
  -- hard so the same book from two shelves lands on one row
  key        text primary key,
  payload    text    not null default '{}',
  -- a hit is kept for good (a novel's page count does not change); a miss
  -- is retried after a fortnight, since a book absent from a catalogue
  -- today may be in it next month
  fetched_at integer not null default 0
);

-- ── settings ───────────────────────────────────────────────────────
create table if not exists settings (
  user_id    text    primary key references users(id) on delete cascade,
  data       text    not null default '{}',
  updated_at integer not null default 0,
  row_seq    integer not null default 0
);
