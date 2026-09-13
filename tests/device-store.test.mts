import 'fake-indexeddb/auto';
const ROOT = new URL('../src', import.meta.url).pathname;

// zustand stores touch window/localStorage; give them a minimal home
(globalThis as any).window = globalThis;
(globalThis as any).dispatchEvent = () => true;
(globalThis as any).addEventListener = () => {};
import { webcrypto } from 'node:crypto';
(globalThis as any).crypto ??= webcrypto;
(globalThis as any).navigator ??= {};

const { db } = await import(`${ROOT}/db/index.ts`);
const { useDevice } = await import(`${ROOT}/store/device.ts`);
const { useLibrary } = await import(`${ROOT}/store/library.ts`);

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else { fails++; console.log(`FAIL ${name} ${extra}`); }
};

// a library book: 3 chapters, 100k words
const spine = [
  { idref: 'a', href: 'a', linear: true, words: 30_000 },
  { idref: 'b', href: 'b', linear: true, words: 40_000 },
  { idref: 'c', href: 'c', linear: true, words: 30_000 },
];
await db.books.put({
  id: 'lib1',
  meta: { title: 'The Dispossessed', author: 'Ursula K. Le Guin', subjects: [] },
  spine, toc: [], totalWords: 100_000, addedAt: Date.now(), hue: 20, updatedAt: Date.now(),
});
await useLibrary.getState().load();
await useDevice.getState().load();

// 1 ─ adding a tracked book links it silently
const id = await useDevice.getState().addBook({
  title: 'The Dispossessed: An Ambiguous Utopia',
  author: 'Le Guin, Ursula K.',
  pages: 400,
  startPage: 17,
});
let book = (await db.deviceBooks.get(id))!;
check('auto-linked on add', book.bookId === 'lib1', String(book.bookId));

// 2 ─ timer survives a "reload": state lives in the database
await useDevice.getState().start(id, 17);
await useDevice.getState().pause();
const saved = (await db.settings.get('device.timer'))!.value as any;
check('timer persisted', saved.deviceBookId === id && saved.runningSince === null);
await useDevice.getState().resume();
await useDevice.getState().finish(117);   // read pages 17→117, 100 of 384

book = (await db.deviceBooks.get(id))!;
check('current page moved', book.currentPage === 117);

const prog = await db.progress.get('lib1');
/* page 17 was the last page read before this session and 117 is the last
   page read after it, so 101 body pages (17…117) are behind you. */
const expected = 101 / 384;
check('library progress = body pages behind you / body pages', Math.abs(prog!.percent - expected) < 1e-6, String(prog!.percent));
check('lands in the chapter that percentage falls in',
  prog!.spineIndex === 0 && prog!.wordIndex === Math.round(expected * 100_000),
  `spine ${prog!.spineIndex} word ${prog!.wordIndex}`);

const mirrors = (await db.sessions.toArray());
check('one mirrored library session', mirrors.length === 1, String(mirrors.length));
check('mirror is attributed to the linked book', mirrors[0].bookId === 'lib1');
check('mirror is marked as device reading', mirrors[0].source === 'device');
check('words from the linked book density', mirrors[0].words === Math.round(100 * (100_000 / 384)), String(mirrors[0].words));

// 3 ─ furthest wins: a backfilled session behind the app must not rewind
await db.progress.put({ bookId: 'lib1', spineIndex: 2, wordIndex: 100, percent: 0.9, updatedAt: Date.now() });
await useDevice.getState().logManual({
  deviceBookId: id, start: Date.now() - 86_400_000, ms: 1_800_000, fromPage: 117, toPage: 150,
});
const after = await db.progress.get('lib1');
check('progress did not rewind', after!.percent === 0.9, String(after!.percent));
check('but the session still counted', (await db.sessions.toArray()).length === 2);

// 4 ─ correcting the page count heals every past session
await useDevice.getState().updateBook(id, { pages: 800 });
const healed = await db.sessions.toArray();
const density = 100_000 / (800 - 17 + 1);
check('mirrored words recomputed after a page-count fix',
  healed.every((s: any) => s.words === Math.round(s.pages * density)),
  JSON.stringify(healed.map((s: any) => [s.pages, s.words])));

// 5 ─ deleting the book takes its mirrors with it
await useDevice.getState().removeBook(id);
check('mirrors removed with the book', (await db.sessions.toArray()).length === 0);
check('tombstones written for sync', (await db.tombstones.toArray()).length === 3,
  JSON.stringify((await db.tombstones.toArray()).map((t: any) => t.key)));

/* ── 6 ─ the two halves of one habit ─────────────────────────────────

   Everything below is about a reader card and a library book being the same
   book read in two places, and the four ways that used to go wrong. */

await db.books.put({
  id: 'lib2',
  meta: { title: 'Solaris', author: 'Stanislaw Lem', subjects: [] },
  spine, toc: [], totalWords: 100_000, addedAt: Date.now(), hue: 5, updatedAt: Date.now(),
});
await useLibrary.getState().load();

// 6a ─ a card added for a book you are already reading starts where you are
await db.progress.put({ bookId: 'lib2', spineIndex: 1, wordIndex: 30_000, percent: 0.6, updatedAt: Date.now() });
await useLibrary.getState().load();
const solaris = await useDevice.getState().addBook({
  title: 'Solaris', author: 'Stanislaw Lem', pages: 300,
});
book = (await db.deviceBooks.get(solaris))!;
check('a new card starts at the app\u2019s position, not page zero',
  book.currentPage === 180, `page ${book.currentPage}`);
check('and the library store was told, not just the database',
  useLibrary.getState().progress['lib2']?.percent === 0.6);

// 6b ─ correcting the length re-derives the position instead of keeping the
//      figure the old length produced
await useDevice.getState().updateBook(solaris, { currentPage: 200 });
check('typing a page moves the library forward',
  Math.abs((await db.progress.get('lib2'))!.percent - 200 / 300) < 1e-9,
  String((await db.progress.get('lib2'))!.percent));

await useDevice.getState().updateBook(solaris, { pages: 400 });
check('correcting the length downward-derives the library position',
  Math.abs((await db.progress.get('lib2'))!.percent - 0.5) < 1e-9,
  String((await db.progress.get('lib2'))!.percent));
check('the library store sees the correction too',
  Math.abs((useLibrary.getState().progress['lib2']?.percent ?? 0) - 0.5) < 1e-9);

/* and the push back the other way must leave the page you typed alone —
   this is the loop that used to drag page 200 up to 267 */
const p2 = (await db.progress.get('lib2'))!;
await useDevice.getState().pullFromLibrary('lib2', {
  spineIndex: p2.spineIndex, wordIndex: p2.wordIndex, percent: p2.percent,
});
check('a corrected card is not dragged forward by its own old arithmetic',
  (await db.deviceBooks.get(solaris))!.currentPage === 200,
  `page ${(await db.deviceBooks.get(solaris))!.currentPage}`);

// 6c ─ but reading further in the app is not ours to rewrite
await db.progress.put({ bookId: 'lib2', spineIndex: 2, wordIndex: 0, percent: 0.9, updatedAt: Date.now() });
await useDevice.getState().updateBook(solaris, { pages: 500 });
check('a correction does not rewind progress the app made on its own',
  (await db.progress.get('lib2'))!.percent === 0.9,
  String((await db.progress.get('lib2'))!.percent));

// 6d ─ impossible triples never reach the database
await useDevice.getState().updateBook(solaris, { currentPage: 9000 });
book = (await db.deviceBooks.get(solaris))!;
check('a current page past the end is clamped on the way in',
  book.currentPage === book.pages, `${book.currentPage}/${book.pages}`);

await useDevice.getState().updateBook(solaris, { startPage: 9000 });
book = (await db.deviceBooks.get(solaris))!;
check('a body starting past the end is clamped too',
  book.startPage === book.pages, `${book.startPage}/${book.pages}`);

// 6e ─ a session that starts past the end is empty, not negative
await useDevice.getState().updateBook(solaris, { pages: 300, startPage: 1, currentPage: 200 });
await useDevice.getState().logManual({
  deviceBookId: solaris, start: Date.now(), ms: 600_000, fromPage: 900, toPage: 950,
});
const stray = (await db.deviceSessions.where('deviceBookId').equals(solaris).toArray())[0];
check('a session cannot cover a negative number of pages',
  stray.pages >= 0, `${stray.fromPage}\u2192${stray.toPage} = ${stray.pages}`);
check('nor can its mirror carry negative words',
  (await db.sessions.toArray()).every((s: any) => s.words >= 0 && s.pages >= 0));

/* ── 7 ─ the manual catch-up ─────────────────────────────────────────

   The automatic reconciliation fires at the moments someone thought of. This
   is the button for the moments nobody did — a card added on one device for
   a book imported on another, most often. */

const orphan = await useDevice.getState().addBook({
  title: 'Middlemarch', author: 'George Eliot', pages: 900,
});
check('a card for a book not in the library yet stays unlinked',
  (await db.deviceBooks.get(orphan))!.bookId === undefined);

await db.books.put({
  id: 'lib3',
  meta: { title: 'Middlemarch', author: 'George Eliot', subjects: [] },
  spine, toc: [], totalWords: 100_000, addedAt: Date.now(), hue: 7, updatedAt: Date.now(),
});
await db.progress.put({ bookId: 'lib3', spineIndex: 0, wordIndex: 0, percent: 0.25, updatedAt: Date.now() });
await useLibrary.getState().load();

const result = await useDevice.getState().reconcile();
check('reconcile links what the matcher can now see', result.linked === 1, JSON.stringify(result));
book = (await db.deviceBooks.get(orphan))!;
check('and the card catches up with the library',
  book.bookId === 'lib3' && book.currentPage === 225, `${book.bookId} p.${book.currentPage}`);

// and the other way: a card that is ahead pushes the library forward
await useDevice.getState().updateBook(orphan, { currentPage: 450 });
await db.progress.put({ bookId: 'lib3', spineIndex: 0, wordIndex: 0, percent: 0.25, updatedAt: Date.now() });
await useLibrary.getState().load();
const second = await useDevice.getState().reconcile();
check('a card that is ahead pushes the library forward', second.moved > 0, JSON.stringify(second));
check('the library landed on the card\u2019s position',
  Math.abs((await db.progress.get('lib3'))!.percent - 450 / 900) < 1e-9,
  String((await db.progress.get('lib3'))!.percent));

const third = await useDevice.getState().reconcile();
check('running it again changes nothing', third.linked === 0 && third.moved === 0,
  JSON.stringify(third));

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
