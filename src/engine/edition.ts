/* Editions: what a book looks like in the world, as opposed to what you
 * thought of it.
 *
 * A rating already carries a title and an author, copied in at write time
 * and never refreshed — that is what lets a verdict outlive the file. What
 * it does not carry is anything about the *object*: who published it, how
 * thick it is, what colour the cloth was, what the thing is even about.
 * None of that is a property of the verdict, and none of it is user data;
 * it is a fact about a book that anybody could look up. So it lives in its
 * own record, keyed by title and author rather than by rating id, and one
 * lookup serves the library shelf, the device shelf and a rating whose book
 * has since been deleted.
 *
 * Framework-free, like the rest of `engine/`: pure functions over plain
 * data, so the matching rules and the spine geometry can be tested without
 * a DOM, a database or a network.
 */

/* ── identity ─────────────────────────────────────────────────────
 *
 * The key has to be derivable on any device from the two strings a rating
 * already holds, or a second iPad would look the same book up again and
 * store it under a different name. So: no ids, no counters, no clock —
 * normalise hard and concatenate.
 */

/** Strip everything that varies between two spellings of the same book. */
export function normalize(s: string): string {
  return (
    s
      .toLowerCase()
      /* Before NFD, because ß has no decomposition — it is a letter, not an
         s with a mark on it, so stripping combining marks leaves it intact
         and the next rule deletes it outright. "Der Prozeß" would become
         "proze" and never match the "Prozess" of a modern edition. This one
         line is the difference between one book and two on a German shelf. */
      .replace(/ß/g, 'ss')
      .normalize('NFD')
      /* Combining marks, so "Kafka" and "Kafká" and a title typed without
         umlauts all land together. German readers type "Fraulein" for
         "Fräulein" often enough that this is the difference between a hit
         and a miss. */
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[‘’'`´]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

/* Leading articles are dropped from titles but never from authors: "Der
   Prozess" and "Prozess" are one book, while an author whose name starts
   with "Die" is having their name mangled. */
const ARTICLES = /^(der|die|das|ein|eine|the|a|an|le|la|les|il|el)\s+/;

/** A title reduced to what two catalogue entries for the same book share. */
export function normalizeTitle(title: string): string {
  /* Subtitles are where editions disagree most — the same novel is sold as
     "Solaris" by one publisher and "Solaris: Roman" by the next. Everything
     after a colon or a dash goes, unless that would leave nothing.

     Cut *before* normalising, which is the whole trick: `normalize` turns
     every punctuation mark into a space, so a cut made afterwards has no
     colon left to find and silently does nothing. */
  const cut = title.split(/\s+[-–—]\s+|\s*:\s*/)[0];
  const t = normalize(cut && normalize(cut).length >= 3 ? cut : title);
  return t.replace(ARTICLES, '');
}

/** An author reduced the same way, surname last and initials collapsed. */
export function normalizeAuthor(author: string): string {
  const a = normalize(author);
  /* "Le Guin, Ursula K." and "Ursula K. Le Guin" are one person. Sorting
     the words removes the ordering question entirely, and the single
     letters go because "K." is present in one catalogue and absent in the
     other about half the time. */
  return a
    .split(' ')
    .filter((w) => w.length > 1)
    .sort()
    .join(' ');
}

/** The stable identity of a book across devices, shelves and catalogues. */
export const editionKey = (title: string, author: string): string =>
  `${normalizeTitle(title)}|${normalizeAuthor(author)}`;

/* FNV-1a, folded twice for sixty-four bits — the same construction as the
   rate limiter's key hash and for the same reason: it must not collide, and
   it must not be async, because this is called while rendering a shelf. */
function fold(input: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The key as one path-safe component.
 *
 * Used as the object name in R2 and as a URL segment, so it may not contain
 * a slash or a dot-dot — see the file route in worker/index.ts, which
 * rejects both. The readable prefix is there so that a bucket listing is
 * something a human can scan; the hash is what actually carries the
 * identity, since truncating a long title would collide two books by the
 * same author whose titles begin the same way.
 */
export function editionSlug(key: string): string {
  const readable = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  const hash = fold(key, 0x811c9dc5).toString(36) + fold(key, 0x7fffffff).toString(36);
  return `${readable || 'x'}-${hash}`;
}

/* ── what a lookup comes back with ────────────────────────────────── */

export interface EditionData {
  /** `editionKey(title, author)` — the identity, not a catalogue's id */
  key: string;
  /** the title as the catalogue spells it, which may beat the EPUB's */
  title?: string;
  author?: string;
  publisher?: string;
  /** e.g. "Fischer Klassik" — often the thing that names the livery */
  series?: string;
  /** ISO 639-1, from the catalogue rather than guessed */
  language?: string;
  year?: number;
  pageCount?: number;
  /** physical height in millimetres, when the catalogue states it */
  heightMm?: number;
  isbn?: string;
  /** which catalogue answered — shown in the sheet, so a wrong match is legible */
  source?: 'openlibrary' | 'google';
  sourceId?: string;
  /** R2 object name under the shared `editions/` prefix, once fetched */
  coverPath?: string;
  /** dominant colours of the cover, darkest first; see meta/palette.ts */
  palette?: string[];
  /** a blurred strip off the cover's own edge, stretched to fill a spine —
      a data URL, used only where no livery applies; see
      meta/palette.ts:extractEdgeStrip and spineLook */
  edgeTexture?: string;
  wiki?: WikiSummary;
  /** how sure the match was, 0–1. Kept so a wrong cover is diagnosable
      rather than mysterious — the client shows it nowhere yet. */
  score?: number;
}

export interface WikiSummary {
  /** the language actually answered in, which may not be the one asked for */
  lang: string;
  title: string;
  extract: string;
  url: string;
}

/* ── matching ──────────────────────────────────────────────────────
 *
 * Every catalogue answers a title-and-author query with a list, and the
 * first entry is not reliably the right one — searching for a well-known
 * novel returns study guides, abridgements and a Portuguese translation
 * before the book. Since the app picks silently, the score has to be good
 * enough that picking silently is defensible, and the threshold has to be
 * high enough that no cover is preferred to a wrong one.
 */

export interface Candidate {
  title: string;
  author: string;
  year?: number;
  pageCount?: number;
  language?: string;
  hasCover?: boolean;
}

/**
 * Word overlap, 0–1.
 *
 * Mostly recall — how much of the query the candidate accounts for — but
 * not purely, and the reason is secondary literature. Pure recall says
 * "Lektürehilfen Franz Kafka Der Prozess" is a perfect match for "Der
 * Prozess", because every word of the query is in there, and a study guide
 * with a cover is then exactly what a shelf fills up with. Weighting in a
 * quarter of the precision — how much of the *candidate* the query accounts
 * for — costs a real subtitle almost nothing and refuses the guide.
 */
export function wordOverlap(query: string, candidate: string): number {
  const q = query.split(' ').filter(Boolean);
  const c = candidate.split(' ').filter(Boolean);
  if (!q.length || !c.length) return 0;

  const have = new Set(c);
  const hits = q.filter((w) => have.has(w)).length;
  if (!hits) return 0;

  const recall = hits / q.length;
  const precision = hits / c.length;
  return recall * 0.75 + precision * 0.25;
}

/**
 * How well a catalogue entry answers the query, 0–1.
 *
 * Title is weighted far above everything else because it is the only field
 * every catalogue fills in consistently — author is missing, abbreviated or
 * given as "et al" often enough that letting it veto a perfect title match
 * would lose more books than it saves.
 */
export function scoreCandidate(
  want: { title: string; author: string; language?: string },
  got: Candidate
): number {
  const t = wordOverlap(normalizeTitle(want.title), normalizeTitle(got.title));
  const a = want.author
    ? wordOverlap(normalizeAuthor(want.author), normalizeAuthor(got.author ?? ''))
    : 0.5;

  let score = t * 0.68 + a * 0.24;

  /* A cover is the point of the exercise, so an entry that has one wins a
     tie against one that does not. Small, because it is a tiebreak and not
     evidence about which book this is. */
  if (got.hasCover) score += 0.05;
  /* Same language as the edition being rated: a German reader's shelf
     should not fill up with the English cover of a book they read in
     German. Also small — a right book in the wrong language still beats a
     wrong book in the right one, which is exactly what these weights say. */
  if (want.language && got.language && got.language.slice(0, 2) === want.language.slice(0, 2)) {
    score += 0.03;
  }

  return Math.min(1, score);
}

/** Below this, the app shows its own generated spine rather than a guess.
    No cover is a neutral outcome; the wrong cover is a bug the reader has
    to notice and correct, so the bar sits where a partial title match on
    its own is not enough. */
export const MATCH_FLOOR = 0.62;

/** The best candidate, or null when none is convincing enough to show. */
export function pickCandidate<T extends Candidate>(
  want: { title: string; author: string; language?: string },
  candidates: T[]
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of candidates) {
    const score = scoreCandidate(want, item);
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= MATCH_FLOOR ? best : null;
}

/* ── liveries ──────────────────────────────────────────────────────
 *
 * Real spines are not available as data. Nobody's catalogue holds a
 * photograph of the side of a book, and the ones that hold a scan hold the
 * front cover only. What *is* available is the publisher and the series —
 * and a series exists precisely so that every book in it looks the same.
 * Ten of these cover most of a German shelf, and the reason they are worth
 * hand-writing is the reason they are recognisable in the first place.
 *
 * A livery is not a picture. It is the handful of decisions that make a
 * publisher's shelf presence: the ground colour, whether there are bands,
 * where the name sits. Drawn in CSS by SpineWall, so it costs no bytes and
 * scales to any thickness.
 */

export type LiveryPattern =
  /** one flat cloth colour, the default binding */
  | 'plain'
  /** Penguin's horizontal thirds: colour, white, colour */
  | 'triband'
  /** a printed panel inset into the ground, the way most paperbacks title */
  | 'panel'
  /** narrow rules at head and foot, edition suhrkamp style */
  | 'rules';

export interface Livery {
  key: string;
  /** what to show in the sheet when explaining where the look came from */
  label: string;
  /** matched against `${publisher} ${series}`, normalised */
  match: RegExp;
  ground: string;
  ink: string;
  accent: string;
  pattern: LiveryPattern;
  /** printed at the foot of the spine, the way a publisher's name is */
  imprint?: string;
  /** typical trim height in mm — a Reclam is visibly shorter than a novel */
  heightMm?: number;
}

/* Ordered: the first match wins, so a series sits above the house that
   publishes it. "suhrkamp taschenbuch" must not be caught by /suhrkamp/
   before `edition suhrkamp` has had a look at it. */
export const LIVERIES: Livery[] = [
  {
    key: 'reclam',
    label: 'Reclams Universal-Bibliothek',
    match: /reclam/,
    /* The most recognisable spine in German publishing, and the easiest to
       get right: there is only one colour and it has not changed since
       1970. Short, too — a Reclam heft standing next to a novel is the
       clearest thing a realistic shelf can show you. */
    ground: '#F2C900',
    ink: '#1A1608',
    accent: '#1A1608',
    pattern: 'rules',
    imprint: 'Reclam',
    heightMm: 148,
  },
  {
    key: 'edition-suhrkamp',
    label: 'edition suhrkamp',
    match: /edition suhrkamp|regenbogen/,
    ground: '#D8452F',
    ink: '#FBF7EE',
    accent: '#FBF7EE',
    pattern: 'rules',
    imprint: 'suhrkamp',
    heightMm: 178,
  },
  {
    key: 'suhrkamp',
    label: 'Suhrkamp / Insel',
    match: /suhrkamp|insel verlag/,
    ground: '#F4EFE3',
    ink: '#26221C',
    accent: '#9C2B22',
    pattern: 'rules',
    imprint: 'suhrkamp',
    heightMm: 190,
  },
  {
    key: 'rowohlt',
    label: 'rororo',
    match: /rowohlt|rororo/,
    ground: '#F6F3EC',
    ink: '#242019',
    accent: '#D8332A',
    pattern: 'panel',
    imprint: 'rororo',
    heightMm: 190,
  },
  {
    key: 'dtv',
    label: 'dtv',
    match: /\bdtv\b|deutscher taschenbuch/,
    ground: '#F7F5F0',
    ink: '#1F1D1A',
    accent: '#E2A200',
    pattern: 'panel',
    imprint: 'dtv',
    heightMm: 191,
  },
  {
    key: 'fischer',
    label: 'S. Fischer',
    match: /fischer/,
    ground: '#EDE7DA',
    ink: '#232019',
    accent: '#1E5C4F',
    pattern: 'panel',
    imprint: 'Fischer',
    heightMm: 190,
  },
  {
    key: 'hanser',
    label: 'Hanser',
    match: /hanser/,
    ground: '#1D2A3A',
    ink: '#F2EDE2',
    accent: '#C9A227',
    pattern: 'plain',
    imprint: 'Hanser',
    heightMm: 205,
  },
  {
    key: 'penguin-classics',
    label: 'Penguin Classics',
    match: /penguin classics|penguin modern/,
    ground: '#0E0D0C',
    ink: '#F3EFE6',
    accent: '#F26A21',
    pattern: 'panel',
    imprint: 'PENGUIN',
    heightMm: 198,
  },
  {
    key: 'penguin',
    label: 'Penguin',
    match: /penguin/,
    /* The tri-band, which is the reason anybody can identify a Penguin from
       across a room. Orange for fiction is the one everybody pictures. */
    ground: '#E8721C',
    ink: '#17140F',
    accent: '#F6F1E4',
    pattern: 'triband',
    imprint: 'PENGUIN',
    heightMm: 198,
  },
  {
    key: 'oxford',
    label: "Oxford World's Classics",
    match: /oxford/,
    ground: '#F4F1E8',
    ink: '#1B2A44',
    accent: '#1B2A44',
    pattern: 'panel',
    imprint: 'OXFORD',
    heightMm: 196,
  },
  {
    key: 'vintage',
    label: 'Vintage',
    match: /vintage|jonathan cape|harvill/,
    ground: '#E7E2D6',
    ink: '#211E19',
    accent: '#8A1B1B',
    pattern: 'rules',
    imprint: 'VINTAGE',
    heightMm: 198,
  },
  {
    key: 'manesse',
    label: 'Manesse',
    match: /manesse/,
    ground: '#2B3B2E',
    ink: '#EFE7D2',
    accent: '#C9A227',
    pattern: 'plain',
    imprint: 'MANESSE',
    heightMm: 168,
  },
];

/** The livery a book is bound in, or null when the publisher isn't one we
    can draw — in which case the cover's own colours are used instead. */
export function liveryFor(edition: Pick<EditionData, 'publisher' | 'series'>): Livery | null {
  const hay = normalize(`${edition.publisher ?? ''} ${edition.series ?? ''}`);
  if (!hay) return null;
  return LIVERIES.find((l) => l.match.test(hay)) ?? null;
}

/* ── how a spine reads ─────────────────────────────────────────────
 *
 * Turn a book on its side and the title has to run one way or the other,
 * and which way is a matter of nationality rather than taste: German,
 * French and most continental spines read downwards, so the title is the
 * right way up when the book lies face-up on a table. English and American
 * spines read upwards, so the title is the right way up on the shelf.
 *
 * Both conventions are ubiquitous in their own countries and both look
 * wrong applied to the other, which is why a shelf that gets this right
 * reads as real before you have worked out why.
 */

export type SpineDirection = 'down' | 'up';

/* Everything not listed reads downwards, which is the continental habit and
   also the safer default: it is what the CSS does without being asked. */
const READS_UP = new Set(['en', 'nl', 'sv', 'no', 'nb', 'nn', 'da', 'fi', 'is']);

export const spineDirection = (language?: string): SpineDirection =>
  language && READS_UP.has(language.slice(0, 2).toLowerCase()) ? 'up' : 'down';

/* ── how big a book is ─────────────────────────────────────────────
 *
 * In the data shelf, height is the score and thickness is the word count:
 * both are honest, neither is physical. The realistic shelf gives those two
 * dimensions back to the object, which is the whole point of it — and the
 * cost, spelled out here so it is a decision rather than an accident: the
 * score is no longer readable from across the room. It comes back as the
 * foil number at the foot, which you have to walk up to and read, the way
 * you would with a real shelf.
 */

/** Trim height in mm when nothing better is known — a mass-market novel. */
export const DEFAULT_HEIGHT_MM = 190;

/**
 * Thickness in millimetres.
 *
 * Bulk is per *leaf*, not per page, and a leaf of ordinary paperback stock
 * runs about 0.11 mm — so a 320-page novel is a shade under 20 mm of paper
 * plus its covers. Estimated from the page count rather than taken from the
 * catalogue because no catalogue publishes a spine width, and page counts
 * are the one physical fact all of them do carry.
 */
export function thicknessMm(pageCount?: number, words?: number): number {
  /* Fall back to the word count the rating already stores, at roughly the
     three hundred words a printed page holds — which is how the device
     shelf turns pages into words in the first place, run backwards. */
  const pages = pageCount ?? (words ? Math.round(words / 300) : 0);
  if (!pages) return 14;
  return Math.max(4, Math.min(70, (pages / 2) * 0.11 + 2.4));
}

export interface SpineMetrics {
  /** css px */
  width: number;
  /** share of the slot height, as a css percentage string */
  height: string;
}

/* Millimetres to pixels. Chosen so a standard 190 mm paperback fills most
   of the slot and a 250 mm art book still fits inside it — the shelf has a
   fixed slot height and a book taller than its shelf is a layout bug, not
   realism. */
const MM_PER_SLOT = 250;
const MIN_W = 12;
const MAX_W = 64;

/** The physical size of a book, for the realistic shelf. */
export function realMetrics(input: {
  heightMm?: number;
  pageCount?: number;
  words?: number;
}): SpineMetrics {
  const h = Math.max(110, Math.min(MM_PER_SLOT, input.heightMm ?? DEFAULT_HEIGHT_MM));
  const w = thicknessMm(input.pageCount, input.words);
  return {
    /* 2.6 px per mm: a 20 mm spine is 52 px, which is about where the
       existing wall tops out, so switching modes moves books rather than
       rebuilding the shelf at a different scale. */
    width: Math.round(Math.max(MIN_W, Math.min(MAX_W, w * 2.6))),
    height: `${((h / MM_PER_SLOT) * 100).toFixed(1)}%`,
  };
}
