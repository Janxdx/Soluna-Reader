/* Getting an edition, and only ever once.
 *
 * Three caches sit in front of every network call, and each exists for a
 * different failure:
 *
 *   the in-flight map   two spines rendering at the same moment ask for the
 *                       same book, and without this they both fetch it
 *   Dexie               so the shelf draws instantly on the next launch,
 *                       and at all when the iPad is offline
 *   D1, on the server   so a second device — and a second reader — never
 *                       troubles Open Library for a book already looked up
 *
 * Everything here fails soft. An edition that cannot be fetched is not an
 * error state in the UI; it is a book drawn the way the app drew every book
 * before this feature existed. That is the whole contract, and it is why
 * none of these functions reject.
 */

import { db, trimEditionCache, type EditionRecord } from '../db';
import { editionKey, editionSlug, type EditionData } from '../engine/edition';
import { extractEdgeStrip, extractPalette } from './palette';

/**
 * Which generation of this code wrote a cached row.
 *
 * Bump it whenever the *client's* processing of a lookup changes in a way
 * that would give a different answer for the same catalogue data — a new
 * palette extractor, a new field read off the response. Rows below it are
 * treated as missing and fetched again.
 *
 * The server's own cache is untouched by this, so a re-fetch costs one
 * round trip to our Worker and nothing to Open Library or Google. That is
 * what makes throwing the local rows away cheap enough to be the default
 * answer, rather than something to agonise over.
 *
 *   1  the first version
 *   2  the palette's white test used the highest channel instead of the
 *      lowest, so every saturated colour was discarded as paper and vivid
 *      covers came back with no palette at all
 *   3  adds edgeTexture — a blurred strip off the cover's own edge that a
 *      spine with no livery is now drawn in, rather than the flat ground
 *      `groundFrom` reduces the palette to; see extractEdgeStrip
 */
export const EXTRACT_VERSION = 3;

const stale = (row: EditionRecord): boolean => (row.v ?? 1) < EXTRACT_VERSION;

/* ── the network ───────────────────────────────────────────────────── */

/** Set once the server says no. See `paused` below. */
let pausedUntil = 0;

/* Why the last lookup produced nothing.
 *
 * Failing soft is right — a book without a cover must still draw — but the
 * first cut failed soft *and silently*, which is a different thing and a
 * worse one. Every way this can go wrong looks identical from the shelf:
 * you switch to the realistic mode and nothing happens. Signed out, an old
 * Worker without the endpoint, the vite dev server answering /api with the
 * app's own index.html — all of them, in the end, "nothing happens".
 *
 * So the reason is kept and shown. `catalogue` is the one that is not a
 * fault: the lookup worked and the book simply is not in any of them. */
export type TroubleKind =
  | 'signed-out'
  | 'no-endpoint'
  | 'offline'
  | 'rate-limited'
  /** the Worker answered, and said what was wrong — pass its words on */
  | 'server';

export interface LookupTrouble {
  kind: TroubleKind;
  /** the server's own sentence, when it sent one */
  detail?: string;
}

let trouble: LookupTrouble | null = null;

/** Why the shelf is not filling in, or null when nothing is wrong. */
export const lookupTrouble = (): LookupTrouble | null => trouble;

/* Every endpoint here answers an error as `{ error }` — including the one
   case worth naming out loud, a database whose schema predates a feature.
   `toResponse` in worker/http.ts turns "no such table: edition_cache" into
   a sentence that says which command fixes it, and throwing that away in
   favour of a generic "couldn't load covers" is how a two-minute problem
   becomes an evening. Read the body before deciding what happened. */
async function serverSaid(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: string } | null;
    return body?.error;
  } catch {
    return undefined;
  }
}

async function fetchEdition(
  key: string,
  title: string,
  author: string,
  lang: string
): Promise<EditionData | null> {
  let res: Response;
  try {
    /* POST rather than GET, and not because anything is written here: a
       miss makes four outbound requests and stores an object, which is not
       what a GET promises. It also means the Worker's same-origin check
       applies, so this cannot be triggered by a link. See worker/index.ts. */
    res = await fetch('/api/lookup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, slug: editionSlug(key), title, author, lang }),
    });
  } catch {
    trouble = { kind: 'offline' };
    return null;
  }

  if (res.status === 401) {
    /* The endpoint needs a session. It is not reading anything private —
       the answer is a public catalogue record — but it makes outbound
       requests to three other people's services, and doing that for an
       anonymous caller is how you become their rate limit problem. */
    trouble = { kind: 'signed-out' };
    return null;
  }

  if (res.status === 429) {
    /* The lookup ceiling, doing its job. Enriching a shelf for the first
       time is the one moment this can happen — sixty books at one a second
       against a sixty-a-minute ceiling has no headroom for a sync landing
       in the middle of it. Backing off for a minute and picking up where we
       left off is nearly invisible: the shelf fills in a little more each
       time it is opened, and every answer already collected is on disk. */
    pausedUntil = Date.now() + 60_000;
    trouble = { kind: 'rate-limited' };
    return null;
  }

  if (!res.ok) {
    /* A 5xx means the Worker is there and something inside it went wrong,
       which is a different problem from the endpoint not existing — and it
       is the case where the server has already written the useful
       sentence. A missing `edition_cache` lands here and says so. */
    const detail = await serverSaid(res);
    trouble = detail
      ? { kind: 'server', detail }
      : { kind: 'no-endpoint' };
    return null;
  }

  /* A 200 is not enough on its own, and this is the check that would have
     saved an evening. `vite dev` has no Worker behind it, so it answers
     /api/lookup with the app's own index.html and a perfectly good 200 —
     and the deployed app does the same for any path the Worker does not
     claim, because the asset router falls through to the SPA shell. Both
     then fail inside `res.json()`, where a parse error is indistinguishable
     from a book nobody has heard of. Ask what it actually is instead. */
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    trouble = { kind: 'no-endpoint' };
    return null;
  }

  try {
    const data = (await res.json()) as EditionData;
    trouble = null;
    return data;
  } catch {
    trouble = { kind: 'no-endpoint' };
    return null;
  }
}

async function fetchCover(coverPath: string): Promise<Blob | null> {
  /* The path comes back as `editions/<slug>.cover`; the route wants the
     slug alone. Derived rather than stored twice so there is one spelling
     of an object name in the system. */
  const slug = coverPath.replace(/^editions\//, '').replace(/\.cover$/, '');
  try {
    const res = await fetch(`/api/editions/cover/${encodeURIComponent(slug)}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/** True while the server has told us to slow down. Callers use it to stop a
    shelf-wide run early rather than making sixty requests that all 429. */
export const paused = (): boolean => Date.now() < pausedUntil;

/* ── the cache in front of it ──────────────────────────────────────── */

/* Two spines for the same book render in the same tick often enough — a
   library entry and the rating of it — that without this they each start a
   fetch and each write the row. */
const inFlight = new Map<string, Promise<EditionRecord | null>>();

/** What the shelf reads. A row already on disk, or nothing. */
export async function cachedEdition(key: string): Promise<EditionRecord | null> {
  return (await db.editions.get(key)) ?? null;
}

/**
 * The edition for a book, fetching it if this device has never seen it.
 *
 * `lang` should be the language of the *edition* — `dc:language` from the
 * EPUB where there is one. It decides which Wikipedia answers and which
 * way the title runs on the spine, so guessing it from the interface
 * language would put English summaries on German books.
 */
export async function ensureEdition(
  title: string,
  author: string,
  lang = 'en'
): Promise<EditionRecord | null> {
  if (!title.trim()) return null;

  const key = editionKey(title, author);

  const existing = await db.editions.get(key);
  if (existing && !stale(existing)) {
    /* Touch, but don't await it — this is on the render path and the LRU
       stamp being a moment late costs nothing. */
    void db.editions.update(key, { usedAt: Date.now() }).catch(() => {});
    return existing;
  }

  if (paused()) return null;

  const started = inFlight.get(key);
  if (started) return started;

  const run = load(key, title, author, lang).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function load(
  key: string,
  title: string,
  author: string,
  lang: string
): Promise<EditionRecord | null> {
  /* Nothing is written to Dexie on a failure. An empty row would be
     indistinguishable from "this book is not in any catalogue" — which is
     a row we *do* write, so the app stops asking — and the app would then
     never try again for a book it simply could not reach today. */
  const data = await fetchEdition(key, title, author, lang);
  if (!data) return null;

  let cover: ArrayBuffer | undefined;
  let coverType: string | undefined;
  let palette: string[] | undefined;
  let edgeTexture: string | undefined;

  if (data.coverPath) {
    const blob = await fetchCover(data.coverPath);
    if (blob) {
      /* Both read from the Blob while we still hold it, before it is
         drained to bytes. Doing it later would mean rebuilding a Blob from
         the stored ArrayBuffer on every launch — the extraction is cheap
         but it is not free, and the answer never changes. */
      const swatches = await extractPalette(blob);
      if (swatches.length) palette = swatches.map((s) => s.hex);
      edgeTexture = (await extractEdgeStrip(blob)) ?? undefined;

      /* Drained to bytes rather than stored as the Blob: IndexedDB refuses
         a blob whose backing is still held elsewhere and takes the
         surrounding transaction down with it. Same reason as CoverRecord. */
      cover = await blob.arrayBuffer();
      coverType = blob.type || 'image/jpeg';
    }
  }

  const derived: Partial<EditionData> = {
    ...(palette ? { palette } : {}),
    ...(edgeTexture ? { edgeTexture } : {}),
  };

  const now = Date.now();
  const record: EditionRecord = {
    key,
    v: EXTRACT_VERSION,
    data: Object.keys(derived).length ? { ...data, ...derived } : data,
    ...(cover ? { cover, coverType } : {}),
    fetchedAt: now,
    usedAt: now,
    size: (cover?.byteLength ?? 0) + 600,
  };

  try {
    await db.editions.put(record);
    void trimEditionCache().catch(() => {});
  } catch {
    /* Storage full, or a private-mode browser refusing to persist. The
       record is still returned and still drawn — it simply has to be
       fetched again next launch. */
  }

  return record;
}

/** The stored cover as something an `<img>` can show. */
export const editionCoverBlob = (row: EditionRecord): Blob | null =>
  row.cover ? new Blob([row.cover], { type: row.coverType || 'image/jpeg' }) : null;

/* ── filling a shelf ───────────────────────────────────────────────── */

/** Between lookups, when walking a whole shelf. One a second is well under
    the server's ceiling and far under what the catalogues ask for; the run
    is invisible because the books already fetched draw immediately. */
const PACE_MS = 1000;

/**
 * Fetch every edition a shelf needs, slowly, in the background.
 *
 * Sequential and paced rather than `Promise.all`, which is the difference
 * between a polite client and sixty simultaneous requests to a charity's
 * search endpoint. Stops at the first sign of a ceiling and leaves the rest
 * for next time — the shelf is usable throughout, filling in as it goes.
 *
 * Returns the number of books it actually fetched, so a caller can tell
 * whether anything changed and re-render once at the end.
 */
export async function fillShelf(
  books: { title: string; author: string; lang?: string }[],
  onProgress?: () => void
): Promise<number> {
  let fetched = 0;
  let missed = 0;

  for (const book of books) {
    if (paused()) break;
    if (!book.title.trim()) continue;

    const key = editionKey(book.title, book.author);
    const have = await db.editions.get(key);
    if (have && !stale(have)) continue;

    const row = await ensureEdition(book.title, book.author, book.lang);
    if (row) {
      fetched++;
      onProgress?.();
    } else {
      /* Three failures in a row is not a run of obscure books, it is the
         endpoint. Stopping is the point: without it a shelf of sixty
         unreachable books spends a minute making sixty requests that
         cannot work, and the reader watches a progress line that never
         progresses. */
      if (++missed >= 3 && lookupTrouble()) break;
    }

    await new Promise((r) => setTimeout(r, PACE_MS));
  }

  return fetched;
}
