/* Translating between a physical reader and this app.

   An e-ink reader counts pages; this app counts words. The only bridge
   between them is that both are linear traversals of the same text, so a
   page number can be expressed as a fraction of the book and that fraction
   read back as a word position. Everything here is that one idea, applied
   carefully:

     page  →  fraction  →  word index  →  spine index + word in chapter

   The care is in the edges. Page 1 is *not* 0% and the last page is not
   more than 100%; front matter (title, copyright, contents) occupies real
   pages on the reader but no words here, so the body is what gets mapped;
   and a chapter's word count is what we have, not its rendered span count,
   so the last step is proportional rather than exact.

   No React, no browser APIs — this is engine code. */

import type { SpineEntry } from './types';

export interface PagedBook {
  /** last page of the book as the reader numbers them */
  pages: number;
  /** first page of the body text; 1 when there is no front matter */
  startPage: number;
}

export interface Locus {
  spineIndex: number;
  wordIndex: number;
  /** 0–1 through the whole book */
  percent: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/* ── the three numbers, kept consistent ───────────────────────────── */

export interface Geometry {
  pages: number;
  startPage: number;
  currentPage: number;
}

/**
 * The only combinations of the three page numbers that mean anything.
 *
 * Every derivation in this file divides by `bodyPages` or measures against
 * `pages`, and each one is individually defensible about its own input while
 * assuming the other two agree with it. They do not have to: the numbers are
 * typed in by hand, into three separate boxes, about a book the app has
 * never seen. A start page past the end collapses `bodyPages` to 1, which
 * makes one reader page worth the entire novel and every session's word
 * count absurd; a current page past the end pins the book at 100%, and
 * because the library position only ever moves forward, that is permanent.
 *
 * Neither of those is a sum that went wrong — both are perfectly good
 * arithmetic on a combination that cannot exist. So the combination is
 * refused here, once, at the only door the three numbers come through,
 * rather than defended against in each of the dozen places downstream.
 *
 * Clamping rather than rejecting: the reader is mid-correction, half-way
 * through fixing a page count they know is wrong, and an error message that
 * blocks the save would trap them in the bad state they are trying to leave.
 */
export function clampGeometry(g: Geometry): Geometry {
  const pages = Math.max(1, Math.round(g.pages) || 1);
  return {
    pages,
    startPage: Math.min(pages, Math.max(1, Math.round(g.startPage) || 1)),
    /* 0 is "not started", and stays distinct from `startPage - 1`: the card
       shows the start page until the first session, and a book whose body
       begins on page 17 should not claim you have read 16 pages of it. */
    currentPage: Math.min(pages, Math.max(0, Math.round(g.currentPage) || 0)),
  };
}

/** Pages that actually hold body text. Always at least 1. */
export const bodyPages = (b: PagedBook): number =>
  Math.max(1, b.pages - Math.max(1, b.startPage) + 1);

/**
 * Fraction of the book finished once page `page` has been *read to the end*.
 *
 * Finishing the first body page of a 300-page book is 1/300, not 0 — you did
 * read it — and finishing the last page is exactly 1. Pages before the body
 * (front matter) count as nothing, which is why they are configurable: get
 * `startPage` right once and every later number follows from it.
 */
export function pageToPercent(b: PagedBook, page: number): number {
  const start = Math.max(1, b.startPage);
  return clamp01((page - start + 1) / bodyPages(b));
}

/** The inverse: the page you are on at a given fraction of the book. */
export function percentToPage(b: PagedBook, percent: number): number {
  const start = Math.max(1, b.startPage);
  const page = start + clamp01(percent) * bodyPages(b) - 1;
  return Math.min(b.pages, Math.max(start, Math.round(page)));
}

/**
 * Turn a fraction of a book into a position the reader can open at.
 *
 * `spine[i].words` was counted at import, so walking the spine gives an
 * exact chapter. Within the chapter the position is proportional: we know
 * how many words it holds but not where they land on screen, and screen
 * layout depends on font size and device anyway. The error is bounded by
 * one chapter's worth of proportional drift, which for a normal chapter is
 * a handful of paragraphs — close enough to recognise where you were, which
 * is the honest limit of syncing on page counts alone.
 */
export function percentToLocus(spine: SpineEntry[], percent: number): Locus {
  const p = clamp01(percent);
  const total = spine.reduce((a, s) => a + s.words, 0);
  if (!spine.length || total === 0) return { spineIndex: 0, wordIndex: 0, percent: p };

  const target = p * total;
  let before = 0;
  for (let i = 0; i < spine.length; i++) {
    const words = spine[i].words;
    if (before + words >= target || i === spine.length - 1) {
      const into = Math.max(0, target - before);
      return {
        spineIndex: i,
        // keep one word in hand: landing past the last span would send the
        // reader back to the top of the chapter instead of near the end
        wordIndex: Math.max(0, Math.min(words - 1, Math.round(into))),
        percent: p,
      };
    }
    before += words;
  }
  return { spineIndex: spine.length - 1, wordIndex: 0, percent: p };
}

/** Words before a position — the same arithmetic the reader uses for progress. */
export function locusToPercent(
  spine: SpineEntry[],
  spineIndex: number,
  wordIndex: number
): number {
  const total = spine.reduce((a, s) => a + s.words, 0) || 1;
  let before = 0;
  for (let i = 0; i < spineIndex && i < spine.length; i++) before += spine[i].words;
  return clamp01((before + wordIndex) / total);
}

/* ── density ──────────────────────────────────────────────────────── */

/** Fallback when a reader book has no linked EPUB to measure against.
    A mass-market paperback page runs 250–300 words; this is deliberately
    mid-range and only ever used for estimates that are labelled as such. */
export const ASSUMED_WORDS_PER_PAGE = 270;

/** Words on one reader page, measured from the linked book when possible. */
export function wordsPerPage(b: PagedBook, totalWords?: number): number {
  if (!totalWords) return ASSUMED_WORDS_PER_PAGE;
  return totalWords / bodyPages(b);
}

/** What a stretch of reader pages is worth in words. */
export function pagesToWords(
  b: PagedBook,
  pages: number,
  totalWords?: number
): number {
  return Math.max(0, Math.round(pages * wordsPerPage(b, totalWords)));
}

/* ── pace and projections ─────────────────────────────────────────── */

export interface PageSession {
  ms: number;
  pages: number;
  start: number;
}

/**
 * Pages per hour, weighted towards recent sessions.
 *
 * A book you started slowly and are now racing through should project from
 * the racing, so each session's weight halves every `halfLifeDays`. Sessions
 * too short to mean anything are dropped rather than allowed to swing it.
 */
export function pagesPerHour(sessions: PageSession[], halfLifeDays = 14): number {
  const usable = sessions.filter((s) => s.ms > 60_000 && s.pages > 0);
  if (!usable.length) return 0;

  const now = Date.now();
  let pages = 0;
  let hours = 0;
  for (const s of usable) {
    const age = (now - s.start) / 86_400_000;
    const weight = Math.pow(0.5, age / halfLifeDays);
    pages += s.pages * weight;
    hours += (s.ms / 3_600_000) * weight;
  }
  return hours > 0 ? pages / hours : 0;
}

export interface Remaining {
  pages: number;
  /** null when there isn't enough history to say anything honest */
  ms: number | null;
  /** epoch ms of the projected finish, at your recent daily rate */
  finishAt: number | null;
  pagesPerHour: number;
}

/**
 * Time left in a book, and the date you'd finish at your current habits.
 *
 * Two different rates are involved and conflating them is the usual mistake:
 * *pages per hour* says how long the remaining pages take to read, while
 * *minutes per day* says how long it takes you to get around to reading them.
 * The finish date needs both.
 */
export function remaining(
  b: PagedBook,
  currentPage: number,
  sessions: PageSession[]
): Remaining {
  const left = Math.max(0, b.pages - Math.max(currentPage, b.startPage - 1));
  const rate = pagesPerHour(sessions);
  if (rate <= 0) {
    return { pages: left, ms: null, finishAt: null, pagesPerHour: 0 };
  }

  const ms = Math.round((left / rate) * 3_600_000);

  /* daily habit: active reading time per day over the last four weeks,
     divided by days elapsed rather than days read — skipped days are part
     of how fast you actually finish books */
  const cutoff = Date.now() - 28 * 86_400_000;
  const recent = sessions.filter((s) => s.start >= cutoff);
  const msPerDay = recent.reduce((a, s) => a + s.ms, 0) / 28;

  return {
    pages: left,
    ms,
    finishAt: msPerDay > 60_000 ? Date.now() + (ms / msPerDay) * 86_400_000 : null,
    pagesPerHour: rate,
  };
}

/* ── matching a reader book to a library book ─────────────────────── */

/** Strip everything that varies between an EPUB's metadata and what you'd
    type in by hand: case, accents, punctuation, articles, subtitles, and
    the "Lastname, Firstname" the OPF so often carries. */
export function normalizeTitle(s: string): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[:–—]/)[0] // drop the subtitle
    .replace(/\b(a|an|the|der|die|das|ein|eine|le|la|les|el|il)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeAuthor(s: string): string {
  const plain = (s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9,\s]+/g, ' ');
  // "Le Guin, Ursula K." → surname only, which is the part that agrees
  const surname = plain.includes(',') ? plain.split(',')[0] : plain.split(/\s+/).pop() ?? '';
  return surname.replace(/\s+/g, ' ').trim();
}

/**
 * Do two author strings name the same person?
 *
 * The two sides disagree about how much of a compound surname they keep:
 * an OPF often carries "Le Guin, Ursula K." while you'd type "Ursula K. Le
 * Guin", which reduces to "guin". So the shorter surname has to match the
 * end of the longer one — compared as whole words, since "smith" must not
 * match "hammersmith". An empty side agrees with anything: not knowing an
 * author is not evidence against a title that already matches exactly.
 */
export function authorsAgree(a: string, b: string): boolean {
  const x = normalizeAuthor(a).split(' ').filter(Boolean);
  const y = normalizeAuthor(b).split(' ').filter(Boolean);
  if (!x.length || !y.length) return true;
  const n = Math.min(x.length, y.length);
  return x.slice(-n).join(' ') === y.slice(-n).join(' ');
}

export interface Candidate {
  id: string;
  title: string;
  author: string;
}

/**
 * Find the library book a reader book is the same book as.
 *
 * Only exact matches on the normalised title count, because this links
 * silently: a wrong link quietly rewrites your reading position, so the
 * bar to make one has to be higher than "looks similar". A matching
 * surname is required when both sides name an author, and a title that
 * matches two different books is treated as no match at all.
 */
export function findMatch(
  probe: { title: string; author: string },
  candidates: Candidate[]
): string | null {
  const title = normalizeTitle(probe.title);
  if (title.length < 3) return null;

  const hits = candidates.filter(
    (c) => normalizeTitle(c.title) === title && authorsAgree(probe.author, c.author)
  );

  return hits.length === 1 ? hits[0].id : null;
}
