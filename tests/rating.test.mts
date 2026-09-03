import {
  AXIS_KEYS, MOODS, axisMean, clampScore, moodColor, scoreLabel,
  sortRatings, spineWeight, tasteProfile,
} from '../src/engine/rating.ts';
import type { RatingRecord } from '../src/engine/rating.ts';

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
const ok = (name: string, cond: boolean) => eq(name, cond, true);

const day = 86_400_000;
let n = 0;
const rate = (over: Partial<RatingRecord> = {}): RatingRecord => ({
  id: `r${++n}`,
  title: `Book ${n}`,
  author: 'A. Writer',
  overall: 7,
  axes: {},
  ratedAt: Date.now() - n * day,
  updatedAt: Date.now(),
  ...over,
});

/* ── the scale ──────────────────────────────────────────────────── */

eq('clamp snaps to half steps', clampScore(7.3), 7.5);
eq('clamp snaps down', clampScore(7.2), 7);
eq('clamp holds the ceiling', clampScore(12), 10);
eq('clamp holds the floor', clampScore(-3), 0);

eq('band at the top', scoreLabel(10), 'A book of your life');
eq('band in the middle', scoreLabel(5), 'Fine');
eq('band at the bottom', scoreLabel(0), 'Abandon hope');
ok('every half step has a label', Array.from({ length: 21 }, (_, i) => scoreLabel(i / 2)).every(Boolean));

/* ── axes ───────────────────────────────────────────────────────── */

eq('no axes judged means null, not zero', axisMean({ axes: {} }), null);
near('axis mean ignores unjudged axes', axisMean({ axes: { prose: 9, pacing: 6 } }) as number, 7.5);

/* ── spine weight ───────────────────────────────────────────────── */

eq('a measured book uses its own length', spineWeight(rate({ words: 140_000 })), 140_000);
eq('an unmeasured book stands with the ordinary ones', spineWeight(rate({})), 90_000);
eq('a nonsense length is treated as unmeasured', spineWeight(rate({ words: 12 })), 90_000);

/* ── the profile ────────────────────────────────────────────────── */

eq('an empty shelf has no favourite', tasteProfile([]).best, null);
eq('an empty shelf still has a tagline', typeof tasteProfile([]).tagline, 'string');

const shelf = [
  rate({ overall: 9.5, axes: { prose: 10, pacing: 6, ideas: 9 }, mood: 'indigo' }),
  rate({ overall: 8, axes: { prose: 9, pacing: 6, ideas: 8 }, mood: 'indigo' }),
  rate({ overall: 6, axes: { prose: 8, pacing: 4, ideas: 6 }, mood: 'ember' }),
  rate({ overall: 4.5, axes: { prose: 7, pacing: 3, ideas: 5 }, mood: 'ash' }),
];
const p = tasteProfile(shelf);

eq('counts every rating', p.count, 4);
near('mean', p.mean, 7);
near('median of an even count is the middle pair', p.median, 7);
ok('spread is positive when the scores differ', p.spread > 1);
eq('best is the highest score', p.best?.overall, 9.5);
eq('worst is the lowest', p.worst?.overall, 4.5);

// histogram buckets by rounded whole score: 9.5→10, 8→8, 6→6, 4.5→5
eq('histogram lands in the right buckets', p.histogram.map((c, i) => (c ? i : null)).filter((x) => x !== null), [5, 6, 8, 10]);
eq('histogram totals the ratings', p.histogram.reduce((a, b) => a + b, 0), 4);

near('axis mean over the shelf', p.axisMeans.prose as number, 8.5);
eq('an axis nobody judged is absent', p.axisMeans.feeling, undefined);
eq('prose is what this reader rewards', p.rewards, 'prose');
eq('pacing is what they punish', p.punishes, 'pacing');

eq('the top mood wins on count', p.topMood, 'indigo');
near('mood shares sum to one', p.moods.reduce((a, m) => a + m.share, 0), 1, 1e-9);
eq('moods are ordered by count', p.moods.map((m) => m.mood), ['indigo', 'ember', 'ash']);

// a reader whose axes are all level has no bias to report
const level = [
  rate({ overall: 7, axes: { prose: 7, pacing: 7, ideas: 7 } }),
  rate({ overall: 8, axes: { prose: 8, pacing: 8, ideas: 8 } }),
  rate({ overall: 6, axes: { prose: 6, pacing: 6, ideas: 6 } }),
  rate({ overall: 7, axes: { prose: 7, pacing: 7, ideas: 7 } }),
];
eq('level axes report no bias', tasteProfile(level).rewards, null);
ok('level axes still get a tagline', tasteProfile(level).tagline.length > 0);

// only recent ratings count towards the year
const old = tasteProfile([rate({ ratedAt: Date.now() - 400 * day }), rate({})]);
eq('a rating from last year is not this year', old.thisYear, 1);

/* thisMonth is a calendar boundary, not a rolling window — built from
   the first of the current month rather than a day count, so the test
   holds regardless of what day of the month it's run on. One rating at
   the exact boundary, one a millisecond before it. */
const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
const monthly = tasteProfile([
  rate({ ratedAt: startOfMonth }),
  rate({ ratedAt: startOfMonth - 1 }),
]);
eq('the boundary belongs to this month, one ms before does not', monthly.thisMonth, 1);

/* ── sorting ────────────────────────────────────────────────────── */

eq('by rating, best first', sortRatings(shelf, 'rating').map((r) => r.overall), [9.5, 8, 6, 4.5]);
eq('by mood, grouped in palette order then by score',
  sortRatings(shelf, 'mood').map((r) => r.mood), ['ember', 'indigo', 'indigo', 'ash']);
eq('by length, thickest first',
  sortRatings([rate({ words: 40_000 }), rate({ words: 200_000 })], 'length').map((r) => r.words),
  [200_000, 40_000]);
eq('sorting never mutates the input', shelf.map((r) => r.overall), [9.5, 8, 6, 4.5]);

/* ── colour ─────────────────────────────────────────────────────── */

ok('every mood yields a colour on both themes',
  MOODS.every((m) => moodColor(m, false).startsWith('hsl(') && moodColor(m, true).startsWith('hsl(')));
ok('an unset mood still yields a colour', moodColor(null, false).startsWith('hsl('));
eq('the palette has no duplicate keys', new Set(MOODS.map((m) => m.key)).size, MOODS.length);
eq('five axes, in a fixed order', AXIS_KEYS, ['prose', 'pacing', 'characters', 'ideas', 'feeling']);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`);
process.exit(fails ? 1 : 0);
