/* The row breaker: the only layer of the 3D shelf that can be tested
   without a browser to lay anything out in. See engine/shelf.ts for why
   a wrapping flex container can't do this job itself. */

import { breakRows } from '../src/engine/shelf.ts';
import type { SpineLook } from '../src/engine/spine.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};
const ok = (name: string, cond: boolean) => eq(name, cond, true);

/* A minimal look — only `width` matters to the row breaker, but the type
   wants the rest, so this is every other field at some plausible value. */
const look = (width: number): SpineLook => ({
  width,
  height: '80%',
  background: '#000',
  ink: '#fff',
  accent: '#fff',
  pattern: 'plain',
  direction: 'down',
  real: false,
});

const spines = (widths: number[]) => widths.map((w, i) => ({ id: `b${i}`, look: look(w) }));

/* ── fits within the container ─────────────────────────────────────── */

{
  const rows = breakRows(spines([40, 40, 40, 40, 40, 40, 40, 40]), 200);
  for (const row of rows) {
    ok(`row of width ${row.width} fits the container`, row.width <= 200);
  }
}

/* ── every book appears exactly once ───────────────────────────────── */

{
  const input = spines([30, 52, 21, 64, 12, 45, 33, 28, 19]);
  const rows = breakRows(input, 150);
  const seen = rows.flatMap((r) => r.books.map((b) => b.id));
  eq('every book placed exactly once', seen.length, input.length);
  eq('no book placed twice', new Set(seen).size, seen.length);
  ok('every id from the input made it in', input.every((s) => seen.includes(s.id)));
}

/* ── the fan is symmetric and monotonic across a row ───────────────── */

{
  const rows = breakRows(spines([30, 30, 30, 30, 30, 30, 30]), 1000);
  eq('a row that fits fully is one row', rows.length, 1);
  const ry = rows[0].books.map((b) => b.ry);
  for (let i = 1; i < ry.length; i++) {
    ok(`ry is non-decreasing at index ${i}`, ry[i] >= ry[i - 1] - 1e-9);
  }
  /* An odd count of equal-width spines has an exact centre book, and it
     should read as flat — the row's own vanishing point. */
  const mid = Math.floor(ry.length / 2);
  ok('the centre book of a symmetric row is flat', Math.abs(ry[mid]) < 0.01);
  /* Symmetric widths mean a symmetric fan: the angle a book left of centre
     turns is the mirror of the one the same distance right of centre. */
  for (let i = 0; i < mid; i++) {
    const j = ry.length - 1 - i;
    ok(`book ${i} mirrors book ${j}`, Math.abs(ry[i] + ry[j]) < 0.01);
  }
}

/* ── a single spine wider than the container still gets a row ──────── */

{
  const rows = breakRows(spines([500]), 100);
  eq('an oversized spine is not dropped', rows.length, 1);
  eq('and keeps its one book', rows[0].books.length, 1);
  eq('and reads flat, being alone in its row', rows[0].books[0].ry, 0);
}

/* ── the fan is measured against the row's own width, not the container's ── */

{
  /* A short last row: two 40px spines in a 400px container. Full-width
     fanning would send them close to ±30°; against the row's own 80px
     they should fan much more gently than a full row would. */
  const shortRow = breakRows(spines([40, 40]), 400);
  eq('a short remainder is not split further', shortRow.length, 1);
  const fullRow = breakRows(spines([40, 40, 40, 40, 40, 40, 40, 40, 40, 40]), 400);
  const shortEdge = Math.abs(shortRow[0].books[1].ry);
  const fullEdge = Math.abs(fullRow[0].books[fullRow[0].books.length - 1].ry);
  ok('a short row fans less steeply than a full one', shortEdge < fullEdge);
}

/* ── empty input ────────────────────────────────────────────────────── */

eq('nothing in, nothing out', breakRows([], 400), []);

console.log(fails ? `\n${fails} failing` : '\nall passing');
if (fails) process.exit(1);
