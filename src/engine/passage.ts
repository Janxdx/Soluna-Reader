/* Finding your place from a photograph of a page.

   The device shelf asks you for a page number. This asks you for nothing:
   you point the camera at the last page you read, the text is recognised on
   the device, and we find that text in the book. The photograph is never
   stored — on iOS it never even exists, because a focused text field will
   scan straight from the camera into the field.

   Which makes this file a search problem: given forty-odd words that have
   been through OCR, where in a hundred and fifty thousand words did they
   come from? Three stages, each one cheap enough to leave the next with
   little to do:

     fold      strip the text down to a form where OCR's mistakes and the
               book's own typography land in the same place
     seed      hash overlapping five-word shingles and let them vote on a
               region of the book, so all but a handful are eliminated
               without ever comparing a word
     align     Smith–Waterman over the surviving regions, which tolerates
               the dropped and invented words that voting cannot

   The last stage is the only one that decides anything, and what it decides
   is deliberately hard to say yes to. A wrong answer silently rewrites your
   reading position, so a refusal is always cheaper than a guess — see
   `locatePassage` for the three gates a match has to clear.

   No React, no browser APIs, no DOM: this is engine code, and it must run
   in a worker and in a native shell. */

import type { Locus } from './device';
import { HAS_CONTENT } from './tokenize';

export { plainText } from './tokenize';

/* ── folding ───────────────────────────────────────────────────────── */

/* Ligatures a publisher's font bakes into a single glyph, which OCR then
   reads back as one character. Expanding them is not optional: "ﬁrst" and
   "first" have to be the same word before anything else can work. */
const LIGATURES: Record<string, string> = {
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi',
  'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
  æ: 'ae', œ: 'oe', ß: 'ss', ø: 'o', đ: 'd', ł: 'l',
};

/**
 * Reduce a word to the form both sides of the comparison can agree on.
 *
 * The confusions at the end look like vandalism — `rn`→`m` turns "learn"
 * into "leam" — and that is the point. We are not trying to read the word
 * correctly, we are trying to be wrong about it in exactly the same way on
 * both sides, so that OCR's "leam" and the book's "learn" meet. Every rule
 * here costs a little discrimination and buys a lot of tolerance; the
 * alignment stage has enough context to absorb the collisions.
 *
 * Digits only fold when the word also contains letters, so "1984" survives
 * as a year while "l984" doesn't survive as a word.
 */
export function fold(raw: string): string {
  let s = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

  let ligatured = '';
  for (const ch of s) ligatured += LIGATURES[ch] ?? ch;
  s = ligatured;

  // apostrophes and hyphens go entirely: OCR renders them a dozen ways,
  // and "dont" is a perfectly good key for "don't"
  s = s.replace(/[^a-z0-9]+/g, '');
  if (!s) return '';

  if (/[a-z]/.test(s)) {
    s = s.replace(/0/g, 'o').replace(/5/g, 's').replace(/8/g, 'b').replace(/1/g, 'l');
  }

  return s
    .replace(/rn/g, 'm')   // the classic: rn and m are the same ink
    .replace(/vv/g, 'w')
    .replace(/l/g, 'i');   // l, I, i and | are one letter as far as we care
}

/** FNV-1a. Small, fast, no dependencies, and good enough for a bag of words. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function hashShingle(t: Int32Array, at: number, k: number): number {
  let h = 0x811c9dc5;
  for (let j = 0; j < k; j++) {
    h ^= t[at + j];
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** Split text the way `countWords` does, then fold. Tokens that fold away to
    nothing keep their slot, as an empty string — dropping them would shift
    every index after them out of step with the rendered chapter. */
export function foldTokens(text: string): Int32Array {
  const parts = text.split(/\s+/);
  const out: number[] = [];
  for (const p of parts) if (HAS_CONTENT.test(p)) out.push(hashString(fold(p)));
  return Int32Array.from(out);
}

/* ── the index ─────────────────────────────────────────────────────── */

const SHINGLE = 5;

/* A shingle this common is a chapter heading, a refrain, or the publisher's
   boilerplate. It costs time and tells us nothing, so it is dropped. */
const MAX_POSTINGS = 48;

export interface Chapter {
  spineIndex: number;
  /** plain text — use `plainText()` on the chapter's XHTML */
  text: string;
}

export interface PassageIndex {
  /** hash per word, in reading order across the whole book */
  tokens: Int32Array;
  /** first token index of each chapter, ascending */
  spineStarts: number[];
  /** spine index of the chapter starting at the same slot in `spineStarts` */
  spineOf: number[];
  /** shingle hash → token positions where it begins */
  postings: Map<number, number[]>;
}

/**
 * Build the search index for a book. Once per import, in a worker.
 *
 * The result holds hashes rather than words — the alignment only ever asks
 * whether two tokens are equal, and four bytes answers that as well as a
 * string does while costing a fifth of the memory. A 150k-word novel indexes
 * to roughly 3 MB, which is small enough to keep in IndexedDB (the whole
 * structure is structured-cloneable, so Dexie stores it as it stands).
 */
export function buildPassageIndex(chapters: Chapter[]): PassageIndex {
  const tokens: number[] = [];
  const spineStarts: number[] = [];
  const spineOf: number[] = [];

  for (const ch of chapters) {
    spineStarts.push(tokens.length);
    spineOf.push(ch.spineIndex);
    const t = foldTokens(ch.text);
    for (let i = 0; i < t.length; i++) tokens.push(t[i]);
  }

  const all = Int32Array.from(tokens);
  const postings = new Map<number, number[]>();
  for (let i = 0; i + SHINGLE <= all.length; i++) {
    const h = hashShingle(all, i, SHINGLE);
    const list = postings.get(h);
    if (list) list.push(i);
    else postings.set(h, [i]);
  }
  for (const [h, list] of postings) if (list.length > MAX_POSTINGS) postings.delete(h);

  return { tokens: all, spineStarts, spineOf, postings };
}

/* ── cleaning up what the camera saw ───────────────────────────────── */

/**
 * Remove the parts of a page that are not the book: running heads, folios,
 * the chapter title sitting above the text.
 *
 * Only the first and last two lines are eligible for the all-caps rule,
 * because that is where furniture lives and a genuine short line of dialogue
 * in the middle of a page must survive. A line of nothing but digits or
 * roman numerals is furniture wherever it appears.
 */
export function stripFurniture(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((line, i) => {
    const s = line.trim();
    if (!s) return false;
    if (/^[\d\s.,·—–-]+$/.test(s)) return false;                 // folio
    if (/^[ivxlcdm]+$/i.test(s.replace(/[^a-z]/gi, ''))) return false; // roman numeral

    const edge = i < 2 || i >= lines.length - 2;
    if (edge) {
      const words = s.split(/\s+/).filter(Boolean);
      const letters = s.replace(/[^a-zA-Z]/g, '');
      const upper = s.replace(/[^A-Z]/g, '');
      if (words.length <= 5 && letters.length > 0 && upper.length / letters.length > 0.7) {
        return false;
      }
    }
    return true;
  });
  return kept.join('\n');
}

/** Rejoin a word a line break split in half. Printed text hyphenates
    constantly and OCR keeps the hyphen, so without this every page loses
    a handful of its most distinctive words.

    Unicode classes, not `[A-Za-z]`: German breaks after ö and ß as readily
    as after o and s, and an ASCII-only rule left exactly those words —
    "Grö-ßte", "schlie-ßen" — split into two tokens on the OCR side and whole
    on the book's, which misaligns everything after them. The continuation
    still has to be lowercase, so a genuine compound across a break
    ("Berlin-\nBrandenburg") is left as the author set it. */
export function dehyphenate(text: string): string {
  return text.replace(/(\p{L})[-‐‑­]\s*\n\s*(\p{Ll})/gu, '$1$2');
}

/* ── local alignment ───────────────────────────────────────────────── */

const MATCH = 3;
const MISMATCH = -2;
const GAP = -2;

interface Alignment {
  /** tokens of the query that found a partner */
  matches: number;
  /** index in `book` of the last aligned token */
  endsAt: number;
}

/**
 * Smith–Waterman between the query and a window of the book.
 *
 * Local, not global, and that is the whole reason it is here: a page
 * photograph carries a half-line of the previous paragraph, a page number
 * OCR mistook for a word, and a smudge. Local alignment leaves all of it
 * outside the aligned region for free, where a global comparison would
 * count every bit of it against the score.
 *
 * Two rows and no traceback — we need the number of matches and where the
 * alignment ended, both of which can be carried forward in the recurrence.
 */
function align(query: Int32Array, book: Int32Array, from: number, to: number): Alignment {
  const n = query.length;
  const m = to - from;
  if (n === 0 || m <= 0) return { matches: 0, endsAt: from };

  let prevS = new Int32Array(m + 1);
  let prevM = new Int32Array(m + 1);
  let curS = new Int32Array(m + 1);
  let curM = new Int32Array(m + 1);

  let best = 0;
  let bestMatches = 0;
  let bestEnd = from;

  for (let i = 1; i <= n; i++) {
    curS[0] = 0;
    curM[0] = 0;
    for (let j = 1; j <= m; j++) {
      const same = query[i - 1] === book[from + j - 1];
      const diag = prevS[j - 1] + (same ? MATCH : MISMATCH);
      const up = prevS[j] + GAP;
      const left = curS[j - 1] + GAP;

      let s = diag;
      let mt = prevM[j - 1] + (same ? 1 : 0);
      if (up > s) { s = up; mt = prevM[j]; }
      if (left > s) { s = left; mt = curM[j - 1]; }
      if (s <= 0) { s = 0; mt = 0; }

      curS[j] = s;
      curM[j] = mt;

      if (s > best) {
        best = s;
        bestMatches = mt;
        bestEnd = from + j - 1;
      }
    }
    const ts = prevS; prevS = curS; curS = ts;
    const tm = prevM; prevM = curM; curM = tm;
  }

  return { matches: bestMatches, endsAt: bestEnd };
}

/* ── locating ──────────────────────────────────────────────────────── */

/** Below this many recognised words we refuse regardless of how well they
    match: a short quotation can look convincing in the wrong chapter. */
export const MIN_TOKENS = 30;

/** Fraction of the recognised words that must find a partner. */
export const MIN_SCORE = 0.75;

/** How far the best region must beat the next unrelated one. This is the
    gate that matters. Books repeat themselves — refrains, chapter openings,
    "he said nothing" — and a threshold on the score alone will happily send
    you to the wrong one of two identical passages. */
export const MIN_MARGIN = 1.3;

/** Above these, the match is applied without asking. */
const SURE_SCORE = 0.86;
const SURE_MARGIN = 1.6;

/** How far apart two anchors have to be to count as different places. */
const ANCHOR_TOLERANCE = 16;

/** Slack around a candidate region, for words OCR dropped or invented. */
const WINDOW_PAD = 32;

const MAX_CANDIDATES = 6;
const MIN_VOTES = 3;

export interface PassageMatch {
  locus: Locus;
  /** token index, across the book, of the last word we are confident about */
  tokenIndex: number;
  /** 0–1, the share of recognised words that aligned */
  score: number;
  /** score of the best unrelated region; 0 when there wasn't one */
  runnerUp: number;
  /** how many words OCR gave us to work with */
  tokens: number;
  /** `sure` may be applied silently; `review` should be confirmed first */
  confidence: 'sure' | 'review';
}

interface Region { start: number; votes: number }

/* Seeding: every shared shingle votes for a diagonal — the offset between
   where it sits in the query and where it sits in the book. A true match
   piles most of its shingles onto one offset, give or take the drift that
   dropped words cause, so clustering sorted offsets finds the regions worth
   the cost of aligning. */
function seed(index: PassageIndex, query: Int32Array): Region[] {
  const anchors: number[] = [];
  for (let i = 0; i + SHINGLE <= query.length; i++) {
    const posts = index.postings.get(hashShingle(query, i, SHINGLE));
    if (!posts) continue;
    for (const p of posts) anchors.push(p - i);
  }
  if (!anchors.length) return [];
  anchors.sort((a, b) => a - b);

  const regions: Region[] = [];
  let i = 0;
  while (i < anchors.length) {
    let j = i;
    while (j < anchors.length && anchors[j] - anchors[i] <= ANCHOR_TOLERANCE) j++;
    regions.push({ start: anchors[(i + j - 1) >> 1], votes: j - i });
    i = j;
  }

  return regions
    .filter((r) => r.votes >= MIN_VOTES)
    .sort((a, b) => b.votes - a.votes)
    .slice(0, MAX_CANDIDATES);
}

/** Chapter and word-within-chapter for a token index. */
export function locusOf(index: PassageIndex, token: number): Locus {
  const t = Math.max(0, Math.min(token, index.tokens.length - 1));
  let lo = 0;
  let hi = index.spineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.spineStarts[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return {
    spineIndex: index.spineOf[lo],
    wordIndex: t - index.spineStarts[lo],
    percent: index.tokens.length ? (t + 1) / index.tokens.length : 0,
  };
}

/**
 * Where in the book this page came from, or null if we cannot say.
 *
 * The position returned is the *end* of the aligned text — the photograph is
 * of the last page you read, so its final word is where you stopped. It is
 * also deliberately conservative: if OCR garbled the bottom of the page the
 * alignment simply ends earlier, and you are placed a few words short of
 * where you really are rather than somewhere you have not been.
 *
 * Three gates, all of which must open: enough words to be worth trusting, a
 * high enough share of them aligned, and a clear enough win over the next
 * best place in the book. The third is the one that catches repeated text,
 * and it is the reason this can be allowed to move your position at all.
 */
export function locatePassage(index: PassageIndex, ocr: string): PassageMatch | null {
  const cleaned = stripFurniture(dehyphenate(ocr));
  const query = foldTokens(cleaned);
  if (query.length < MIN_TOKENS || !index.tokens.length) return null;

  const regions = seed(index, query);
  if (!regions.length) return null;

  const scored = regions.map((r) => {
    const from = Math.max(0, r.start - WINDOW_PAD);
    const to = Math.min(index.tokens.length, r.start + query.length + WINDOW_PAD);
    const a = align(query, index.tokens, from, to);
    return { start: r.start, score: a.matches / query.length, endsAt: a.endsAt };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  /* The runner-up has to be somewhere else in the book. Two candidate
     regions can overlap enough to be the same passage seen twice, and
     comparing a passage against itself would fail every match. */
  let runnerUp = 0;
  for (const s of scored.slice(1)) {
    if (Math.abs(s.start - best.start) > query.length) {
      runnerUp = s.score;
      break;
    }
  }

  if (best.score < MIN_SCORE) return null;
  if (runnerUp > 0 && best.score < runnerUp * MIN_MARGIN) return null;

  const clear = runnerUp === 0 || best.score >= runnerUp * SURE_MARGIN;

  return {
    locus: locusOf(index, best.endsAt),
    tokenIndex: best.endsAt,
    score: best.score,
    runnerUp,
    tokens: query.length,
    confidence: best.score >= SURE_SCORE && clear ? 'sure' : 'review',
  };
}
