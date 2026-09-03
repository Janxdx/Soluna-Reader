/* Ratings.
 *
 * A finished book gets one number and five smaller ones. The single number
 * is the verdict; the five are *why*, and they are what make a rating worth
 * keeping — "8/10" ages into noise, while "the prose carried a book whose
 * plot didn't" is still legible in five years.
 *
 * Two deliberate choices shape everything downstream.
 *
 * A rating is not a property of a book. It is its own record with the title
 * and author copied into it, so deleting the EPUB — or reading the thing on
 * an e-reader that this app never sees the file of — does not delete your
 * opinion of it. The link to a book is a convenience, not the identity.
 *
 * And colour means something here, which it does nowhere else in the app.
 * The rest of Soluna spends a single warm accent and hoards the rest; the
 * shelf spends a palette, because on this one screen the colour *is* the
 * data. Restraint everywhere else is what buys it.
 *
 * Framework-free like the rest of `engine/`: everything below is a pure
 * function of an array of records.
 */

/* ── the five axes ───────────────────────────────────────────────── */

export type AxisKey = 'prose' | 'pacing' | 'characters' | 'ideas' | 'feeling';

export interface Axis {
  key: AxisKey;
  label: string;
  /** shown under the slider — what the number is actually asking */
  hint: string;
}

/* Ordered as they are drawn on the radar, clockwise from the top. The order
   is not alphabetical and should not become so: adjacent axes read as
   related, so craft sits next to craft and effect next to effect. */
export const AXES: Axis[] = [
  { key: 'prose', label: 'Prose', hint: 'Sentence by sentence' },
  { key: 'pacing', label: 'Pacing', hint: 'Did it pull you along' },
  { key: 'characters', label: 'Characters', hint: 'People you believed in' },
  { key: 'ideas', label: 'Ideas', hint: 'What it gave you to think about' },
  { key: 'feeling', label: 'Feeling', hint: 'What it left behind' },
];

export const AXIS_KEYS: AxisKey[] = AXES.map((a) => a.key);

export const axisLabel = (key: AxisKey): string =>
  AXES.find((a) => a.key === key)?.label ?? key;

/* ── the mood palette ────────────────────────────────────────────── */

export type MoodKey =
  | 'ember'
  | 'gold'
  | 'moss'
  | 'sea'
  | 'indigo'
  | 'plum'
  | 'oxblood'
  | 'ash';

export interface Mood {
  key: MoodKey;
  /** what the book felt like, not what it was about */
  label: string;
  note: string;
  /* Stored as HSL parts rather than a hex string so the same mood can be
     lightened for the dark theme without keeping two palettes in step. A
     book-cloth colour at 44% lightness disappears against #0E0D0C. */
  h: number;
  s: number;
  l: number;
}

/* Eight, which is a four-by-two grid on a phone and one row on an iPad.
   Muted on purpose — these are bookbinding cloth colours, not highlighter
   pens, and a wall of them has to sit calmly next to warm paper. */
export const MOODS: Mood[] = [
  { key: 'ember', label: 'Consuming', note: 'Took the evening and kept it', h: 14, s: 62, l: 44 },
  { key: 'gold', label: 'Joyful', note: 'Left you lighter', h: 38, s: 60, l: 45 },
  { key: 'moss', label: 'Comforting', note: 'Somewhere to return to', h: 96, s: 26, l: 34 },
  { key: 'sea', label: 'Contemplative', note: 'Slow, and worth the slowness', h: 190, s: 40, l: 32 },
  { key: 'indigo', label: 'Haunting', note: 'Followed you out of the room', h: 228, s: 34, l: 42 },
  { key: 'plum', label: 'Melancholy', note: 'Beautiful and a little sad', h: 310, s: 26, l: 36 },
  { key: 'oxblood', label: 'Brutal', note: 'Cost something to finish', h: 352, s: 44, l: 32 },
  { key: 'ash', label: 'Cold', note: 'Admired from a distance', h: 30, s: 6, l: 42 },
];

export const moodOf = (key: MoodKey | null | undefined): Mood | null =>
  MOODS.find((m) => m.key === key) ?? null;

/** The mood as a colour, lifted on the dark theme so it still reads as cloth. */
export function moodColor(mood: Mood | null, dark: boolean, shift = 0): string {
  if (!mood) return dark ? 'hsl(30 6% 34%)' : 'hsl(30 8% 62%)';
  const l = Math.max(6, Math.min(92, mood.l + (dark ? 14 : 0) + shift));
  const s = dark ? Math.round(mood.s * 0.86) : mood.s;
  return `hsl(${mood.h} ${s}% ${l}%)`;
}

/** Foil stamping: near-white on a dark cloth, near-black on a pale one. */
export const moodInk = (mood: Mood | null, dark: boolean): string => {
  const l = (mood?.l ?? 42) + (dark ? 14 : 0);
  return l > 58 ? 'hsl(28 20% 12% / 0.82)' : 'hsl(40 40% 96% / 0.88)';
};

/* ── the record ──────────────────────────────────────────────────── */

export interface RatingRecord {
  /** stable across devices; generated on the client that first rated */
  id: string;
  /** the library book this is about, when there is one */
  bookId?: string;
  /** or the e-reader book, for something never imported here */
  deviceBookId?: string;
  /* Copied, not looked up. A rating outlives the book record it came from
     — you delete the EPUB to save space, you do not delete the verdict. */
  title: string;
  author: string;
  /** 0–10 in half steps */
  overall: number;
  /** each 0–10; absent means "not judged", which is different from zero */
  axes: Partial<Record<AxisKey, number>>;
  mood?: MoodKey;
  /** one line, written for your future self */
  note?: string;
  favourite?: boolean;
  /** length at the time of rating — decides how thick the spine is drawn */
  words?: number;
  ratedAt: number;
  updatedAt: number;
}

export const clampScore = (v: number): number =>
  Math.min(10, Math.max(0, Math.round(v * 2) / 2));

/** Mean of the axes actually judged, or null when none were. */
export function axisMean(r: Pick<RatingRecord, 'axes'>): number | null {
  const vs = AXIS_KEYS.map((k) => r.axes[k]).filter((v): v is number => typeof v === 'number');
  if (!vs.length) return null;
  return vs.reduce((a, b) => a + b, 0) / vs.length;
}

/* Words are what the spine's thickness is drawn from, and roughly half the
   shelf will not have any: a book read on the e-reader is measured in pages
   and one rated from memory in nothing at all. 90k is a novel, so an
   unmeasured book stands with the ordinary ones rather than as a splinter
   or a brick. */
export const RATING_DEFAULT_WORDS = 90_000;

export const spineWeight = (r: RatingRecord): number =>
  r.words && r.words > 500 ? r.words : RATING_DEFAULT_WORDS;

/** Words per page on a typical paperback — turns an e-reader book into words. */
export const WORDS_PER_PAGE = 280;

/* ── what a number means ─────────────────────────────────────────── */

/* Shown beside the dial while you drag it. The point is to make the middle
   of the scale usable: without words, everything drifts to 8, because 5
   feels like a failing grade rather than "fine". */
const BANDS: { min: number; label: string }[] = [
  { min: 9.5, label: 'A book of your life' },
  { min: 9, label: 'Extraordinary' },
  { min: 8, label: 'Excellent' },
  { min: 7, label: 'Really good' },
  { min: 6, label: 'Good' },
  { min: 5, label: 'Fine' },
  { min: 4, label: 'Flawed' },
  { min: 3, label: 'Weak' },
  { min: 1.5, label: 'Bad' },
  { min: 0, label: 'Abandon hope' },
];

export const scoreLabel = (v: number): string =>
  BANDS.find((b) => v >= b.min)?.label ?? '';

/* ── the taste profile ───────────────────────────────────────────── */

export interface MoodShare {
  mood: MoodKey;
  count: number;
  /** 0–1 */
  share: number;
}

export interface TasteProfile {
  count: number;
  mean: number;
  median: number;
  /** standard deviation — how much of the scale you actually use */
  spread: number;
  /** counts in 11 buckets, index = whole score 0…10 */
  histogram: number[];
  /** average per axis over the ratings that judged it */
  axisMeans: Partial<Record<AxisKey, number>>;
  /** the axis you reward most, relative to your own average */
  rewards: AxisKey | null;
  /** and the one you are hardest on */
  punishes: AxisKey | null;
  moods: MoodShare[];
  topMood: MoodKey | null;
  best: RatingRecord | null;
  worst: RatingRecord | null;
  /** rated in the last 365 days */
  thisYear: number;
  /** rated so far this calendar month, local time */
  thisMonth: number;
  /** one sentence describing the reader, generated from the above */
  tagline: string;
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function tasteProfile(ratings: RatingRecord[]): TasteProfile {
  const empty: TasteProfile = {
    count: 0,
    mean: 0,
    median: 0,
    spread: 0,
    histogram: new Array(11).fill(0),
    axisMeans: {},
    rewards: null,
    punishes: null,
    moods: [],
    topMood: null,
    best: null,
    worst: null,
    thisYear: 0,
    thisMonth: 0,
    tagline: 'Rate a book and your taste starts taking shape.',
  };
  if (!ratings.length) return empty;

  const scores = ratings.map((r) => r.overall);
  const m = mean(scores);
  const spread = Math.sqrt(mean(scores.map((s) => (s - m) ** 2)));

  const histogram = new Array(11).fill(0);
  for (const s of scores) histogram[Math.round(Math.min(10, Math.max(0, s)))]++;

  const axisMeans: Partial<Record<AxisKey, number>> = {};
  for (const key of AXIS_KEYS) {
    const vs = ratings
      .map((r) => r.axes[key])
      .filter((v): v is number => typeof v === 'number');
    if (vs.length) axisMeans[key] = mean(vs);
  }

  /* Which axis you reward is measured against your own average, not against
     ten. A reader who scores everything highly still has a bias; comparing
     to the absolute scale would just report that they are generous. */
  const judged = AXIS_KEYS.filter((k) => axisMeans[k] !== undefined);
  const centre = mean(judged.map((k) => axisMeans[k] as number));
  const ranked = [...judged].sort(
    (a, b) => (axisMeans[b] as number) - (axisMeans[a] as number)
  );
  const spreadEnough = judged.length > 1 && Math.abs((axisMeans[ranked[0]] as number) - centre) > 0.2;

  const moodCounts = new Map<MoodKey, number>();
  for (const r of ratings) {
    if (!r.mood) continue;
    moodCounts.set(r.mood, (moodCounts.get(r.mood) ?? 0) + 1);
  }
  const moodTotal = [...moodCounts.values()].reduce((a, b) => a + b, 0);
  const moods: MoodShare[] = MOODS.filter((mood) => moodCounts.has(mood.key))
    .map((mood) => ({
      mood: mood.key,
      count: moodCounts.get(mood.key) as number,
      share: (moodCounts.get(mood.key) as number) / moodTotal,
    }))
    .sort((a, b) => b.count - a.count);

  const byScore = [...ratings].sort(
    (a, b) => b.overall - a.overall || b.ratedAt - a.ratedAt
  );
  const yearAgo = Date.now() - 365 * 86_400_000;
  /* Calendar month, not a rolling 30 days — the same local-midnight
     convention `dayTotal()` in stats.ts uses for "today", extended to
     "this month" so the count line agrees with what a reader means by
     it rather than with a fixed window that drifts across month ends. */
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  const profile: TasteProfile = {
    count: ratings.length,
    mean: m,
    median: median(scores),
    spread,
    histogram,
    axisMeans,
    rewards: spreadEnough ? ranked[0] : null,
    punishes: spreadEnough ? ranked[ranked.length - 1] : null,
    moods,
    topMood: moods[0]?.mood ?? null,
    best: byScore[0] ?? null,
    worst: byScore.length > 1 ? byScore[byScore.length - 1] : null,
    thisYear: ratings.filter((r) => r.ratedAt >= yearAgo).length,
    thisMonth: ratings.filter((r) => r.ratedAt >= monthStart).length,
    tagline: '',
  };
  profile.tagline = tagline(profile);
  return profile;
}

/* One sentence, assembled from three independent readings of the numbers:
   how generous you are, what you reward, and how the shelf feels. Each
   clause is dropped when the data doesn't support it, so a profile built
   from four books says less rather than saying it less truthfully. */
export function tagline(p: TasteProfile): string {
  if (p.count === 0) return 'Rate a book and your taste starts taking shape.';

  const temperament =
    p.count < 4
      ? 'Early days'
      : p.mean >= 8.2
        ? 'A generous reader'
        : p.mean <= 5.6
          ? 'A hard marker'
          : p.spread < 1
            ? 'An even hand'
            : p.spread > 2.4
              ? 'A reader of strong opinions'
              : 'A fair judge';

  const parts = [temperament];
  if (p.rewards) parts.push(`who rewards ${axisLabel(p.rewards).toLowerCase()}`);
  else if (p.count >= 4) parts.push('still finding a pattern');

  const first = `${parts.join(' ')}.`;

  const mood = moodOf(p.topMood);
  if (!mood || p.count < 3) return first;
  return `${first} Your shelf leans ${mood.label.toLowerCase()}.`;
}

/* ── sorting the wall ────────────────────────────────────────────── */

export type SortKey = 'rating' | 'recent' | 'mood' | 'title' | 'length';

export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'rating', label: 'Rating' },
  { key: 'recent', label: 'Recent' },
  { key: 'mood', label: 'Mood' },
  { key: 'title', label: 'Title' },
  { key: 'length', label: 'Length' },
];

const moodOrder = new Map(MOODS.map((m, i) => [m.key, i]));

export function sortRatings(ratings: RatingRecord[], key: SortKey): RatingRecord[] {
  const out = [...ratings];
  switch (key) {
    case 'rating':
      out.sort((a, b) => b.overall - a.overall || b.ratedAt - a.ratedAt);
      break;
    case 'recent':
      out.sort((a, b) => b.ratedAt - a.ratedAt);
      break;
    /* Grouped by mood, and *within* a mood by score, so the wall reads as
       blocks of colour that each shade from best to worst. Sorting by mood
       alone would give eight arbitrary piles. */
    case 'mood':
      out.sort(
        (a, b) =>
          (moodOrder.get(a.mood as MoodKey) ?? 99) - (moodOrder.get(b.mood as MoodKey) ?? 99) ||
          b.overall - a.overall
      );
      break;
    case 'title':
      out.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'length':
      out.sort((a, b) => spineWeight(b) - spineWeight(a));
      break;
  }
  return out;
}
