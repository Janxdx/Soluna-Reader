/* Looking a book up in the world.

   ─── why this is on the server ──────────────────────────────────────

   Four reasons, and each one on its own would be enough.

   Google Books does not send CORS headers, so a browser cannot call it at
   all. Open Library asks callers to identify themselves with a descriptive
   User-Agent and gives identified traffic a much higher ceiling — and
   User-Agent is a forbidden header name in `fetch`, so a browser physically
   cannot comply. A Google API key must not be shipped to a client. And the
   answer to "what does Der Prozess look like" is the same for every reader
   on earth, so caching it per user would be paying for the same lookup once
   per account.

   ─── the cache is not per user ──────────────────────────────────────

   `edition_cache` has no `user_id`, which makes it the only table in this
   schema that doesn't — worth stating plainly, because the discipline in
   worker/data.ts is that every statement carries its own `where user_id =
   ?` and this file deliberately does not. It is sound here precisely
   because nothing in the table came from a reader: it is a copy of a public
   catalogue record, keyed by a title and an author that any two people
   might both own. What *is* private is the fact that you looked — so the
   endpoint still requires a session, and nothing anywhere records who asked
   for which key.

   Covers live under a shared `editions/` prefix in R2 for the same reason,
   away from the per-user `${userId}/` objects that hold people's actual
   books.

   ─── what a lookup costs ────────────────────────────────────────────

   Up to four outbound requests on a miss, to services that are free and
   would rather we didn't. So: a miss is cached forever when it found
   something, for a fortnight when it didn't (a book missing from a
   catalogue today may be in it next month, but retrying on every render
   would be rude), every outbound call has a hard timeout, and the endpoint
   sits behind its own rate limit binding — see RL_LOOKUP in limit.ts. */

import type { Env } from './env';
import { HttpError } from './http';

/* ── shapes and matching ───────────────────────────────────────────

   Imported from the front-end's engine rather than restated here, which is
   not the obvious choice for a Worker with its own tsconfig — but the
   alternative was tried and it is worse. A duplicated matcher drifts, and
   it drifts silently: the two copies typecheck independently, the tests
   only ever exercise one of them, and the symptom is a cover that is right
   on the shelf and wrong in the sheet. `src/engine/edition.ts` is pure
   TypeScript with no DOM and no imports, exactly so that it can be shared
   this way, and `tests/edition.test.mts` therefore covers both ends. */

import {
  MATCH_FLOOR,
  normalize,
  normalizeAuthor,
  normalizeTitle,
  scoreCandidate,
  wordOverlap,
  type EditionData,
  type WikiSummary,
} from '../src/engine/edition';

export type { EditionData, WikiSummary };

/* Identifies us to the catalogues. Open Library asks for a name and a way
   to get in touch, and gives traffic that provides one a materially higher
   rate limit than traffic that doesn't. */
const UA = 'Soluna/1.0 (+https://readsoluna.com; reading app)';

/** No outbound call may hold a request open longer than this. */
const TIMEOUT_MS = 6000;

/** A found answer is kept for good; a miss is retried after a fortnight. */
const MISS_TTL = 14 * 24 * 60 * 60_000;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    /* Every caller treats a null as "this catalogue had nothing", which is
       also the right response to it being down: the lookup carries on to
       the next source and the reader gets a shelf rather than an error. */
    return null;
  }
}

interface Want {
  title: string;
  author: string;
  lang: string;
}

const score = (
  want: Want,
  got: { title: string; author: string; language?: string; hasCover?: boolean }
): number => scoreCandidate({ ...want, language: want.lang }, got);

/** Below this the app draws its own spine instead of showing a guess. */
const FLOOR = MATCH_FLOOR;

/* ── Open Library ──────────────────────────────────────────────────
   First because it is a non-profit with no key, no quota tier and a stable
   cover URL keyed by an id it returns inline. Weakest on recent German
   editions, which is what Google is for. */

interface OlDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  number_of_pages_median?: number;
  cover_i?: number;
  publisher?: string[];
  language?: string[];
  isbn?: string[];
  key?: string;
}

/* ISO 639-2/B, which is what Open Library indexes on, from the two-letter
   codes an EPUB declares. Only the languages this app is plausibly read in
   — an unknown code simply goes unrestricted rather than returning nothing. */
const OL_LANG: Record<string, string> = {
  de: 'ger',
  en: 'eng',
  fr: 'fre',
  es: 'spa',
  it: 'ita',
  nl: 'dut',
  pt: 'por',
  sv: 'swe',
  da: 'dan',
  no: 'nor',
  fi: 'fin',
  pl: 'pol',
  ru: 'rus',
  cs: 'cze',
  tr: 'tur',
};

async function fromOpenLibrary(want: Want): Promise<EditionData | null> {
  const q = new URLSearchParams({
    title: want.title,
    limit: '8',
    fields: 'title,author_name,first_publish_year,number_of_pages_median,cover_i,publisher,language,isbn,key',
  });
  if (want.author) q.set('author', want.author);

  const data = await getJson<{ docs?: OlDoc[] }>(`https://openlibrary.org/search.json?${q}`);
  const docs = data?.docs ?? [];
  if (!docs.length) return null;

  const olLang = OL_LANG[want.lang.slice(0, 2)];

  let best: { doc: OlDoc; s: number } | null = null;
  for (const doc of docs) {
    const s = score(want, {
      title: doc.title ?? '',
      author: doc.author_name?.[0] ?? '',
      /* Open Library lists every language the *work* exists in rather than
         the language of one edition, so this asks whether the edition we
         want is among them — which is the useful question anyway. */
      language: olLang && doc.language?.includes(olLang) ? want.lang : undefined,
      hasCover: Boolean(doc.cover_i),
    });
    if (!best || s > best.s) best = { doc, s };
  }
  if (!best || best.s < FLOOR) return null;

  const d = best.doc;
  return {
    key: '',
    title: d.title,
    author: d.author_name?.[0],
    publisher: d.publisher?.[0],
    language: want.lang,
    year: d.first_publish_year,
    pageCount: d.number_of_pages_median,
    isbn: d.isbn?.[0],
    source: 'openlibrary',
    sourceId: d.cover_i ? String(d.cover_i) : d.key,
    score: best.s,
  };
}

const olCoverUrl = (coverId: string): string =>
  /* `default=false` matters: without it a missing cover is answered with a
     placeholder image and a 200, so every book would get the same grey
     rectangle and we would have no way to tell that from a real cover. */
  `https://covers.openlibrary.org/b/id/${encodeURIComponent(coverId)}-L.jpg?default=false`;

/* ── Google Books ──────────────────────────────────────────────────
   Second, and much the better of the two on German editions: it knows
   publishers, series and page counts for books Open Library has never heard
   of. The key is optional — unkeyed requests work and are rationed by
   address, which for one reader's shelf is enough. */

interface GVolume {
  id?: string;
  volumeInfo?: {
    title?: string;
    subtitle?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    pageCount?: number;
    language?: string;
    dimensions?: { height?: string };
    industryIdentifiers?: { type?: string; identifier?: string }[];
    imageLinks?: Record<string, string>;
  };
}

async function fromGoogle(env: Env, want: Want): Promise<EditionData | null> {
  /* Field-qualified rather than a bare string: `intitle:` and `inauthor:`
     turn a search that returns study guides and anthologies into one that
     returns the book. */
  const terms = [`intitle:${JSON.stringify(want.title)}`];
  if (want.author) terms.push(`inauthor:${JSON.stringify(want.author)}`);

  const q = new URLSearchParams({
    q: terms.join(' '),
    maxResults: '8',
    printType: 'books',
  });
  /* Deliberately no `langRestrict`. It is a hard filter, and the language
     it would be given is frequently a guess: a book logged by hand has no
     EPUB to declare one, so the client falls back to the browser's. An
     English novel on a German iPad would then be searched for among German
     editions only, and the right book is excluded outright. The language
     preference survives as the small bonus in `score`, which is the same
     idea applied softly — prefer the reader's edition, never require it. */
  if (env.GOOGLE_BOOKS_KEY) q.set('key', env.GOOGLE_BOOKS_KEY);

  const data = await getJson<{ items?: GVolume[] }>(
    `https://www.googleapis.com/books/v1/volumes?${q}`
  );
  const items = data?.items ?? [];
  if (!items.length) return null;

  let best: { v: GVolume; s: number } | null = null;
  for (const v of items) {
    const info = v.volumeInfo ?? {};
    const s = score(want, {
      title: info.title ?? '',
      author: info.authors?.[0] ?? '',
      language: info.language,
      hasCover: Boolean(info.imageLinks?.thumbnail),
    });
    if (!best || s > best.s) best = { v, s };
  }
  if (!best || best.s < FLOOR) return null;

  const info = best.v.volumeInfo ?? {};
  const isbn = info.industryIdentifiers?.find((i) => i.type === 'ISBN_13' || i.type === 'ISBN_10');

  return {
    key: '',
    title: info.title,
    author: info.authors?.[0],
    publisher: info.publisher,
    /* The subtitle is where a series usually hides on a German edition —
       "Roman" is not one, but "Fischer Klassik" is, and the livery matcher
       only needs the string to contain the publisher's series name. */
    series: info.subtitle,
    language: info.language,
    year: Number(info.publishedDate?.slice(0, 4)) || undefined,
    pageCount: info.pageCount,
    heightMm: parseHeightMm(info.dimensions?.height),
    isbn: isbn?.identifier,
    source: 'google',
    sourceId: best.v.id,
    score: best.s,
  };
}

/** Google states dimensions as strings like "19.00 cm". Anything else is
    ignored rather than guessed at — a wrong height is a wrong shelf. */
function parseHeightMm(raw?: string): number | undefined {
  if (!raw) return undefined;
  const m = /([\d.]+)\s*(cm|mm)/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const mm = m[2].toLowerCase() === 'cm' ? n * 10 : n;
  // a book is not 4 mm tall and it is not a metre tall
  return mm >= 80 && mm <= 400 ? Math.round(mm) : undefined;
}

function googleCoverUrl(volumeId: string): string {
  /* zoom=1 is the 128 px thumbnail the API advertises; zoom=3 is the same
     image at about 800 px and is what the Books web reader itself asks for.
     `edge=curl` is the fake page-curl the thumbnail ships with, which looks
     like damage once the image is used as a cover. */
  return `https://books.google.com/books/content?id=${encodeURIComponent(volumeId)}&printsec=frontcover&img=1&zoom=3`;
}

/* ── Wikipedia ─────────────────────────────────────────────────────

   This went through Wikidata first, on the reasoning that being a book is
   a statement on the item (P31) and that sitelinks name the same book's
   article in every language — so you could find the work, check it really
   is a novel, and follow the link into the reader's language. Sound, and
   it does not work, for a dull reason: `wbsearchentities` is a *prefix*
   search over labels and aliases. The German article for Der Prozess is
   titled "Der Process", so the query diverged at the eighth character and
   matched nothing at all. Kafka is not an edge case here; German
   orthography reformed in 1996 and half the canon has two spellings.

   So: search the language Wikipedia itself, which is a full-text index and
   forgiving of exactly that, then verify what came back. The verification
   is the part that matters, because a title search alone will hand you the
   1962 Orson Welles film, or a disambiguation page, as happily as the
   novel.

   Two checks do it. The author has to be named in the article's opening —
   an article about a book always names its author in the first sentence.
   And the one-line description, which the REST summary carries from
   Wikidata, decides between the novel and the film adaptation that also
   names Kafka in its first line. */

interface WpSearchHit {
  title?: string;
}

interface WpSummary {
  title?: string;
  description?: string;
  extract?: string;
  type?: string;
  content_urls?: { desktop?: { page?: string } };
}

/* Words that mean "this article is about a written work", and words that
   mean "this is the film of it". Both lists are matched against the
   Wikidata description, which is short, structured and written to exactly
   this purpose — "Roman von Franz Kafka", "1962 film by Orson Welles". */
const WORK_WORDS = /\b(roman|novel|book|buch|erzahlung|novelle|werk|literary|literatur|kurzgeschichte|drama|theaterstuck|gedicht|poem|play|trilogie|trilogy|saga|memoir|sachbuch|essay)\b/;
const NOT_WORK_WORDS = /\b(film|movie|opera|oper|serie|series|album|song|lied|videospiel|video game|musical|band|painting|gemalde)\b/;

async function summaryFor(lang: string, title: string): Promise<WpSummary | null> {
  return getJson<WpSummary>(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  );
}

/** Search one language Wikipedia and return the best verified summary. */
async function wikipediaIn(lang: string, want: Want): Promise<WikiSummary | null> {
  const search = await getJson<{ query?: { search?: WpSearchHit[] } }>(
    `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({
      action: 'query',
      list: 'search',
      /* Title and author together. The author is what separates the novel
         from the seventeen other things called Der Prozess, and a
         full-text index weights both. */
      srsearch: `${want.title} ${want.author}`.trim(),
      srlimit: '5',
      format: 'json',
      origin: '*',
    })}`
  );

  const hits = (search?.query?.search ?? [])
    .map((h) => h.title)
    .filter((t): t is string => Boolean(t));
  if (!hits.length) return null;

  /* The author's surname, which is the longest word in the name often
     enough to be a decent guess and is what an opening sentence uses.
     Empty when there is no author, in which case the check is skipped —
     a book with no author on the shelf is rare and not worth refusing. */
  const surname = normalizeAuthor(want.author)
    .split(' ')
    .sort((a, b) => b.length - a.length)[0];

  let best: { summary: WpSummary; s: number } | null = null;

  for (const title of hits.slice(0, 4)) {
    const summary = await summaryFor(lang, title);
    if (!summary?.extract || summary.type === 'disambiguation') continue;

    const description = normalize(summary.description ?? '');
    const opening = normalize(summary.extract.slice(0, 400));

    /* An article about a book names its author in the first sentence. An
       article that never mentions them is about something else, however
       well the title matched. */
    if (surname && !opening.includes(surname) && !description.includes(surname)) continue;

    let s = wordOverlap(normalizeTitle(want.title), normalizeTitle(summary.title ?? ''));
    if (WORK_WORDS.test(description)) s += 0.6;
    /* The film of the book mentions the author too, and often matches the
       title exactly. This is the check that keeps Orson Welles off the
       rating sheet. */
    if (NOT_WORK_WORDS.test(description)) s -= 0.8;

    if (!best || s > best.s) best = { summary, s };
  }

  if (!best || best.s <= 0) return null;

  const title = best.summary.title ?? hits[0];
  return {
    lang,
    title,
    /* Two or three sentences. The REST summary is already the lead
       paragraph, but a lead paragraph on a famous novel runs to eight
       lines, which is longer than anybody reads on a rating card. */
    extract: trimSentences(best.summary.extract ?? '', 3),
    url:
      best.summary.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

async function fromWikipedia(want: Want): Promise<WikiSummary | null> {
  const lang = want.lang.slice(0, 2).toLowerCase() || 'en';

  const own = await wikipediaIn(lang, want);
  if (own) return own;

  /* English as a fallback, because an article the reader can read beats an
     empty card — and the summary carries the language it is actually in,
     so the sheet can say why it is not German. */
  return lang === 'en' ? null : wikipediaIn('en', want);
}

function trimSentences(text: string, max: number): string {
  const parts = text.split(/(?<=[.!?])\s+/);
  const out = parts.slice(0, max).join(' ').trim();
  return out.length > 480 ? `${out.slice(0, 477).trimEnd()}…` : out;
}

/* ── covers ────────────────────────────────────────────────────────
   Fetched here, stored in R2, and served back to the client from our own
   origin. Same-origin is not a detail: an <img> from covers.openlibrary.org
   taints a canvas, and a tainted canvas cannot be read — which would mean
   no colour palette, which is most of what the covers are *for*. */

const MIN_COVER_BYTES = 3000;
const MAX_COVER_BYTES = 4 * 1024 * 1024;

async function storeCover(env: Env, slug: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'image/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;

    const bytes = await res.arrayBuffer();
    /* Both catalogues answer "no cover" with a tiny image rather than a
       404 under some conditions — a 1×1 gif from Google, a 43-byte
       placeholder from Open Library. Neither is worth a round trip to
       discover on the client, and both look like a broken app on a shelf. */
    if (bytes.byteLength < MIN_COVER_BYTES || bytes.byteLength > MAX_COVER_BYTES) return null;

    const path = `editions/${slug}.cover`;
    await env.BOOKS.put(path, bytes, { httpMetadata: { contentType: type } });
    return path;
  } catch {
    return null;
  }
}

/* ── the cache ─────────────────────────────────────────────────────── */

interface CacheRow {
  payload: string;
  fetched_at: number;
}

/* The cache fails open, loudly, the way `gate()` in limit.ts does.

   A deployment whose database predates this feature should look up
   editions slowly rather than not at all: the cache is an optimisation for
   somebody else's rate limit, and losing it costs a round trip, while
   letting its absence throw costs the entire feature. This has now been
   the failure twice — `ratings` in 2026-08, and `edition_cache` right
   after — and both times the cause was a deploy that skipped the schema.
   `npm run deploy` applies it via `predeploy`; `npx wrangler deploy` does
   not, and there is no way to make it. So the code stops depending on it. */
function cacheUnavailable(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  if (/no such table/i.test(message)) {
    console.warn(
      'edition_cache is missing — lookups work but nothing is cached. ' +
        'Apply worker/schema.sql: `npm run db:remote` (or deploy with `npm run deploy`).'
    );
    return true;
  }
  return false;
}

async function readCache(env: Env, key: string): Promise<EditionData | null> {
  let row: CacheRow | null = null;
  try {
    row = await env.DB.prepare(
      'select payload, fetched_at from edition_cache where key = ?'
    )
      .bind(key)
      .first<CacheRow>();
  } catch (e) {
    if (!cacheUnavailable(e)) throw e;
    return null;
  }
  if (!row) return null;

  let data: EditionData;
  try {
    data = JSON.parse(row.payload) as EditionData;
  } catch {
    return null;
  }

  /* A hit stays a hit forever: a novel's publisher and page count do not
     change, and re-asking would spend somebody else's quota to learn the
     same thing twice. A miss is worth retrying eventually, because a book
     absent from a catalogue this month may be in it next month. */
  const empty = !data.source && !data.wiki;
  if (empty && Date.now() - row.fetched_at > MISS_TTL) return null;

  return data;
}

async function writeCache(env: Env, key: string, data: EditionData): Promise<void> {
  try {
    await env.DB.prepare(
      `insert into edition_cache (key, payload, fetched_at) values (?, ?, ?)
         on conflict(key) do update set payload = excluded.payload, fetched_at = excluded.fetched_at`
    )
      .bind(key, JSON.stringify(data), Date.now())
      .run();
  } catch (e) {
    /* Same as the read: an answer we cannot store is still an answer, and
       the reader gets their cover. Only the next lookup is slower. */
    if (!cacheUnavailable(e)) throw e;
  }
}

/* ── the endpoint ──────────────────────────────────────────────────── */

/**
 * Everything known about a book, from cache when possible.
 *
 * `key` and `slug` are computed by the client (src/engine/edition.ts) and
 * passed in rather than derived here, so that the identity of a book is
 * defined in exactly one place. They are validated, not trusted: the slug
 * becomes an object name.
 */
export async function lookupEdition(
  env: Env,
  params: { key: string; slug: string; title: string; author: string; lang: string }
): Promise<EditionData> {
  const { key, slug } = params;
  if (!key || key.length > 200) throw new HttpError(400, 'Bad edition key.');
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new HttpError(400, 'Bad edition slug.');
  if (!params.title.trim()) throw new HttpError(400, 'A title is required.');

  const cached = await readCache(env, key);
  if (cached) return cached;

  const want: Want = {
    title: params.title.slice(0, 200),
    author: params.author.slice(0, 200),
    lang: (params.lang || 'en').slice(0, 5),
  };

  /* Both catalogues, then the better answer — rather than Open Library and
     Google only as a fallback. They disagree about which books they know
     well, and the score is the whole point of having one. Run together
     because they are independent and a lookup already costs a second. */
  const [ol, google, wiki] = await Promise.all([
    fromOpenLibrary(want),
    fromGoogle(env, want),
    fromWikipedia(want),
  ]);

  const bestCatalogue =
    ol && google ? ((google.score ?? 0) >= (ol.score ?? 0) ? google : ol) : (google ?? ol);

  const data: EditionData = { ...(bestCatalogue ?? {}), key };
  if (wiki) data.wiki = wiki;

  /* Page count and height are facts about a printing, and Google carries
     them far more often than Open Library does. If the two agree on which
     book this is, take the physical details from whichever one has them —
     the shelf is drawn from these numbers. */
  if (bestCatalogue && ol && google) {
    data.pageCount ??= google.pageCount ?? ol.pageCount;
    data.heightMm ??= google.heightMm;
    data.publisher ??= google.publisher ?? ol.publisher;
    data.isbn ??= google.isbn ?? ol.isbn;
  }

  if (bestCatalogue?.sourceId) {
    const url =
      bestCatalogue.source === 'google'
        ? googleCoverUrl(bestCatalogue.sourceId)
        : /^\d+$/.test(bestCatalogue.sourceId)
          ? olCoverUrl(bestCatalogue.sourceId)
          : null;
    if (url) {
      const path = await storeCover(env, slug, url);
      /* Fall back to the other catalogue's cover rather than none: a match
         good enough to trust for a publisher is good enough for a picture,
         and Open Library holds scans of old editions Google has no image
         for at all. */
      if (path) data.coverPath = path;
      else if (bestCatalogue.source === 'google' && ol?.sourceId && /^\d+$/.test(ol.sourceId)) {
        const alt = await storeCover(env, slug, olCoverUrl(ol.sourceId));
        if (alt) data.coverPath = alt;
      }
    }
  }

  await writeCache(env, key, data);
  return data;
}

/** The stored cover for an edition, or 404. Same-origin, so the client can
    read its pixels; see the note on canvas tainting above. */
export async function editionCover(env: Env, slug: string): Promise<Response> {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw new HttpError(400, 'Bad edition slug.');

  const object = await env.BOOKS.get(`editions/${slug}.cover`);
  if (!object) throw new HttpError(404, 'No cover stored.');

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  /* Public, unlike the per-user file route: this is a catalogue image, it
     is identical for every reader, and it never changes for a given slug —
     the slug is a hash of the title and author it was fetched for. */
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}
