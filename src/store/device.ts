/* The device shelf: books read on a physical e-reader, the timer you run
   while reading them, and the machinery that folds that reading back into
   the library.

   Three rules govern the folding, and they are the whole design:

     1. A reader session becomes a library session, so every statistic in
        the app counts the reading you did away from it. One mirrored row
        per logged session, keyed by uid, so editing never duplicates.
     2. Progress only moves forward. A page count that implies less than
        the app already knows is still recorded as reading, but it does not
        rewind where you left off.
     3. Linking is by exact normalised title, done silently, and pinned the
        moment you touch it by hand — automatic behaviour should never
        overrule a decision you made deliberately. */

import { create } from 'zustand';
import {
  db,
  deleteDeviceBook,
  newUid,
  type DeviceBookRecord,
  type DeviceSessionRecord,
} from '../db';
import {
  bodyPages,
  clampGeometry,
  findMatch,
  pageToPercent,
  pagesToWords,
  percentToLocus,
  percentToPage,
  type Locus,
} from '../engine/device';
import type { Session } from '../engine/stats';
import { useLibrary } from './library';

const changed = (): void => {
  dispatchEvent(new CustomEvent('soluna:changed'));
};

const TIMER_KEY = 'device.timer';

/** A running timer, kept in the database rather than in memory so that
    closing the app — or Safari discarding the tab, which it will — does not
    lose a session you are in the middle of. Elapsed time is derived from
    wall-clock stamps, never from a counter we increment. */
export interface TimerState {
  deviceBookId: string;
  /** when the timer was first started */
  startedAt: number;
  /** active ms banked before the current run */
  accumulatedMs: number;
  /** when the current run began; null while paused */
  runningSince: number | null;
  fromPage: number;
}

export const elapsedOf = (t: TimerState | null, now = Date.now()): number =>
  !t ? 0 : t.accumulatedMs + (t.runningSince ? now - t.runningSince : 0);

const uid = (): string => newUid();

interface DeviceState {
  books: DeviceBookRecord[];
  sessions: DeviceSessionRecord[];
  timer: TimerState | null;
  loaded: boolean;
  /** what the last finished session did to the library, for the receipt */
  lastSync: { title: string; from: number; to: number; moved: boolean } | null;

  load(): Promise<void>;
  addBook(
    input: Pick<DeviceBookRecord, 'title' | 'author' | 'pages'> &
      Partial<DeviceBookRecord>
  ): Promise<string>;
  updateBook(id: string, patch: Partial<DeviceBookRecord>): Promise<void>;
  removeBook(id: string): Promise<void>;
  /** link by hand — pins the choice against future auto-matching */
  link(id: string, bookId: string | null): Promise<void>;
  /** run the matcher over every unpinned, unlinked book */
  autoLink(): Promise<number>;
  /** redo the whole library↔shelf reconciliation by hand */
  reconcile(): Promise<{ linked: number; moved: number }>;

  start(deviceBookId: string, fromPage?: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  discard(): Promise<void>;
  /** `toLocus`, when given, is an exact scan match — more precise than the
      page number, which is then derived from it rather than typed */
  finish(toPage: number, note?: string, toLocus?: Locus): Promise<void>;

  /** backfill a session you forgot to time */
  logManual(input: {
    deviceBookId: string;
    start: number;
    ms: number;
    fromPage: number;
    toPage: number;
    toLocus?: Locus;
    note?: string;
  }): Promise<void>;
  removeSession(id: number): Promise<void>;
  clearReceipt(): void;

  /** push the library's own reading position into any linked reader book,
      forward-only — the other half of `recomputeBook`, which pushes the
      other way. Called from the library store as you read in the app. */
  pullFromLibrary(bookId: string, locus: Locus): Promise<void>;
}

export const useDevice = create<DeviceState>((set, get) => ({
  books: [],
  sessions: [],
  timer: null,
  loaded: false,
  lastSync: null,

  async load() {
    const [books, sessions, timerRow] = await Promise.all([
      db.deviceBooks.orderBy('addedAt').reverse().toArray(),
      db.deviceSessions.toArray(),
      db.settings.get(TIMER_KEY),
    ]);
    set({
      books,
      sessions: sessions.sort((a, b) => b.start - a.start),
      timer: (timerRow?.value as TimerState) ?? null,
      loaded: true,
    });
  },

  async addBook(input) {
    const now = Date.now();
    const id = uid();
    const record: DeviceBookRecord = {
      id,
      title: input.title.trim(),
      author: (input.author ?? '').trim(),
      ...clampGeometry({
        pages: input.pages,
        startPage: input.startPage ?? 1,
        currentPage: input.currentPage ?? 0,
      }),
      device: input.device?.trim() || undefined,
      addedAt: now,
      updatedAt: now,
      hue: Math.floor(Math.random() * 360),
    };

    // link on the way in, so the first session already knows where to land
    const match = findMatch(record, libraryCandidates());
    if (match) record.bookId = match;

    await db.deviceBooks.put(record);

    /* Both directions, in the order that makes each one correct.

       You do not add a reader card for a book you have never opened. The
       usual reason to add one is that you have been reading it *in the app*
       and are now carrying on with it on paper — so the card starts where
       the app left off, not at page zero, which is what it used to do and
       which made the whole shelf look like it had lost your place. A page
       typed in on the way is further along than the app whenever it is
       further along, and `adoptPosition` is forward-only, so it wins.

       Then the push the other way, because the card may be the one that is
       ahead. */
    if (record.bookId) {
      await adoptPosition(record);
      await recomputeBook(id);
    }
    await get().load();
    await useLibrary.getState().load();
    changed();
    return id;
  },

  async updateBook(id, patch) {
    const prev = await db.deviceBooks.get(id);
    if (!prev) return;

    const geometry =
      patch.pages != null || patch.startPage != null || patch.currentPage != null;

    const next: Partial<DeviceBookRecord> = { ...patch, updatedAt: Date.now() };
    /* Re-clamp the whole triple, not just the field that was touched:
       halving the page count can put the current page past the end without
       anyone typing a current page at all. */
    if (geometry) {
      Object.assign(
        next,
        clampGeometry({
          pages: patch.pages ?? prev.pages,
          startPage: patch.startPage ?? prev.startPage,
          currentPage: patch.currentPage ?? prev.currentPage,
        })
      );
    }

    /* A correction is not reading, and this is the distinction the shelf was
       missing.

       `recomputeBook` moves the library position forward only, which is
       right for a session: reading thirty pages on the Kindle should never
       rewind where the app thinks you are. But the numbers those pages are
       measured against are typed in by hand and *get corrected*, and under a
       forward-only rule a correction can only ever be applied when it
       happens to make the number bigger. Tell the app a 300-page paperback
       is really 400 pages and page 200 stops being two thirds and becomes a
       half — and the library kept the two thirds, for ever, because two
       thirds is further. Worse, the push back the other way then dragged the
       card itself from page 200 to page 267 to match a figure that was only
       ever derived from the count you had just disowned.

       So a geometry change carries what the position looked like *before*
       it. If the library is still sitting on that figure, the library is
       holding this card's own arithmetic and the card is entitled to redo
       it in either direction. If it has moved on since — you read further in
       the app — it is not ours to rewrite, and forward-only still holds. */
    const rebase = geometry
      ? {
          percent: pageToPercent(prev, prev.currentPage),
          tolerance: 1 / bodyPages(prev) + 0.0005,
        }
      : undefined;

    await db.deviceBooks.update(id, next);

    if (geometry || patch.bookId !== undefined) {
      await recomputeBook(id, rebase && { rebase });
      await useLibrary.getState().load();
    }
    await get().load();
    changed();
  },

  async removeBook(id) {
    await deleteDeviceBook(id);
    if (get().timer?.deviceBookId === id) await writeTimer(null);
    await get().load();
    await useLibrary.getState().load();
    changed();
  },

  async link(id, bookId) {
    await db.deviceBooks.update(id, {
      bookId: bookId ?? undefined,
      linkPinned: true,
      updatedAt: Date.now(),
    });
    const linked = await db.deviceBooks.get(id);
    if (linked) await adoptPosition(linked);
    await recomputeBook(id);
    await get().load();
    await useLibrary.getState().load();
    changed();
  },

  async autoLink() {
    const candidates = libraryCandidates();
    const books = await db.deviceBooks.toArray();
    let linked = 0;
    for (const b of books) {
      if (b.bookId || b.linkPinned) continue;
      const match = findMatch(b, candidates);
      if (!match) continue;
      await db.deviceBooks.update(b.id, { bookId: match, updatedAt: Date.now() });
      await adoptPosition({ ...b, bookId: match });
      await recomputeBook(b.id);
      linked++;
    }
    if (linked) {
      await get().load();
      await useLibrary.getState().load();
      changed();
    }
    return linked;
  },

  /**
   * Everything the automatic reconciliation does, on demand.
   *
   * The two shelves keep each other up to date at the moments where it is
   * obvious they should: a session is logged, a page is corrected, a chapter
   * is read in the app. That covers the cases anyone thought of. It does not
   * cover a book imported on one device and a reader card added on another,
   * a sync that landed while a sheet was open, or any of the ways two
   * devices and one account get out of step — and when it doesn't, the only
   * repair available was to edit a page number to no purpose just to make
   * something recompute.
   *
   * So: match every unlinked card, then push both directions for every
   * linked one. Forward-only, deliberately — this is a catch-up, not a
   * correction, and it is never the right moment to move anybody backwards.
   * Safe to run at any time and safe to run twice, because every step it
   * takes is one the app would have taken itself.
   */
  async reconcile() {
    const linked = await get().autoLink();

    let moved = 0;
    for (const book of await db.deviceBooks.toArray()) {
      if (!book.bookId) continue;
      if (await adoptPosition(book)) moved++;
      const receipt = await recomputeBook(book.id);
      if (receipt?.moved) moved++;
    }

    await get().load();
    await useLibrary.getState().load();
    changed();
    return { linked, moved };
  },

  /* ── timer ───────────────────────────────────────────────────── */

  async start(deviceBookId, fromPage) {
    const book = get().books.find((b) => b.id === deviceBookId);
    const now = Date.now();
    const timer: TimerState = {
      deviceBookId,
      startedAt: now,
      accumulatedMs: 0,
      runningSince: now,
      /* `||`, not `??`: a current page of 0 means the book has not been
         started, and starting the timer on a book whose body begins at page
         17 must not credit you with the sixteen pages of front matter. */
      fromPage: fromPage ?? (book?.currentPage || Math.max(0, (book?.startPage ?? 1) - 1)),
    };
    await writeTimer(timer);
    set({ timer, lastSync: null });
  },

  async pause() {
    const t = get().timer;
    if (!t?.runningSince) return;
    const paused: TimerState = {
      ...t,
      accumulatedMs: elapsedOf(t),
      runningSince: null,
    };
    await writeTimer(paused);
    set({ timer: paused });
  },

  async resume() {
    const t = get().timer;
    if (!t || t.runningSince) return;
    const running: TimerState = { ...t, runningSince: Date.now() };
    await writeTimer(running);
    set({ timer: running });
  },

  async discard() {
    await writeTimer(null);
    set({ timer: null });
  },

  async finish(toPage, note, toLocus) {
    const t = get().timer;
    if (!t) return;
    const ms = elapsedOf(t);
    await writeTimer(null);
    set({ timer: null });
    await get().logManual({
      deviceBookId: t.deviceBookId,
      start: t.startedAt,
      ms,
      fromPage: t.fromPage,
      toPage,
      toLocus,
      note,
    });
  },

  /* ── recording ───────────────────────────────────────────────── */

  async logManual({ deviceBookId, start, ms, fromPage, toPage, toLocus, note }) {
    const book = await db.deviceBooks.get(deviceBookId);
    if (!book) return;

    /* Clamped against the book at both ends. An unclamped `from` past the
       last page — which a page-count correction can leave behind in a timer
       that was already running — made `to - from` negative, and a session of
       minus two hundred pages then travelled all the way into the totals. */
    const from = Math.min(book.pages, Math.max(0, Math.round(fromPage)));
    /* a scan match is the real stopping point; the typed page number is
       only ever a fallback for it, so when both are present the locus wins */
    const rawTo = toLocus ? percentToPage(book, toLocus.percent) : Math.round(toPage);
    const to = Math.min(book.pages, Math.max(from, rawTo));
    const pages = to - from;

    const record: DeviceSessionRecord = {
      uid: uid(),
      deviceBookId,
      start,
      end: start + Math.max(0, ms),
      ms: Math.max(0, Math.round(ms)),
      fromPage: from,
      toPage: to,
      pages,
      words: 0, // filled by the reconciler, which knows the linked book
      note: note?.trim() || undefined,
      updatedAt: Date.now(),
      ...(toLocus
        ? { toSpineIndex: toLocus.spineIndex, toWordIndex: toLocus.wordIndex, toPercent: toLocus.percent }
        : {}),
    };
    await db.deviceSessions.add(record);

    /* the page you reached is the book's position now — this is the number
       the whole feature exists to move */
    if (to > book.currentPage) {
      await db.deviceBooks.update(deviceBookId, {
        currentPage: to,
        updatedAt: Date.now(),
        ...(toLocus ? { currentLocus: toLocus } : {}),
        ...(to >= book.pages ? { finishedAt: Date.now() } : {}),
      });
    }

    const receipt = await recomputeBook(deviceBookId);
    await get().load();
    await useLibrary.getState().load();
    set({
      lastSync: receipt && {
        title: book.title,
        from: receipt.before,
        to: receipt.after,
        moved: receipt.moved,
      },
    });
    changed();
  },

  async pullFromLibrary(bookId, locus) {
    const linked = await db.deviceBooks.where('bookId').equals(bookId).toArray();
    if (!linked.length) return;

    let moved = false;
    for (const book of linked) moved = (await carryForward(book, locus)) || moved;
    if (moved) {
      await get().load();
      changed();
    }
  },

  async removeSession(id) {
    const row = await db.deviceSessions.get(id);
    if (!row) return;
    if (row.mirrorUid) {
      const mirror = await db.sessions.where('uid').equals(row.mirrorUid).first();
      if (mirror?.id != null) await db.sessions.delete(mirror.id);
    }
    await db.deviceSessions.delete(id);
    if (row.uid) {
      await db.tombstones.put({
        key: `device_sessions:${row.uid}`,
        table: 'device_sessions',
        uid: row.uid,
        at: Date.now(),
      });
    }
    await recomputeBook(row.deviceBookId);
    await get().load();
    await useLibrary.getState().load();
    changed();
  },

  clearReceipt() {
    set({ lastSync: null });
  },
}));

/* ── helpers ───────────────────────────────────────────────────── */

async function writeTimer(t: TimerState | null): Promise<void> {
  if (t) await db.settings.put({ key: TIMER_KEY, value: t });
  else await db.settings.delete(TIMER_KEY);
}

/**
 * Move a reader card to a library position, forward only.
 *
 * The same rule as `recomputeBook`'s push in the other direction, and for
 * the same reason: two halves of one habit, each free to be the one that is
 * ahead, neither allowed to rewind the other.
 */
async function carryForward(book: DeviceBookRecord, locus: Locus): Promise<boolean> {
  const target = percentToPage(book, locus.percent);
  if (target <= book.currentPage) return false;
  await db.deviceBooks.update(book.id, {
    currentPage: target,
    currentLocus: locus,
    updatedAt: Date.now(),
    ...(target >= book.pages ? { finishedAt: Date.now() } : {}),
  });
  return true;
}

/** Start a newly linked card wherever the app had already got to. */
async function adoptPosition(book: DeviceBookRecord): Promise<boolean> {
  if (!book.bookId) return false;
  const p = await db.progress.get(book.bookId);
  if (!p) return false;
  return carryForward(book, {
    spineIndex: p.spineIndex,
    wordIndex: p.wordIndex,
    percent: p.percent,
  });
}

const libraryCandidates = () =>
  useLibrary.getState().books.map((b) => ({
    id: b.id,
    title: b.meta.title ?? '',
    author: b.meta.author ?? '',
  }));

export interface Receipt {
  /** library percent before this reconciliation */
  before: number;
  after: number;
  /** false when the app was already further along and kept its place */
  moved: boolean;
}

/** What the library position looked like under the geometry we just
    replaced, and how close a figure counts as being that one. See the long
    note in `updateBook` — this is the evidence that lets a correction move
    the position down as well as up. */
export interface Rebase {
  percent: number;
  tolerance: number;
}

/**
 * Rebuild everything derived from one reader book: the word value of each
 * session, its mirror in the library's history, and the reading position.
 *
 * Written as a full recompute rather than an incremental update because the
 * inputs are editable — page counts get corrected, links get changed — and
 * a derivation you can re-run from scratch can never drift out of step with
 * what it was derived from.
 */
export async function recomputeBook(
  deviceBookId: string,
  opts?: { rebase?: Rebase }
): Promise<Receipt | null> {
  const book = await db.deviceBooks.get(deviceBookId);
  if (!book) return null;

  const sessions = await db.deviceSessions.where('deviceBookId').equals(deviceBookId).toArray();
  const linked = book.bookId ? await db.books.get(book.bookId) : undefined;
  const totalWords = linked?.totalWords;

  /* 1 ─ word value of each session, and its mirror in library history */
  for (const s of sessions) {
    const words = pagesToWords(book, s.pages, totalWords);
    const mirror: Session = {
      uid: s.mirrorUid ?? s.uid ?? newUid(),
      bookId: book.bookId ?? '',
      start: s.start,
      end: s.end,
      ms: s.ms,
      words,
      pages: s.pages,
      pacedMs: 0,
      source: 'device',
    };

    if (s.words !== words || !s.mirrorUid) {
      await db.deviceSessions.update(s.id as number, {
        words,
        mirrorUid: mirror.uid,
        updatedAt: Date.now(),
      });
    }

    const existing = await db.sessions.where('uid').equals(mirror.uid as string).first();
    if (!book.bookId) {
      /* unlinked: the session is real reading and belongs in your totals,
         but it has no book to attach to. Keep it under a stable synthetic
         id so time, streaks and words all still count. */
      mirror.bookId = `device:${book.id}`;
    }
    if (existing?.id != null) await db.sessions.update(existing.id, mirror);
    else await db.sessions.add(mirror);
  }

  /* 2 ─ position, forward only */
  if (!book.bookId || !linked) return null;

  const pageDerivedPercent = pageToPercent(book, book.currentPage);

  /* `currentLocus` is an exact stamp — a scan match, or a position pulled
     straight from the library — but it is only trusted while it still
     agrees with `currentPage`. A page typed by hand afterwards, or a page
     count correction, moves `currentPage` without touching the locus, and
     from then on the two disagree by more than a page's worth: proof the
     locus is stale, so falling back to the page-based estimate is what
     keeps a mistyped page from landing on an old, now-wrong, exact spot. */
  const tolerance = 1 / bodyPages(book) + 0.0005;
  const trustedLocus =
    book.currentLocus && Math.abs(book.currentLocus.percent - pageDerivedPercent) <= tolerance
      ? book.currentLocus
      : null;

  const percent = trustedLocus?.percent ?? pageDerivedPercent;
  const current = await db.progress.get(book.bookId);
  const before = current?.percent ?? 0;

  /* Nothing to say. Checked first, so a correction that happens to land
     where the library already was is not reported as having moved it. */
  if (Math.abs(percent - before) <= 0.0005) {
    return { before, after: before, moved: false };
  }

  /* Backwards is allowed only when the figure we would be overwriting is
     the one this card put there under the numbers it has just disowned.
     Otherwise the app has read past it since, and forward-only stands. */
  const ours =
    opts?.rebase != null &&
    Math.abs(before - opts.rebase.percent) <= opts.rebase.tolerance;

  if (percent < before && !ours) {
    return { before, after: before, moved: false };
  }

  const locus = trustedLocus ?? percentToLocus(linked.spine, percent);
  await db.progress.put({
    bookId: book.bookId,
    spineIndex: locus.spineIndex,
    wordIndex: locus.wordIndex,
    percent,
    updatedAt: Date.now(),
  });

  if (percent >= 0.985 && !linked.finishedAt) {
    const at = Date.now();
    await db.books.update(linked.id, { finishedAt: at, updatedAt: at });
  }

  return { before, after: percent, moved: true };
}
