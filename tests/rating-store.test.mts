/* The rating store against a real (fake) IndexedDB.
 *
 * The engine tests cover the arithmetic; what is checked here is the part
 * that has state and could therefore be wrong in ways arithmetic cannot:
 * that rating a book twice edits one verdict instead of growing a second
 * spine, that a rating outlives the book it describes, and that the union
 * of the two shelves is offered exactly once each.
 */

import 'fake-indexeddb/auto';
const ROOT = new URL('../src', import.meta.url).pathname;

(globalThis as any).window = globalThis;
(globalThis as any).dispatchEvent = () => true;
(globalThis as any).addEventListener = () => {};
import { webcrypto } from 'node:crypto';
(globalThis as any).crypto ??= webcrypto;
(globalThis as any).navigator ??= {};

const { db, deleteBook } = await import(`${ROOT}/db/index.ts`);
const { useRatings, rateableBooks } = await import(`${ROOT}/store/ratings.ts`);
const { useLibrary } = await import(`${ROOT}/store/library.ts`);
const { useDevice } = await import(`${ROOT}/store/device.ts`);

let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else { fails++; console.log(`FAIL ${name} ${extra}`); }
};

const spine = [{ idref: 'a', href: 'a', linear: true, words: 90_000 }];
await db.books.put({
  id: 'lib1',
  meta: { title: 'Piranesi', author: 'Susanna Clarke', subjects: [] },
  spine, toc: [], totalWords: 90_000, addedAt: Date.now(), hue: 20,
  updatedAt: Date.now(), finishedAt: Date.now(),
});
await db.books.put({
  id: 'lib2',
  meta: { title: 'Middlemarch', author: 'George Eliot', subjects: [] },
  spine, toc: [], totalWords: 316_000, addedAt: Date.now(), hue: 40,
  updatedAt: Date.now(),
});
await useLibrary.getState().load();
await useDevice.getState().load();
await useRatings.getState().load();

/* ── 1 ─ rating, and re-rating ───────────────────────────────────── */

const id = await useRatings.getState().rate({
  bookId: 'lib1',
  title: 'Piranesi',
  author: 'Susanna Clarke',
  overall: 9.3,               // not a half step
  axes: { prose: 10, pacing: 0, ideas: 8 },  // pacing left unjudged
  mood: 'indigo',
  note: '  The house is the world.  ',
  words: 90_000,
});

let saved = (await db.ratings.get(id))!;
check('the score snaps to a half step', saved.overall === 9.5, String(saved.overall));
check('an untouched axis is absent, not zero', saved.axes.pacing === undefined);
check('judged axes are kept', saved.axes.prose === 10 && saved.axes.ideas === 8);
check('the note is trimmed', saved.note === 'The house is the world.');
check('unset flags stay off the record', saved.favourite === undefined);

const firstRatedAt = saved.ratedAt;
const again = await useRatings.getState().rate({
  bookId: 'lib1',
  title: 'Piranesi',
  author: 'Susanna Clarke',
  overall: 8,
  axes: {},
});
check('re-rating the same book edits rather than duplicates', again === id);
check('one row on the shelf, not two', (await db.ratings.toArray()).length === 1);
saved = (await db.ratings.get(id))!;
check('the new score wins', saved.overall === 8);
/* `<=`, not `<`: both stamps are `Date.now()` and two fast calls land in
   the same millisecond often enough to fail this at random. What is being
   asserted is that re-rating did not *move* `ratedAt` forward. */
check('but the date you formed the opinion is kept',
  saved.ratedAt <= saved.updatedAt && saved.ratedAt === firstRatedAt,
  `${saved.ratedAt} vs ${firstRatedAt}`);

/* ── 2 ─ the store mirrors the database ──────────────────────────── */

check('the store holds it too', useRatings.getState().ratings.length === 1);
check('lookup by book id', useRatings.getState().forBook('lib1')?.id === id);
check('an unrated book has no rating', !useRatings.getState().forBook('lib2'));

await useRatings.getState().toggleFavourite(id);
check('favourite toggles on', (await db.ratings.get(id))!.favourite === true);
await useRatings.getState().toggleFavourite(id);
check('and off again', (await db.ratings.get(id))!.favourite === false);

/* ── 3 ─ what can be rated ───────────────────────────────────────── */

const deviceId = await useDevice.getState().addBook({
  title: 'The Books of Jacob',
  author: 'Olga Tokarczuk',
  pages: 928,
  startPage: 13,
});
await useLibrary.getState().load();
await useDevice.getState().load();

let list = rateableBooks();
check('both shelves are offered', list.length === 3, String(list.length));
check('finished books come first', list[0].bookId === 'lib1');
check('the reader book carries an estimated length',
  (list.find((b: any) => b.deviceBookId === deviceId)?.words ?? 0) > 200_000);

// once the reader book is linked to a library book it is the same book,
// and must not appear on the list twice
await useDevice.getState().link(deviceId, 'lib2');
await useDevice.getState().load();
list = rateableBooks();
check('a linked reader book is not offered separately', list.length === 2);

/* ── 4 ─ the verdict outlives the book ───────────────────────────── */

await deleteBook('lib1');
await useRatings.getState().load();
const orphan = useRatings.getState().ratings[0];
check('the rating survives the book', orphan?.title === 'Piranesi');
check('and is no longer pointed at it', orphan?.bookId === undefined);

await useRatings.getState().remove(orphan.id);
check('removing a rating empties the shelf', useRatings.getState().ratings.length === 0);
check('and leaves a tombstone for the server',
  !!(await db.tombstones.get(`ratings:${orphan.id}`)));

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
