# Branch workflow

- `main` — production. Only receives merges from `develop`, and only when Jan says everything is ok.
- `develop` — where the work happens. Commit directly here; do not create
  feature branches unless Jan asks for one by name.
- When Jan says everything is ok: merge `develop` into `main`.
- Never commit directly to `main`.

Before committing on `develop`, run `npm run typecheck`, `npm test` and
`npm run build`. All three pass today, so a failure is something you just
introduced.

# Current state (2026-08-04)

Everything listed below has since reached `origin/main` (`d2c2d34`) — the
sections are kept because they record *why*, not *what*. `develop` is ahead of
it by the reading-pace estimate (`5c95f9e`) and by **the PWA update path**
(below).

Sections that are now history rather than pending work:

- `82331f8` — the Worker names the one 500 that means "your D1 schema is out
  of date" instead of hiding it behind "Something went wrong."
- `6adad35` (merged as `286f00a`) — **find your place by scanning a page**.
- **rate limiting across the whole API** (below).
- **Supabase removed; D1 schema now deploys itself** (below).
- **renamed from Lumen to Soluna** (below).

## How much longer, and how much today

Two small additions, both to numbers that already existed somewhere and
could not be read where they were wanted.

**The chapter countdown is now on screen while you read it.** The bottom
chrome has carried "12m to next chapter" since the pace estimate landed,
and the chrome is hidden for the whole of the act it describes — you hide
it in order to read — so the number was only ever available to someone who
had stopped. `.chapter-left` in `Reader.tsx` is the same two values
(`chapterLeft`, `lastChapter`) drawn as a pill in the outer corner, where a
printed book keeps its folio. It stands down when the chrome comes up
rather than saying the same thing twice a few pixels apart, and it is
`pointer-events: none` because it overlaps the right tap zone — a countdown
that swallowed page turns would be a bad trade for a number.

**`dayTotal()` in `stats.ts`** is today's reading, and it is built on
`byDay` rather than filtering by timestamp so that a day means what it
means everywhere else in the app: local midnight to local midnight, the
session credited to the day it *started* on. That last part is the whole
reason it is worth a test — an evening that runs past midnight is one
evening, and splitting it would make the Today card disagree with both the
streak and the last bar of the chart.

**The daily bars answer for one day at a time.** Printing thirty numbers
under the chart would destroy the shape that is the point of drawing it,
so the number is on demand: hover with a pointer, hold with a finger.
Three things worth not re-deriving:

- **The hit target is one transparent strip over the SVG, not the `rect`s.**
  A day with no reading is a zero-height bar and a quiet day is barely
  more, so hit-testing the drawing makes exactly the days you most want to
  interrogate the ones you cannot hit.
- **The day is resolved from `clientX` against the strip's own rect**, not
  from a per-cell `onPointerEnter`. Touch takes implicit pointer capture on
  the element where the press began, so per-cell handlers fire once and a
  finger dragged along the month reads back the day it started on for the
  whole gesture.
- **`touch-action: pan-y` on the strip** is what keeps the page scrollable
  through the chart. A vertical drag scrolls, and the browser says so by
  cancelling the pointer, which is what clears the readout.

No schema change and nothing persisted, so `npm run db:local` is not needed.

## What a book looks like in the world (covers, spines, Wikipedia)

The shelf now draws two ways, and the toggle in the ratings tab is a real
choice rather than a display option. **Data** is what it always was —
colour is the mood, height is the score, thickness is the length.
**Shelf** gives height and colour back to the object: the cover's own
palette, the paper's own thickness, the series' own livery. Those cannot
both be true at once. A Reclam is short because it is a Reclam, not
because you disliked it, so in the realistic mode the score drops to the
number stamped at the foot, which you have to walk up and read. The
reasoning is at the top of `src/engine/spine.ts`; don't re-litigate it
without reading that.

**Real spine images do not exist as data.** No catalogue holds a
photograph of the side of a book — Open Library, Google Books and everyone
else hold the front cover and nothing else. What is available is the
publisher and the series, and a series exists precisely so that every book
in it looks the same. Hence `LIVERIES` in `src/engine/edition.ts`: twelve
hand-written liveries (Reclam yellow, the Penguin tri-band, edition
suhrkamp, rororo, dtv, Fischer, Hanser, Oxford, Vintage, Manesse) drawn in
CSS at any thickness. Anything without a livery falls back to the cover's
own colours.

Six things worth not re-deriving:

- **The lookup is on the server because it cannot be anywhere else.**
  Google Books sends no CORS headers; Open Library wants a descriptive
  `User-Agent`, which is a forbidden header name in `fetch`; a Google key
  must not ship to a client; and the answer is identical for every reader
  alive. `worker/editions.ts` does all four catalogue calls.
- **The cover is proxied through R2 for the canvas, not for the network.**
  `getImageData` on a canvas that has drawn a cross-origin image throws,
  and reading those pixels is where the palette comes from — so the cover
  has to arrive same-origin. Served from `/api/editions/cover/<slug>`.
- **`edition_cache` has no `user_id`,** the only table in the schema that
  doesn't. Sound because nothing in it came from a reader: it is a copy of
  a public catalogue record, and two readers of the same novel *should*
  share the row. What would be private is who looked up what, and there is
  no column for it. Covers likewise live under a shared `editions/` prefix
  in R2, away from the per-user objects.
- **Dexie v6 `editions` is outside sync and outside tombstones,** like
  `passages` — but for a different reason. A passage index is cheap to
  rebuild; an edition is cheap *to the user*, because the server already
  cached it, so a second iPad gets it from D1 without troubling any
  catalogue. Syncing rows would move the same bytes through more
  machinery for the same result.
- **The matcher lives in `src/engine/edition.ts` and the Worker imports
  it.** It was duplicated first and that was wrong: two copies typecheck
  independently, the tests only exercise one, and the symptom is a cover
  that is right on the shelf and wrong in the sheet. The file is pure
  TypeScript with no imports so that it can be shared across the two
  tsconfigs.
- **A lookup that finds nothing still writes a row,** so the app stops
  asking — and `knowsAnything()` in `spine.ts` is what stops the shelf
  drawing that row as a real book. Without it every book the catalogues
  missed comes out the same default height in the same colour.

`tests/edition.test.mts` is the layer no build can have an opinion about:
a matcher that confidently returns the wrong book typechecks perfectly.
It caught four real bugs on first run — `ß` deleted rather than folded to
`ss` (so "Der Prozeß" and "Der Prozess" were two books), a subtitle rule
that ran after normalisation had already eaten the colon, and a pure-recall
overlap score that rated *Lektürehilfen Franz Kafka Der Prozess* a perfect
match for the novel. The third is why `wordOverlap` mixes in a quarter of
the precision.

`RL_LOOKUP` (namespace 1008, 60/min) is the first ceiling here that
protects somebody else's service rather than ours. The client paces itself
at one lookup a second and stops on a 429, picking up where it left off.

**The Wikipedia lookup does not go through Wikidata**, though the first cut
did and the reasoning was good — being a book is a P31 statement, and
sitelinks name the same work's article in every language. It failed for a
dull reason: `wbsearchentities` is a *prefix* search over labels, and the
German article for Der Prozess is titled "Der Process", so the query
diverged at the eighth character and matched nothing. German orthography
reformed in 1996; half the canon has two spellings. It now searches the
language Wikipedia's full-text index and verifies the hit instead — the
author must be named in the opening, and the Wikidata one-line description
decides between the novel and the 1962 Orson Welles film, which also names
Kafka in its first sentence.

**`/api/lookup` is a POST although it reads.** It shipped as a GET and that
was wrong: GETs are exempt from `requireSameOrigin` because they are
assumed to change nothing, and the session cookie is `SameSite=Lax`, which
is withheld from a cross-site image or fetch but *sent* on a top-level
navigation. A link somebody clicked would therefore have spent their lookup
budget — and Open Library's — on a search of the attacker's choosing.
Nothing private was exposed either way, since the answer is a public
catalogue record, but a request with four outbound side effects is not a
GET. As a POST it is same-origin only and unreachable by link.

**Schema change:** `npm run db:local` is needed for local dev. Remote is
automatic via `predeploy` — **but only when you deploy with `npm run
deploy`.** `npx wrangler deploy` skips npm's pre-hook and ships the Worker
against a database that has never seen `edition_cache`. That is now the
second time a table has gone missing in prod this way (`ratings` was the
first), so the lookup no longer depends on the cache existing: `readCache`
and `writeCache` catch "no such table", warn with the command that fixes
it, and carry on uncached. `GOOGLE_BOOKS_KEY` is an optional secret —
unkeyed requests work; set it if lookups start coming back empty.

**The palette's white test is on the lowest channel, not the highest.**
White is every channel high; a saturated red is (250, 40, 40) and its
highest channel is as high as white's. Testing the maximum discarded
exactly the vivid covers the feature exists for — and silently, because an
empty palette is indistinguishable from a failed lookup, so the spine came
out mood-grey as though nothing had been found. `isPaperOrInk` is exported
purely so `tests/edition.test.mts` can pin it. There is a second pass that
takes every pixel when the first finds nothing, so an all-cream literary
paperback comes back cream rather than empty.

`EXTRACT_VERSION` in `src/meta/editions.ts` is how a fix like that reaches
rows already cached: bump it and older rows are treated as absent. Cheap
because the server's cache is untouched, so a re-fetch costs one call to
our own Worker and nothing to anybody else's service.

**No `langRestrict` on the Google query.** It is a hard filter and the
language it would be given is often a guess — a book logged by hand has no
EPUB to declare one, so the client falls back to `navigator.language`, and
an English novel on a German iPad was being searched for among German
editions only. The preference survives as the small bonus in `score`.

**The shelf tells you why it is empty.** Failing soft is right — a book
without a cover still draws — but the first cut failed soft *and* silently,
so signed out, no endpoint, offline, rate-limited and a 500 all looked
identical: press Shelf, nothing happens. `LookupTrouble` in
`src/meta/editions.ts` keeps the reason and the tab prints it, and a 5xx
passes the Worker's own sentence through rather than replacing it with
something vaguer. Two traps found doing this: `vite dev` answers `/api`
with the app's own `index.html` and a **200** (hence the content-type check
before the body is trusted, and the new dev proxy to wrangler's port), and
a run now stops after three consecutive failures instead of spending a
minute on requests that cannot work.

## The PWA update path

The offline shell used to call `skipWaiting()` in `install` and delete every
other cache in `activate`. That meant a new worker seized the page that was
already open — a page running the *previous* bundle, which still resolves its
lazy chunks by their old hashed names. `tesseract.js` on the first scan is the
one that bites. Those filenames were just dropped from the cache and are gone
from the server too, so the running session breaks and only a reload fixes it.
Meanwhile nothing ever called `registration.update()`, so an iPad PWA that
stays resident for days never checked for a new build in the first place: the
app could both break on update *and* fail to notice one.

Now the worker installs, precaches and waits. `src/pwa/update.ts` polls
(`updateViaCache: 'none'`, on `visibilitychange` and hourly), `UpdateBanner`
offers the waiting build as a pill, and only a tap posts `SKIP_WAITING`. The
reload is driven by `controllerchange` behind a one-shot guard — posting and
reloading together races the swap, and reloading a page the new worker has not
claimed yet just re-runs the old one. The banner is suppressed while a book is
open; the offer keeps.

Three points worth not re-deriving:

- **Navigations are cache-first now, not network-first.** A cache generation
  is self-consistent: the `index.html` in `soluna-<BUILD>` names exactly the
  hashed bundles precached beside it. The network's `index.html` belongs to a
  newer generation, so storing it here leaves a shell whose scripts only
  resolve while online. Freshness is the update check's job, not the fetch
  handler's.
- The precache uses `cache: 'reload'`. Without it `index.html` can be filled
  from the HTTP cache — the new worker installs the shell it is replacing and
  the update visibly does nothing. Hashed assets are immune; `index.html` is
  not.
- **The shell is only ever read from `/`, never from `/index.html`.** See
  below — this one shipped broken.
- `BUILD` is a sha256 of the asset list plus `index.html`, not `Date.now()`.
  Any byte-difference in `sw.js` is a new worker to the browser, so a
  timestamp asked the reader to update to a bit-identical app after every
  rebuild. `public/_headers` already sends `no-cache` for `/sw.js` and
  `/index.html`; the registration option is the belt to that suspenders.

No schema change, so `npm run db:local` is not needed.

### The redirect that took the app down

The first cut of the above was deployed and bricked every install that
accepted the update: `Safari kann die Seite nicht öffnen — Response served by
service worker has redirections`, in the home-screen app and on the web.

Cloudflare's asset router runs `html_handling: auto-trailing-slash`, so
`/index.html` answers **301 → `/`**. `cache.add('/index.html')` follows that
and stores the final response with its `redirected` flag set, and a response
carrying that flag may not be returned for a navigation — the browser rejects
the page outright. The entry had been in the precache all along; making
navigations cache-first is what promoted it from an unused offline fallback
to the only path, so the bug went from invisible to total in one deploy.

Three things came out of it:

- The shell is fetched from `SHELL_DOC = '/'` and nothing else, and every
  response leaving the navigation branch goes through `flatten()`, which
  rebuilds it from its body — `redirected` is a property of the Response
  object, so a copy does not have it.
- `strandedGeneration()`: on install the worker looks through the *other*
  cache generations for a shell carrying that flag, and if it finds one it
  calls `skipWaiting()` without being asked. A page that cannot load cannot
  tap a banner, so wait-for-consent would have stranded those installs
  permanently — the only other way out is clearing website data, which takes
  the reader's local library with it. Reading the flag rather than a list of
  bad build ids means it cannot misfire on a healthy install and needs no
  maintenance once the poisoned generations are gone.
- `BUILD` now hashes `sw.js` too. It did not, and a worker-only fix leaves the
  assets untouched — so the fixed worker named its cache after the generation
  it was replacing, and `strandedGeneration()` skipped it as its own. Caught
  by the build printing an unchanged id, not by anything cleverer.

`tests/sw.test.mts` evaluates `public/sw.js` against stand-in globals and a
fake Cloudflare that redirects `/index.html` the way the real one does. It
fails on the code as shipped. A worker cannot be typechecked into correctness
and a build will not exercise it, so this is the only layer that would have
caught it.

## Renamed from Lumen to Soluna

The app is Soluna, the project is Soluna Reader, the domain is
`readsoluna.com`. `RENAME.md` is the full record and should be deleted once
the migration is finished.

Two things not to re-derive. First, the persisted keys were renamed along
with everything else — the Dexie database, `localStorage`, the session
cookie, the SW cache, the `soluna:changed` event. That is normally data
loss, and it was free exactly once, because renaming the Worker changes the
origin and all four of those are scoped per origin. Second, `database_id`
in `wrangler.jsonc` is a **placeholder on purpose** and deploys fail until
`scripts/rename-to-soluna.sh` has run and its output is pasted in. A valid
old id there would ship the renamed Worker against the old database
silently, which is worse than a failed deploy.

The script copies R2 objects as well as D1 rows, and takes the object keys
from `books.file_path` / `books.cover_path` rather than listing the bucket.
Rows without objects would be a library where every download 404s —
`file_path` is what marks a book as uploaded.

## Rate limiting

`worker/limit.ts` gates every `/api` and `/auth` request ahead of the router,
so ahead of the session lookup — a rejected request costs no query. Counters
are Cloudflare rate limiting bindings in `wrangler.jsonc` (edge-local, free,
10s or 60s windows only, per-location), never D1: a limiter storing counters
in the database it protects adds queries to every request it inspects.

Seven bindings, namespaces 1001–1007; the table and the reasoning are in
`worker/README.md`. Three points worth not re-deriving:

- Signed-in traffic is keyed by a hash of the session cookie, **unverified**
  — verifying costs the query the gate exists to avoid. A forged cookie
  therefore buys a private budget, and `RL_ADDRESS` (keyed by IP, applied to
  everything) is what makes that worthless. Neither wall works alone.
- **File endpoints deliberately skip the burst wall.** `downloadAll()` and
  the two loops in `syncFiles()` walk whole libraries with nothing pacing
  them, so a legitimate burst is as long as somebody's shelf. Verified live:
  90 consecutive file GETs pass, while `/api/pull` cuts off at exactly 60.
- The magic-link limit **stays in D1** (`rate_limits` table, `auth.ts`). It
  needs a 15-minute window and one global count, because it rations mail
  into someone's inbox rather than load arriving here.

`gate()` fails open with a `console.warn` if a binding is missing, so an
older `wrangler.jsonc` degrades to today's behaviour instead of refusing
every request. No schema change, so `npm run db:local` is not needed.

Not covered, by decision: there is no client-side backoff — the ceilings are
sized so legitimate traffic never meets them, rather than relying on the
client to behave.

## Supabase removed; D1 schema now deploys itself

Jan works solo and only ever runs against Cloudflare, so the Supabase
adapter (`src/sync/adapters/supabase.ts`), the `supabase/` folder, and
`@supabase/supabase-js` are gone. `src/sync/backend.ts` stays as the seam —
a future adapter is a new file behind it, not a rewrite — but `Backend.kind`
is now just `'soluna'` and `src/sync/client.ts` only chooses between the
Worker and `VITE_BACKEND=none`.

The `ratings` table going missing in prod (2026-08-02) was the reminder that
`worker/schema.sql` was never applied automatically — `npm run db:remote`
had to be run by hand after every schema-adding release, and it wasn't.
Fixed by adding `predeploy: npm run db:remote` to `package.json`: npm runs
`pre<script>` hooks automatically ahead of the matching script, so
`npm run deploy` now applies the (idempotent, `create table if not exists`)
schema to remote D1 before `wrangler deploy` runs. A future table can't go
missing in prod the same way again.

## Find your place (the scan feature)

`src/engine/passage.ts` had been sitting unused since PR #3 — fold → shingle
vote → Smith–Waterman, with three gates (min words, min score, and a margin
over the runner-up, which is the gate that actually prevents landing in the
wrong one of two similar passages). What got added around it:

- `src/ocr/recognize.ts` — two ways in. On iPadOS the keyboard's own Scan
  Text writes into the field and no photo is ever taken; elsewhere
  tesseract.js is lazily loaded (own 17 kB chunk), fed a downscaled grey
  canvas, and the canvas is destroyed in a `finally`. **The photo path
  fetches its WASM core and `eng.traineddata` from jsdelivr on first use** —
  vendoring them into `public/` would make it offline at ~15 MB in the shell.
- `src/engine/passageStore.ts` — packs the index as CSR typed arrays
  (~2.5 MB/novel instead of >10 MB of Map overhead), plus `excerptAt` for
  showing the reader the sentence behind an uncertain match.
- `src/scan/session.ts` — build-on-demand, cache, locate, excerpt.
- `src/ui/ScanSheet.tsx` — `ScanPanel` (for callers already inside a Sheet)
  and `ScanSheet` (its own sheet). Entry points: device finish-session sheet,
  device book detail, and library book detail.

Dexie **v5** adds a `passages` table. It is the only table holding no user
data, so it is deliberately outside sync and outside tombstones — losing a
row costs a second of CPU. LRU-evicted against a 24 MB budget; dropped with
the file it describes. No D1/Worker schema change, so `npm run db:local` is
not needed for this feature.

Known rough edge: the first scan of a long novel blocks the main thread for
about a second while the index builds. Moving `buildPassageIndex` into a Web
Worker is the obvious follow-up.

## Stale branches

`feat/page-scan`, `fix/missing-ratings-table`, `feat/device-sync`,
`feat/passage-match`, `feat/ratings`, `backup/scan-to-sync-tangled` are all
merged or superseded — safe to delete once Jan confirms, not deleted
automatically.

# Environment notes

Always run `git fetch origin` before assuming local state is current —
`main` can move if PRs get merged on GitHub directly. `origin/develop` now
exists — it was pushed on 2026-08-02 — so `develop` is no longer local only
and can also move underneath you.

The sandbox mount cannot unlink files by default, which leaves git unable to
clean up its own `.git/*.lock` files and wedges the repo mid-operation. If a
git command fails with "Operation not permitted" or "Another git process
seems to be running", the fix is to enable deletion for the folder and
`rm -f .git/HEAD.lock .git/index.lock`, then re-check `git status` before
carrying on.
