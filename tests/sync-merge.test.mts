/* Sync, exercised against a fake backend.

   The transport is now an adapter, which means the interesting half — merge
   policy — can be tested without a server at all: hand the loop a backend
   that returns rows from an array and records what it was given, and assert
   on what Dexie ends up holding.

   What is checked here is the behaviour that has no natural home in either
   adapter and would be quietly wrong in both if it broke: last write wins,
   deletions surviving as tombstones rather than reappearing, append-only
   sessions not duplicating, and a stale device failing to overwrite. */

import 'fake-indexeddb/auto';
const ROOT = new URL('../src', import.meta.url).pathname;

(globalThis as any).window = globalThis;
(globalThis as any).dispatchEvent = () => true;
(globalThis as any).addEventListener = () => {};
(globalThis as any).removeEventListener = () => {};
(globalThis as any).document = { addEventListener: () => {}, visibilityState: 'visible' };
import { webcrypto } from 'node:crypto';
(globalThis as any).crypto ??= webcrypto;
(globalThis as any).navigator ??= { onLine: true };
(globalThis as any).navigator.onLine = true;

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

/* Vite rewrites `import.meta.env` at build time; plain Node does not, so the
   adapters would read a property of undefined the moment they load. An empty
   object is the right stand-in — it means "nothing configured", which is
   exactly the state these tests want the backend selection to be in. */
(import.meta as any).env ??= {};

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    fails++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

const { db } = await import(`${ROOT}/db/index.ts`);
const { emptyChanges } = await import(`${ROOT}/sync/backend.ts`);
const { merge, useSync } = await import(`${ROOT}/sync/sync.ts`);

/* No fake server is needed. `merge` is the half of sync with no network in
   it — rows in, Dexie out — so it can be driven straight from arrays. The
   transport half is covered end-to-end against a real Worker and a real D1
   instead, which is the only place it can be checked honestly. */

/* ── 1 ─ last write wins ─────────────────────────────────────────── */

await db.books.put({
  id: 'bk1',
  meta: { title: 'Local', author: 'A', subjects: [] },
  spine: [],
  toc: [],
  totalWords: 10,
  addedAt: 1,
  hue: 1,
  updatedAt: 500,
} as any);

// a server row older than what we hold must not win
const older = {
  user_id: 'u1',
  id: 'bk1',
  title: 'Older',
  author: 'A',
  meta: { title: 'Older', author: 'A', subjects: [] },
  spine: [],
  toc: [],
  total_words: 10,
  hue: 1,
  added_at: 1,
  finished_at: null,
  file_path: null,
  file_size: null,
  cover_path: null,
  updated_at: 100,
  deleted: false,
};

await merge({ ...emptyChanges(), books: [older] });
check(
  'an older server row loses to the local copy',
  (await db.books.get('bk1'))?.meta.title === 'Local'
);

await merge({
  ...emptyChanges(),
  books: [
    {
      ...older,
      title: 'Newer',
      meta: { title: 'Newer', author: 'A', subjects: [] },
      updated_at: 900,
    },
  ],
});
check('a newer server row wins', (await db.books.get('bk1'))?.meta.title === 'Newer');

/* ── 1b ─ append-only sessions do not duplicate ──────────────────── */

const sessionRow = {
  user_id: 'u1',
  uid: 'sess-1',
  book_id: 'bk1',
  start_at: 10,
  end_at: 20,
  ms: 10,
  words: 5,
  pages: 1,
  paced_ms: 0,
  source: 'app',
};
await merge({ ...emptyChanges(), sessions: [sessionRow] });
await merge({ ...emptyChanges(), sessions: [sessionRow] });
check(
  'the same session pulled twice is stored once',
  (await db.sessions.toArray()).filter((s: any) => s.uid === 'sess-1').length === 1
);

/* ── 1c ─ a local deletion is not undone by the pull that follows ── */

await db.tombstones.put({
  key: 'books:bk-doomed',
  table: 'books',
  uid: 'bk-doomed',
  at: Date.now(),
});
await merge({
  ...emptyChanges(),
  books: [{ ...older, id: 'bk-doomed', updated_at: 99999 }],
});
check(
  'a row deleted here is not resurrected by the server copy',
  !(await db.books.get('bk-doomed'))
);
await db.tombstones.delete('books:bk-doomed');

/* ── 1d ─ a server tombstone removes the local book ──────────────── */

await merge({ ...emptyChanges(), books: [{ ...older, updated_at: 99999, deleted: true }] });
check('a server deletion removes the book', !(await db.books.get('bk1')));

/* ── 2 ─ deleting a book leaves a tombstone, and history survives ── */

const { deleteBook } = await import(`${ROOT}/db/index.ts`);

await db.books.put({
  id: 'bk1',
  meta: { title: 'Back again', author: 'A', subjects: [] },
  spine: [],
  toc: [],
  totalWords: 10,
  addedAt: 1,
  hue: 1,
  updatedAt: 500,
} as any);

await db.sessions.add({
  uid: 'sess-keep',
  bookId: 'bk1',
  start: 1,
  end: 2,
  ms: 1,
  words: 1,
  pages: 1,
  pacedMs: 0,
  source: 'app',
} as any);

await deleteBook('bk1');

const stone = await db.tombstones.get('books:bk1');
check('deleting a book writes a tombstone', !!stone);
check('the book itself is gone', !(await db.books.get('bk1')));
check(
  'reading history is not rewritten by a delete',
  (await db.sessions.toArray()).some((s: any) => s.uid === 'sess-keep')
);

/* ── 3 ─ covers are stored as bytes, never as a Blob ─────────────── */

const { coverToBlob } = await import(`${ROOT}/db/index.ts`);
const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
await db.covers.put({ bookId: 'bk2', data: bytes, type: 'image/png' });
const cover = await db.covers.get('bk2');
check('cover round-trips as an ArrayBuffer', cover?.data?.byteLength === 4);
check('cover rebuilds into a displayable blob', coverToBlob(cover!).type === 'image/png');

/* A row written by an older build held a Blob directly; it must still
   render rather than throwing on a property that is no longer there. */
await db.covers.put({ bookId: 'bk3', blob: new Blob([bytes], { type: 'image/jpeg' }) } as any);
const legacy = await db.covers.get('bk3');
check('legacy blob rows still render', coverToBlob(legacy!).type === 'image/jpeg');

/* ── 3b ─ ratings merge, and outlive the books they describe ─────── */

const ratingRow = {
  user_id: 'u1',
  id: 'rt1',
  book_id: 'bk-rated',
  device_book_id: null,
  title: 'From the server',
  author: 'A',
  overall: 8,
  axes: { prose: 9 },
  mood: 'indigo',
  note: null,
  favourite: false,
  words: 90000,
  rated_at: 10,
  updated_at: 500,
  deleted: false,
};

await merge({ ...emptyChanges(), ratings: [ratingRow] });
check('a rating arrives from the server', (await db.ratings.get('rt1'))?.overall === 8);

await merge({ ...emptyChanges(), ratings: [{ ...ratingRow, overall: 4, updated_at: 100 }] });
check(
  'an older rating loses to the local copy',
  (await db.ratings.get('rt1'))?.overall === 8
);

await merge({ ...emptyChanges(), ratings: [{ ...ratingRow, overall: 9.5, updated_at: 900 }] });
check('a newer rating wins', (await db.ratings.get('rt1'))?.overall === 9.5);

/* An axis nobody judged must stay absent through the round trip. Arriving
   as 0 instead would tell the taste profile this reader hates characters. */
check(
  'an unjudged axis survives as absent, not zero',
  (await db.ratings.get('rt1'))?.axes.characters === undefined
);

// deleting the book keeps the verdict and drops only the pointer
await db.books.put({
  id: 'bk-rated',
  meta: { title: 'Rated', author: 'A', subjects: [] },
  spine: [],
  toc: [],
  totalWords: 10,
  addedAt: 1,
  hue: 1,
  updatedAt: 1,
} as any);
await deleteBook('bk-rated');
const orphan = await db.ratings.get('rt1');
check('deleting a book keeps the rating', orphan?.title === 'From the server');
check('but unlinks it from the book that is gone', orphan?.bookId === undefined);

// and a local deletion is not undone by the pull that follows it
const { deleteRating } = await import(`${ROOT}/db/index.ts`);
await deleteRating('rt1');
check('deleting a rating writes a tombstone', !!(await db.tombstones.get('ratings:rt1')));
await merge({ ...emptyChanges(), ratings: [{ ...ratingRow, updated_at: 99999 }] });
check('a deleted rating is not resurrected', !(await db.ratings.get('rt1')));
await db.tombstones.delete('ratings:rt1');

await merge({ ...emptyChanges(), ratings: [{ ...ratingRow, updated_at: 99999 }] });
await merge({ ...emptyChanges(), ratings: [{ ...ratingRow, updated_at: 99999, deleted: true }] });
check('a server deletion removes the rating', !(await db.ratings.get('rt1')));

/* ── 4 ─ the sync store starts clean ─────────────────────────────── */

/* ── the exact position a card carries, which has no column on the wire ──

   `currentLocus` is stamped by a scan or by a library pull and is more
   precise than the page number. The merge writes device books with `put`,
   which replaces the record, so an incoming row used to wipe it on every
   sync — silently demoting an exact position to an estimate. It is kept when
   it still describes the page the row carries, and dropped when it does not,
   which is the same trust rule `recomputeBook` applies. */

const cardRow = {
  user_id: 'u1',
  id: 'dev-locus',
  title: 'Solaris',
  author: 'Lem',
  pages: 300,
  start_page: 1,
  current_page: 150,
  book_id: null,
  link_pinned: false,
  device: null,
  added_at: 1,
  finished_at: null,
  hue: 3,
  updated_at: 100,
  deleted: false,
};

await db.deviceBooks.put({
  id: 'dev-locus',
  title: 'Solaris',
  author: 'Lem',
  pages: 300,
  startPage: 1,
  currentPage: 150,
  currentLocus: { spineIndex: 1, wordIndex: 4242, percent: 0.5 },
  addedAt: 1,
  hue: 3,
  updatedAt: 50,
});

await merge({ ...emptyChanges(), deviceBooks: [cardRow] });
check('an exact position survives a sync that agrees with it',
  (await db.deviceBooks.get('dev-locus'))!.currentLocus?.wordIndex === 4242,
  JSON.stringify((await db.deviceBooks.get('dev-locus'))!.currentLocus));

await merge({
  ...emptyChanges(),
  deviceBooks: [{ ...cardRow, current_page: 30, updated_at: 200 }],
});
check('but is dropped when the row moved the page somewhere else',
  (await db.deviceBooks.get('dev-locus'))!.currentLocus === undefined,
  JSON.stringify((await db.deviceBooks.get('dev-locus'))!.currentLocus));

check('sync starts idle', useSync.getState().status === 'idle');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
