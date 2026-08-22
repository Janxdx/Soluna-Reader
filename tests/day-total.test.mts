import { dayTotal, dayKey, lastDays } from '../src/engine/stats.ts';
import type { Session } from '../src/engine/stats.ts';

let fails = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${name}`);
};

const at = (start: number, minutes: number, words: number, pages = 1): Session => ({
  bookId: 'a',
  start,
  end: start + minutes * 60_000,
  ms: minutes * 60_000,
  words,
  pages,
  pacedMs: 0,
});

/* Times of day, not offsets from "now": a fixed offset lands on the wrong
   calendar day depending on what time the suite happens to run. */
const todayAt = (h: number, m = 0): number => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const daysBack = (n: number, h = 12): number => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};

/* ── dayTotal ───────────────────────────────────────────────────── */

eq('no sessions is an empty day, not a missing one', dayTotal([]).ms, 0);
eq('...and it still names the day', dayTotal([]).key, dayKey(Date.now()));

const day = [
  at(todayAt(8), 20, 4000, 12),
  at(todayAt(21), 40, 9000, 30),
  at(daysBack(1), 90, 20_000, 60),
  at(daysBack(9), 15, 3000, 8),
];

eq('today adds up only today', dayTotal(day).ms, 60 * 60_000);
eq('...its words', dayTotal(day).words, 13_000);
eq('...its pages', dayTotal(day).pages, 42);
eq('...and how many sittings it took', dayTotal(day).sessions, 2);

eq('another day can be asked for', dayTotal(day, daysBack(1)).ms, 90 * 60_000);
eq('a day you did not read is zero', dayTotal(day, daysBack(3)).ms, 0);

/* A session is credited to the day it began on, so reading past midnight
   stays one evening rather than being split across two days. */
const lateNight = [at(todayAt(23, 30), 55, 12_000)];
eq('a session that runs past midnight belongs to the evening it started',
  dayTotal(lateNight).ms, 55 * 60_000);

/* The card and the chart must not disagree about what "today" holds. */
const window20 = lastDays(day, 20);
eq('the last bar of the window is today', window20[window20.length - 1].key, dayKey(Date.now()));
eq('...and it holds what the card says', window20[window20.length - 1].ms, dayTotal(day).ms);

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
