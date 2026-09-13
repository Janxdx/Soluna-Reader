import {
  pageToPercent, percentToPage, percentToLocus, locusToPercent,
  bodyPages, pagesToWords, wordsPerPage, pagesPerHour, remaining, findMatch,
  clampGeometry,
} from '../src/engine/device.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};
const near = (name: string, got: number, want: number, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${got} want ~${want}`); }
  else console.log(`ok   ${name}`);
};

const b = { pages: 384, startPage: 1 };
eq('bodyPages', bodyPages(b), 384);
near('page 0 (unstarted) = 0%', pageToPercent(b, 0), 0);
near('page 1 = 1/384', pageToPercent(b, 1), 1 / 384);
near('last page = 100%', pageToPercent(b, 384), 1);
near('past the end clamps', pageToPercent(b, 999), 1);

// front matter
const fm = { pages: 400, startPage: 17 };
eq('bodyPages with front matter', bodyPages(fm), 384);
near('first body page', pageToPercent(fm, 17), 1 / 384);
near('last page with front matter', pageToPercent(fm, 400), 1);
near('front matter counts as nothing', pageToPercent(fm, 5), 0);

// round trip page -> percent -> page
let rtFails = 0;
for (const book of [b, fm]) {
  for (let p = Math.max(1, book.startPage); p <= book.pages; p++) {
    if (percentToPage(book, pageToPercent(book, p)) !== p) rtFails++;
  }
}
eq('page->percent->page round trip exact for every page', rtFails, 0);

// spine mapping
const spine = [
  { idref: 'a', href: 'a', linear: true, words: 1000 },
  { idref: 'b', href: 'b', linear: true, words: 5000 },
  { idref: 'c', href: 'c', linear: true, words: 4000 },
];
eq('0% -> start', percentToLocus(spine, 0), { spineIndex: 0, wordIndex: 0, percent: 0 });
eq('10% -> end of ch1', percentToLocus(spine, 0.1).spineIndex, 0);
eq('50% -> ch2', percentToLocus(spine, 0.5).spineIndex, 1);
const last = percentToLocus(spine, 1);
eq('100% -> last chapter', last.spineIndex, 2);
eq('100% never past the last word', last.wordIndex, 3999);

// locus <-> percent agreement (the app's own progress formula)
let drift = 0;
for (let i = 0; i <= 100; i++) {
  const pct = i / 100;
  const l = percentToLocus(spine, pct);
  drift = Math.max(drift, Math.abs(locusToPercent(spine, l.spineIndex, l.wordIndex) - pct));
}
console.log(`max round-trip drift percent->locus->percent: ${(drift * 100).toFixed(4)}%`);
eq('locus round trip within 0.02%', drift < 0.0002, true);

// full chain: a page on the reader lands where the app would call the same %
const linkedWords = 103_680; // 384 pages * 270
near('density', wordsPerPage({ pages: 384, startPage: 1 }, linkedWords), 270);
eq('pages->words uses the linked book', pagesToWords(b, 36, linkedWords), 9720);
eq('pages->words without a link uses the estimate', pagesToWords(b, 36), 9720);

// pace + projection
const day = 86_400_000;
const now = Date.now();
const sessions = [
  { ms: 3_600_000, pages: 40, start: now - 1 * day },
  { ms: 1_800_000, pages: 20, start: now - 2 * day },
  { ms: 3_600_000, pages: 40, start: now - 3 * day },
];
near('pages per hour', pagesPerHour(sessions), 40, 0.5);
const r = remaining({ pages: 384, startPage: 1 }, 184, sessions);
eq('pages left', r.pages, 200);
near('hours left', (r.ms ?? 0) / 3_600_000, 5, 0.1);
eq('finish date projected', r.finishAt !== null, true);
eq('no history -> no guess', remaining(b, 10, []).ms, null);

// matching
const lib = [
  { id: 'x', title: 'The Dispossessed', author: 'Ursula K. Le Guin' },
  { id: 'y', title: 'A Wizard of Earthsea', author: 'Le Guin, Ursula K.' },
];
eq('exact', findMatch({ title: 'The Dispossessed', author: 'Ursula K. Le Guin' }, lib), 'x');
eq('case + article + accents', findMatch({ title: 'dispossessed', author: 'ursula le guin' }, lib), 'x');
eq('subtitle dropped', findMatch({ title: 'The Dispossessed: An Ambiguous Utopia', author: '' }, lib), 'x');
eq('surname form', findMatch({ title: 'A Wizard of Earthsea', author: 'Ursula K. Le Guin' }, lib), 'y');
eq('wrong author, no match', findMatch({ title: 'The Dispossessed', author: 'Isaac Asimov' }, lib), null);
eq('unknown title, no match', findMatch({ title: 'Dune', author: 'Frank Herbert' }, lib), null);
eq('ambiguous title, no match', findMatch({ title: 'Poems', author: '' }, [
  { id: '1', title: 'Poems', author: '' }, { id: '2', title: 'Poems', author: '' }]), null);

eq('compound surname not fooled', findMatch({ title: 'A Wizard of Earthsea', author: 'John Guin' }, lib), 'y');
eq('smith vs hammersmith', findMatch({ title: 'Book One', author: 'Smith' }, [{ id: 'z', title: 'Book One', author: 'Jane Hammersmith' }]), null);
eq('missing author on one side still links', findMatch({ title: 'The Dispossessed', author: '' }, lib), 'x');
/* ── the three numbers, kept consistent ───────────────────────────── */

eq('a sane triple is left alone',
  clampGeometry({ pages: 300, startPage: 11, currentPage: 150 }),
  { pages: 300, startPage: 11, currentPage: 150 });

eq('a current page past the end is pulled back to the end',
  clampGeometry({ pages: 300, startPage: 1, currentPage: 900 }),
  { pages: 300, startPage: 1, currentPage: 300 });

/* Left alone, this was the one that broke everything downstream: it
   collapses bodyPages to 1, which makes one reader page worth the entire
   novel and every session's word count absurd. */
eq('a body starting past the end is pulled back to the end',
  clampGeometry({ pages: 400, startPage: 900, currentPage: 200 }),
  { pages: 400, startPage: 400, currentPage: 200 });
eq('and then a page is a page again', bodyPages(clampGeometry({ pages: 400, startPage: 900, currentPage: 200 })), 1);

eq('shrinking the book brings the current page with it',
  clampGeometry({ pages: 200, startPage: 11, currentPage: 350 }),
  { pages: 200, startPage: 11, currentPage: 200 });

eq('zero pages is not a book', clampGeometry({ pages: 0, startPage: 1, currentPage: 0 }).pages, 1);
eq('nor a negative one', clampGeometry({ pages: -5, startPage: 1, currentPage: 0 }).pages, 1);
eq('page zero means not started, and survives',
  clampGeometry({ pages: 300, startPage: 17, currentPage: 0 }).currentPage, 0);
eq('a negative current page is not started either',
  clampGeometry({ pages: 300, startPage: 1, currentPage: -4 }).currentPage, 0);
eq('fractions round', clampGeometry({ pages: 299.6, startPage: 10.4, currentPage: 12.5 }),
  { pages: 300, startPage: 10, currentPage: 13 });
eq('an empty box is not a number',
  clampGeometry({ pages: NaN, startPage: NaN, currentPage: NaN }),
  { pages: 1, startPage: 1, currentPage: 0 });

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
