/* Two-way sync between the local Dexie database and whichever backend is
   configured.

   Shape of it:

     pull   — rows the server has stamped since our cursor
     merge  — last write wins, compared on the client-side `updatedAt`
     push   — local rows changed since the last push, plus tombstones
     files  — EPUBs and covers to and from object storage

   Two rules keep this honest. Reading never blocks on the network: every
   screen renders from Dexie and sync only ever writes into it afterwards.
   And the cursor is the *server's*, never the device's, because two iPads
   whose clocks differ by a minute would otherwise take turns losing each
   other's changes.

   Everything below is backend-agnostic. Transport lives in the adapters;
   what stays here is the merge policy, which is identical either way and is
   the part that is easy to get subtly wrong. */

import { create } from 'zustand';
import {
  coverToBlob,
  db,
  newUid,
  type BookRecord,
  type BookmarkRecord,
  type DeviceBookRecord,
  type DeviceSessionRecord,
  type ProgressRecord,
} from '../db';
import { bodyPages, pageToPercent } from '../engine/device';
import type { Session } from '../engine/stats';
import type { RatingRecord } from '../engine/rating';
import { useLibrary } from '../store/library';
import { useDevice } from '../store/device';
import { useRatings } from '../store/ratings';
import { useSettings } from '../store/settings';
import { backend, humanError, syncEnabled } from './client';
import { emptyChanges, isEmpty, type Changes, type Cursor } from './backend';
import {
  bookToRow,
  bookmarkToRow,
  deviceBookToRow,
  deviceSessionToRow,
  progressToRow,
  rowToBook,
  rowToBookmark,
  rowToDeviceBook,
  ratingToRow,
  rowToDeviceSession,
  rowToProgress,
  rowToRating,
  rowToSession,
  sessionToRow,
} from './mapping';

const META_KEY = 'sync';
const SETTINGS_AT = 'soluna.settings.at';

interface SyncMeta {
  /** how far this device has read the server's change log */
  cursor: Cursor;
  /** local clock: rows changed after this still need pushing */
  pushedAt: number;
  /** which account the local data was last reconciled against */
  userId: string | null;
  lastSyncedAt: number | null;
}

const defaultMeta = (): SyncMeta => ({
  cursor: backend?.zeroCursor ?? 0,
  pushedAt: 0,
  userId: null,
  lastSyncedAt: null,
});

async function readMeta(): Promise<SyncMeta> {
  const row = await db.settings.get(META_KEY);
  return { ...defaultMeta(), ...((row?.value as Partial<SyncMeta>) ?? {}) };
}

async function writeMeta(patch: Partial<SyncMeta>): Promise<SyncMeta> {
  const next = { ...(await readMeta()), ...patch };
  await db.settings.put({ key: META_KEY, value: next });
  return next;
}

const settingsData = (): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(useSettings.getState()).filter(([, v]) => typeof v !== 'function')
  );

/* ── store ───────────────────────────────────────────────────────── */

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline' | 'unverified';

interface SyncState {
  status: SyncStatus;
  step: string | null;
  error: string | null;
  lastSyncedAt: number | null;
  /** books whose EPUB has not reached the server yet */
  pendingUploads: number;
  /** books in the library whose file is not on this device */
  missingFiles: number;

  init(): Promise<void>;
  syncNow(): Promise<void>;
  /** fetch one book's EPUB on demand; returns false if it isn't available */
  ensureFile(bookId: string): Promise<boolean>;
  downloadAll(): Promise<void>;
  /** wipe local sync bookkeeping — used on sign-out */
  forget(): Promise<void>;
}

let running: Promise<void> | null = null;

export const useSync = create<SyncState>((set, get) => ({
  status: 'idle',
  step: null,
  error: null,
  lastSyncedAt: null,
  pendingUploads: 0,
  missingFiles: 0,

  async init() {
    const meta = await readMeta();
    set({ lastSyncedAt: meta.lastSyncedAt });
    await refreshCounts(set);
  },

  async syncNow() {
    if (!syncEnabled || !backend) return;
    if (running) return running; // coalesce; the caller waits on the run in flight

    running = (async () => {
      const user = await backend.auth.current().catch(() => null);
      if (!user) {
        set({ status: 'idle', step: null });
        return;
      }
      /* An unproven address syncs nothing. On the Worker this cannot
         actually happen — an account only exists once a link has been
         opened — but the check stays cheap insurance: failing here means
         one honest sentence instead of a half-finished push to reconcile. */
      if (!user.verified) {
        set({ status: 'unverified', step: null, error: null });
        return;
      }
      if (!navigator.onLine) {
        set({ status: 'offline', step: null });
        return;
      }

      set({ status: 'syncing', error: null, step: 'Checking for changes' });
      try {
        let meta = await readMeta();

        /* First sync of a device that already has a library: push
           everything, so signing up doesn't silently strand books imported
           before the account existed. Switching to a *different* account
           instead starts from that account's data and leaves the old rows
           alone rather than filing them under the new user. */
        if (meta.userId !== user.id) {
          meta = await writeMeta({
            userId: user.id,
            cursor: backend.zeroCursor,
            pushedAt: meta.userId === null ? 0 : Date.now(),
          });
        }

        const startedAt = Date.now();

        set({ step: 'Downloading changes' });
        const pulled = await backend.pull(meta.cursor);
        await merge(pulled.changes);

        set({ step: 'Uploading changes' });
        const outgoing = await collect(user.id, meta.pushedAt);
        let cursor = pulled.cursor;
        if (!isEmpty(outgoing)) {
          const after = await backend.push(outgoing);
          if (after !== null) cursor = after;
        }
        await clearTombstones();

        await writeMeta({ cursor, pushedAt: startedAt });

        set({ step: 'Syncing books' });
        await syncFiles();

        await useLibrary.getState().load();
        await useDevice.getState().load();
        await useRatings.getState().load();
        /* a reader book that arrived from another device may match a book
           this one has imported since — link it before it is ever shown */
        await useDevice.getState().autoLink();

        const done = Date.now();
        await writeMeta({ lastSyncedAt: done });
        set({ status: 'idle', step: null, lastSyncedAt: done });
        await refreshCounts(set);
      } catch (e) {
        set({
          status: navigator.onLine ? 'error' : 'offline',
          step: null,
          error: humanError(e),
        });
      }
    })().finally(() => {
      running = null;
    });

    return running;
  },

  async ensureFile(bookId) {
    if (await db.files.get(bookId)) return true;
    if (!backend) return false;

    const book = await db.books.get(bookId);
    if (!book?.filePath) return false;

    set({ step: 'Downloading book' });
    try {
      const blob = await backend.files.get('epub', bookId, book.filePath);
      if (!blob) throw new Error('Book file not found');
      const buf = await blob.arrayBuffer();
      await db.files.put({ bookId, data: buf, size: buf.byteLength });
      await db.books.update(bookId, { fileMissing: false });
      await refreshCounts(set);
      set({ step: null });
      return true;
    } catch (e) {
      set({ step: null, error: humanError(e) });
      return false;
    }
  },

  async downloadAll() {
    const books = await db.books.toArray();
    for (const b of books) {
      if (b.filePath && !(await db.files.get(b.id))) await get().ensureFile(b.id);
    }
    await useLibrary.getState().load();
  },

  async forget() {
    await db.settings.delete(META_KEY);
    set({ lastSyncedAt: null, status: 'idle', step: null, error: null });
  },
}));

async function refreshCounts(set: (p: Partial<SyncState>) => void): Promise<void> {
  const [books, files] = await Promise.all([db.books.toArray(), db.files.toArray()]);
  const have = new Set(files.map((f) => f.bookId));
  set({
    pendingUploads: books.filter((b) => !b.filePath && have.has(b.id)).length,
    missingFiles: books.filter((b) => !have.has(b.id)).length,
  });
}

/* ── merge ───────────────────────────────────────────────────────────

   Everything the server sent, folded into Dexie. Idempotent throughout: a
   row that arrives twice must land the same way both times, because a push
   is immediately visible to the next pull and re-seeing your own writes is
   the normal case rather than an edge one. */

/* Exported for the tests. This is the half of sync with no server in it —
   the decisions — so being able to drive it from an array of rows is worth
   more than keeping the module surface minimal. */
export async function merge(changes: Changes): Promise<void> {
  /* A row deleted here but not yet flagged on the server would otherwise be
     pulled straight back in before push gets a chance to remove it. */
  const pending = new Set((await db.tombstones.toArray()).map((t) => t.key));

  for (const row of changes.books) {
    if (pending.has(`books:${row.id}`)) continue;
    const local = await db.books.get(row.id);
    if (row.deleted) {
      if (local) {
        await db.books.delete(row.id);
        await db.files.delete(row.id);
        await db.covers.delete(row.id);
        await db.progress.delete(row.id);
        await db.bookmarks.where('bookId').equals(row.id).delete();
      }
      continue;
    }
    if (!local || (local.updatedAt ?? 0) <= row.updated_at) {
      await db.books.put({
        ...rowToBook(row),
        fileMissing: !(await db.files.get(row.id)),
      } satisfies BookRecord);
    }
  }

  for (const row of changes.progress) {
    const local = await db.progress.get(row.book_id);
    if (!local || local.updatedAt <= row.updated_at) {
      await db.progress.put(rowToProgress(row) as ProgressRecord);
    }
  }

  /* Reading sessions are append-only, so anything we don't already hold is
     new and anything we do is a re-send to ignore. */
  if (changes.sessions.length) {
    const existing = new Set(
      (await db.sessions.toArray()).map((s) => s.uid).filter(Boolean) as string[]
    );
    const fresh = changes.sessions
      .filter((r) => !existing.has(r.uid))
      .map(rowToSession);
    if (fresh.length) await db.sessions.bulkAdd(fresh as Session[]);
  }

  for (const row of changes.bookmarks) {
    if (pending.has(`bookmarks:${row.uid}`)) continue;
    const local = await db.bookmarks.where('uid').equals(row.uid).first();
    if (row.deleted) {
      if (local?.id != null) await db.bookmarks.delete(local.id);
      continue;
    }
    if (!local) {
      await db.bookmarks.add(rowToBookmark(row) as BookmarkRecord);
    } else if ((local.updatedAt ?? 0) <= row.updated_at && local.id != null) {
      await db.bookmarks.update(local.id, rowToBookmark(row));
    }
  }

  for (const row of changes.deviceBooks) {
    if (pending.has(`device_books:${row.id}`)) continue;
    const local = await db.deviceBooks.get(row.id);
    if (row.deleted) {
      if (local) {
        await db.deviceBooks.delete(row.id);
        await db.deviceSessions.where('deviceBookId').equals(row.id).delete();
      }
      continue;
    }
    if (!local || local.updatedAt <= row.updated_at) {
      const next = rowToDeviceBook(row) as DeviceBookRecord;

      /* `currentLocus` — the exact spot a scan or a library pull stamped on
         this card — has no column on the wire, and this is a `put`, which
         replaces the record rather than patching it. So every sync used to
         quietly destroy it and drop the card back to estimating its position
         from the page number alone.

         Keeping it is safe exactly when `recomputeBook` would still trust
         it: while it agrees with the page the incoming row carries. A row
         that moved the page somewhere else is describing a different place,
         and a stale exact answer is worse than an honest estimate. */
      if (local?.currentLocus) {
        const tolerance = 1 / bodyPages(next) + 0.0005;
        const agrees =
          Math.abs(local.currentLocus.percent - pageToPercent(next, next.currentPage)) <=
          tolerance;
        if (agrees) next.currentLocus = local.currentLocus;
      }

      await db.deviceBooks.put(next);
    }
  }

  /* Device sessions are editable, unlike library sessions, so they merge on
     `updated_at` rather than being treated as append-only. */
  for (const row of changes.deviceSessions) {
    if (pending.has(`device_sessions:${row.uid}`)) continue;
    const local = await db.deviceSessions.where('uid').equals(row.uid).first();
    if (row.deleted) {
      if (local?.id != null) await db.deviceSessions.delete(local.id);
      continue;
    }
    if (!local) {
      await db.deviceSessions.add(rowToDeviceSession(row) as DeviceSessionRecord);
    } else if (local.updatedAt <= row.updated_at && local.id != null) {
      await db.deviceSessions.update(local.id, rowToDeviceSession(row));
    }
  }

  /* Ratings merge on `updated_at` like any editable row. The only wrinkle
     is that a rating arriving from another device may point at a book this
     one has never imported — which is fine and stays that way: the row
     carries its own title and author, so the shelf can draw the spine
     without ever resolving the pointer. */
  for (const row of changes.ratings) {
    if (pending.has(`ratings:${row.id}`)) continue;
    const local = await db.ratings.get(row.id);
    if (row.deleted) {
      if (local) await db.ratings.delete(row.id);
      continue;
    }
    if (!local || local.updatedAt <= row.updated_at) {
      await db.ratings.put(rowToRating(row) as RatingRecord);
    }
  }

  if (changes.settings) {
    const localAt = Number(localStorage.getItem(SETTINGS_AT) ?? 0);
    if (localAt <= changes.settings.updated_at) {
      useSettings.setState(changes.settings.data as never);
      localStorage.setItem(SETTINGS_AT, String(changes.settings.updated_at));
    }
  }
}

/* ── collect ─────────────────────────────────────────────────────────

   Local rows changed since the last push, as wire rows. Also the place
   where a row that has never been synced acquires the stable `uid` it needs
   to be recognisable on another device — an auto-increment number means
   different things in different browsers. */

async function collect(userId: string, since: number): Promise<Changes> {
  const out = emptyChanges();

  out.books = (await db.books.toArray())
    .filter((b) => (b.updatedAt ?? 0) > since)
    .map((b) => bookToRow(b, userId));

  out.progress = (await db.progress.toArray())
    .filter((p) => p.updatedAt > since)
    .map((p) => progressToRow(p, userId));

  /* Sessions recorded in the app are immutable, so `end` doubles as their
     creation stamp. Sessions mirrored from the e-reader are not: they are
     dated when the reading happened, which may be days before you typed it
     in, and they change when a page count is corrected. So those are picked
     up by their device session's `updatedAt` instead — going by `end` alone
     would silently never push a backfilled session at all. */
  const touchedDeviceSessions = (await db.deviceSessions.toArray()).filter(
    (s) => s.updatedAt > since
  );
  const mirrorUids = new Set(
    touchedDeviceSessions.map((s) => s.mirrorUid).filter(Boolean) as string[]
  );

  const sessions = (await db.sessions.toArray()).filter(
    (s) => s.end > since || (s.uid && mirrorUids.has(s.uid))
  );
  for (const s of sessions) {
    if (!s.uid) {
      const uid = newUid();
      s.uid = uid;
      if (s.id != null) await db.sessions.update(s.id, { uid });
    }
  }
  out.sessions = sessions.map((s) => sessionToRow(s, userId));

  const marks = (await db.bookmarks.toArray()).filter(
    (m) => (m.updatedAt ?? m.createdAt) > since
  );
  for (const m of marks) {
    if (!m.uid) {
      const uid = newUid();
      m.uid = uid;
      if (m.id != null) await db.bookmarks.update(m.id, { uid });
    }
  }
  out.bookmarks = marks.map((m) => bookmarkToRow(m, userId));

  out.deviceBooks = (await db.deviceBooks.toArray())
    .filter((b) => b.updatedAt > since)
    .map((b) => deviceBookToRow(b, userId));

  for (const s of touchedDeviceSessions) {
    if (!s.uid) {
      const uid = newUid();
      s.uid = uid;
      if (s.id != null) await db.deviceSessions.update(s.id, { uid });
    }
  }
  out.deviceSessions = touchedDeviceSessions.map((s) => deviceSessionToRow(s, userId));

  out.ratings = (await db.ratings.toArray())
    .filter((r) => r.updatedAt > since)
    .map((r) => ratingToRow(r, userId));

  const settingsAt = Number(localStorage.getItem(SETTINGS_AT) ?? 0);
  if (settingsAt > since) {
    out.settings = { user_id: userId, data: settingsData(), updated_at: settingsAt };
  }

  /* Deletions ride along as rows carrying `deleted`, so the other devices
     learn about them on their next pull rather than simply never hearing.
     They go in the same batch: the row has to exist server-side before it
     can be flagged, and an upsert satisfies that either way. */
  const stones = await db.tombstones.toArray();
  const now = Date.now();
  for (const stone of stones) {
    switch (stone.table) {
      case 'books':
        out.books.push({
          ...blankBook(userId, stone.uid),
          updated_at: stone.at || now,
          deleted: true,
        });
        break;
      case 'bookmarks':
        out.bookmarks.push({
          user_id: userId,
          uid: stone.uid,
          book_id: '',
          spine_index: 0,
          word_index: 0,
          excerpt: '',
          created_at: stone.at,
          updated_at: stone.at || now,
          deleted: true,
        });
        break;
      case 'device_books':
        out.deviceBooks.push({
          user_id: userId,
          id: stone.uid,
          title: '',
          author: '',
          pages: 1,
          start_page: 1,
          current_page: 0,
          book_id: null,
          link_pinned: false,
          device: null,
          added_at: stone.at,
          finished_at: null,
          hue: 0,
          updated_at: stone.at || now,
          deleted: true,
        });
        break;
      case 'device_sessions':
        out.deviceSessions.push({
          user_id: userId,
          uid: stone.uid,
          device_book_id: '',
          start_at: stone.at,
          end_at: stone.at,
          ms: 0,
          from_page: 0,
          to_page: 0,
          pages: 0,
          words: 0,
          mirror_uid: null,
          note: null,
          updated_at: stone.at || now,
          deleted: true,
        });
        break;
      case 'ratings':
        out.ratings.push({
          user_id: userId,
          id: stone.uid,
          book_id: null,
          device_book_id: null,
          title: '',
          author: '',
          overall: 0,
          axes: {},
          mood: null,
          note: null,
          favourite: false,
          words: null,
          rated_at: stone.at,
          updated_at: stone.at || now,
          deleted: true,
        });
        break;
    }
  }

  return out;
}

const blankBook = (userId: string, id: string) => ({
  user_id: userId,
  id,
  title: '',
  author: '',
  meta: { title: '', author: '' } as never,
  spine: [],
  toc: [],
  total_words: 0,
  hue: 0,
  added_at: 0,
  finished_at: null,
  file_path: null,
  file_size: null,
  cover_path: null,
  updated_at: 0,
  deleted: false,
});

/* Tombstones are only dropped once the push that carried them succeeded —
   the throw on failure leaves them in place to be retried, which is why
   this is a separate step rather than part of collect. */
async function clearTombstones(): Promise<void> {
  const stones = await db.tombstones.toArray();
  if (!stones.length) return;
  if (backend) {
    for (const stone of stones) {
      if (stone.table === 'books') await backend.files.remove(stone.uid).catch(() => undefined);
    }
  }
  await db.tombstones.bulkDelete(stones.map((s) => s.key));
}

/* ── files ───────────────────────────────────────────────────────── */

/** Upload anything held locally that the server hasn't got, and fetch covers. */
async function syncFiles(): Promise<void> {
  if (!backend) return;
  const books = await db.books.toArray();

  for (const book of books) {
    if (book.filePath) continue;
    const file = await db.files.get(book.id);
    if (!file) continue;

    const path = await backend.files.put(
      'epub',
      book.id,
      new Blob([file.data], { type: 'application/epub+zip' })
    );

    let cover: string | undefined;
    const coverRow = await db.covers.get(book.id);
    if (coverRow) {
      cover = await backend.files
        .put('cover', book.id, coverToBlob(coverRow))
        .catch(() => undefined);
    }

    const now = Date.now();
    await db.books.update(book.id, {
      filePath: path,
      ...(cover ? { coverPath: cover } : {}),
      updatedAt: now,
    });
  }

  /* Covers for books pulled from another device: small, so fetch them
     eagerly — a library of grey rectangles is not what this app is for. */
  for (const book of books) {
    if (!book.coverPath || (await db.covers.get(book.id))) continue;
    const blob = await backend.files
      .get('cover', book.id, book.coverPath)
      .catch(() => null);
    if (!blob) continue;
    /* Drained to bytes rather than stored as the Blob the network handed
       back: IndexedDB refuses a blob whose backing is still held elsewhere,
       and takes the surrounding transaction down with it. */
    await db.covers.put({
      bookId: book.id,
      data: await blob.arrayBuffer(),
      type: blob.type || 'image/jpeg',
    });
  }
}

/* ── wiring ──────────────────────────────────────────────────────── */

let wired = false;

/** Called once at boot: watch settings for changes and sync at sensible moments. */
export function initSync(): void {
  if (!syncEnabled || wired) return;
  wired = true;

  /* Stamp settings on change so the pusher can tell whether ours or the
     server's is newer. persist() rehydrates from localStorage while the
     store is being created — before this runs — so no spurious stamp on
     boot. */
  useSettings.subscribe(() => {
    localStorage.setItem(SETTINGS_AT, String(Date.now()));
  });

  const trigger = () => {
    void useSync.getState().syncNow();
  };

  /* Local writes are chatty — progress is saved on every page turn — so
     they get debounced rather than firing a round trip each time. */
  let timer: ReturnType<typeof setTimeout> | undefined;
  addEventListener('soluna:changed', () => {
    clearTimeout(timer);
    timer = setTimeout(trigger, 8000);
  });

  window.addEventListener('online', trigger);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') trigger();
  });
  // closing the app mid-chapter shouldn't cost you the last few minutes
  window.addEventListener('pagehide', () => void useSync.getState().syncNow());
  setInterval(trigger, 5 * 60_000);
}
