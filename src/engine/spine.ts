/* How a book is drawn standing up.
 *
 * The shelf has two modes and this file is the whole difference between
 * them.
 *
 *   Data     colour is the mood you chose, height is the score you gave,
 *            thickness is the length of the book. Three facts about your
 *            reading, legible from across the room without a legend. This
 *            is what the shelf has always been.
 *
 *   Shelf    colour is the book's actual cover, height and thickness are
 *            its actual paper, and a book from a series that has a livery
 *            is drawn in it. What a real shelf of these books looks like.
 *
 * They cannot both be true at once, and pretending otherwise is the trap.
 * A realistic spine takes two of the three data channels away: a Reclam is
 * short because it is a Reclam, not because you disliked it. What survives
 * into the realistic mode is the thickness — a long book is a thick book in
 * both readings — and the score, which comes back as a number stamped at
 * the foot. You have to walk up and read it, exactly as you would with a
 * real shelf, and that is the honest trade rather than a compromise.
 *
 * Browser-free like the rest of engine/: colours in, CSS values out, no DOM.
 */

import {
  DEFAULT_HEIGHT_MM,
  liveryFor,
  realMetrics,
  spineDirection,
  type EditionData,
  type Livery,
  type LiveryPattern,
  type SpineDirection,
} from './edition';
import { moodColor, moodInk, moodOf, spineWeight, type RatingRecord } from './rating';

export type ShelfMode = 'data' | 'shelf';

/* ── colour helpers ────────────────────────────────────────────────── */

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')}`;

const parse = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Perceived lightness, 0–1. Rec. 709 weights: green carries most of what
    the eye reads as brightness, which is why a saturated green needs dark
    ink and a saturated blue of the same "value" needs light. */
export function luma(hex: string): number {
  const rgb = parse(hex);
  if (!rgb) return 0.5;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/** Shift a colour towards white (positive) or black (negative). sRGB rather
    than a perceptual space on purpose: this makes the lit edge and the
    shadowed one, and a highlight wants to be a highlight. */
export function shade(hex: string, amount: number): string {
  const rgb = parse(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((v) => (amount >= 0 ? v + (255 - v) * amount : v * (1 + amount)));
  return toHex(r, g, b);
}

/** Foil stamping: light ink on dark cloth, dark ink on pale. The same rule
    as `moodInk`, applied to a measured colour instead of a chosen one. */
export const inkOn = (hex: string): string =>
  luma(hex) > 0.55 ? 'hsl(28 20% 12% / 0.86)' : 'hsl(40 40% 96% / 0.9)';

/* ── picking the ground colour ─────────────────────────────────────── */

/**
 * Which of a cover's colours a spine should be bound in.
 *
 * Not simply the most common one. A cover is mostly its background, and a
 * cover background is very often near-white — the palette extractor drops
 * the extremes for that reason, but what survives is still weighted towards
 * pale. A spine is cloth or board, printed, and it reads as a real object
 * when it has some depth to it; so among the top few, prefer the one with
 * enough weight to be a real part of the cover *and* enough colour to look
 * bound rather than washed out.
 */
export function groundFrom(palette: string[] | undefined): string | null {
  if (!palette?.length) return null;

  /* The first three, because the fourth is reliably an artefact — an
     anti-aliasing halo or the edge of a photograph. */
  const top = palette.slice(0, 3);

  let best: { hex: string; s: number } | null = null;
  for (let i = 0; i < top.length; i++) {
    const hex = top[i];
    const l = luma(hex);
    /* Rank on position first (it is a real signal about the cover), then
       penalise the very pale and the very dark, which make a spine look
       like a gap on the shelf rather than a book. */
    const s = (top.length - i) * 0.3 + (1 - Math.abs(l - 0.42) * 1.6);
    if (!best || s > best.s) best = { hex, s };
  }
  return best?.hex ?? palette[0];
}

/* ── the look ──────────────────────────────────────────────────────── */

export interface SpineLook {
  /** css px */
  width: number;
  /** share of the slot, as a css percentage */
  height: string;
  /** the face of the spine, already a gradient with its lit and shadowed edges */
  background: string;
  /** what the title and score are stamped in */
  ink: string;
  /** bands, rules and the publisher's mark */
  accent: string;
  pattern: LiveryPattern;
  direction: SpineDirection;
  /** printed small at the foot, the way a publisher's name is */
  imprint?: string;
  /** named so the sheet can say where the look came from */
  livery?: Livery;
  /** a data URL, the cover's own edge stretched to fill the spine — set
      only where no livery matched, which is also the only case where
      `background` is a flat ground rather than the thing actually shown.
      See `extractEdgeStrip`; drawn by `SpineWall` as a second background
      layer under the same lit/shadowed sheen `bind` paints for everyone
      else. */
  textureUrl?: string;
  /** true when this is drawn from real data rather than from the rating */
  real: boolean;
}

/* Thickness in the data mode: unchanged from what the wall has always done.
   Logarithmic, because book lengths are — the step from 30k words to 60k is
   the same *kind* of difference as 150k to 300k, and a linear map spends
   most of its range on the handful of long ones. */
const MIN_W = 21;
const MAX_W = 52;
const THIN_BOOK = 25_000;
const THICK_BOOK = 260_000;

function dataWidth(r: RatingRecord): number {
  const words = spineWeight(r);
  const t =
    (Math.log(Math.max(THIN_BOOK, Math.min(THICK_BOOK, words))) - Math.log(THIN_BOOK)) /
    (Math.log(THICK_BOOK) - Math.log(THIN_BOOK));
  return Math.round(MIN_W + t * (MAX_W - MIN_W));
}

/* Height in the data mode. A nought still stands at 40%: a book you hated is
   still a book you finished, and a shelf where the bad ones vanish is a
   shelf that lies about how the year went. */
const dataHeight = (r: RatingRecord): string =>
  `${(40 + (Math.max(0, Math.min(10, r.overall)) / 10) * 60).toFixed(1)}%`;

/** The gradient that makes a flat rectangle look like a bound edge: lit down
    the left where the light falls, shadowed at the right where it turns away. */
const bind = (face: string, lip: string, edge: string): string =>
  `linear-gradient(100deg, ${lip} 0 8%, ${face} 22% 78%, ${edge} 100%)`;

export interface LookInput {
  rating: RatingRecord;
  edition?: EditionData;
  /** the publisher named by the EPUB, which beats the catalogue's guess */
  publisher?: string;
  /** the edition's language, for which way the title runs */
  language?: string;
  mode: ShelfMode;
  dark: boolean;
}

/**
 * How to draw one book.
 *
 * Falls back a step at a time rather than all at once, which matters
 * because a half-known book is the common case: a shelf where the six books
 * with covers look real and the rest look like the old wall is a mess, so
 * the realistic mode uses whatever it has — real thickness from a page
 * count with no cover, real colour from a cover with no page count — and
 * only what is genuinely unknown falls back to the mood.
 */
/**
 * Whether an edition record says anything a shelf can draw.
 *
 * A lookup that found nothing still writes a row — that is deliberate, so
 * the app stops asking — and the row is `{ key }` and nothing else. Drawing
 * it as real would be worse than not trying: every unknown book would come
 * out the same default height in the same mood colour, so a shelf where
 * half the books were found would be a real shelf with a row of identical
 * grey blanks through it. Better that those keep the spine they had.
 */
/* Exported so a caller can tell a definitive catalogue miss (a row on disk
   that knows nothing) apart from "not looked up yet" (no row at all) —
   which is exactly the distinction the own-cover fallback needs. See
   `src/meta/ownCover.ts`. */
export const knowsAnything = (e: EditionData): boolean =>
  Boolean(e.palette?.length || e.pageCount || e.publisher || e.series || e.heightMm);

export function spineLook(input: LookInput): SpineLook {
  const { rating, edition, mode, dark } = input;
  const mood = moodOf(rating.mood);

  if (mode === 'data' || !edition || !knowsAnything(edition)) {
    const face = moodColor(mood, dark);
    return {
      width: dataWidth(rating),
      height: dataHeight(rating),
      background: bind(face, moodColor(mood, dark, 7), moodColor(mood, dark, -9)),
      ink: moodInk(mood, dark),
      accent: moodInk(mood, dark),
      pattern: 'plain',
      direction: 'down',
      real: false,
    };
  }

  /* The publisher from the EPUB first: it names the edition actually in
     hand, where the catalogue names a best match for it. A book imported
     as a Reclam should be drawn as a Reclam even if Google's top hit for
     the same title was a dtv. */
  const livery = liveryFor({
    publisher: input.publisher ?? edition.publisher,
    series: edition.series,
  });

  const metrics = realMetrics({
    /* A livery knows its own trim height, and it is a better number than a
       default: a Reclam is 148 mm and a Manesse is 168, and neither is the
       190 that "a book" means. Only the catalogue's own measurement beats
       it, since that one is about this printing rather than the series. */
    heightMm: edition.heightMm ?? livery?.heightMm ?? DEFAULT_HEIGHT_MM,
    pageCount: edition.pageCount,
    words: rating.words,
  });

  const ground =
    /* The livery wins over the cover's own colours, which sounds backwards
       and is not: a series livery is the thing the spine *is*, while the
       cover palette is an inference about what it might be. When a book is
       a Penguin, drawing it in Penguin orange is not an approximation. */
    livery?.ground ?? groundFrom(edition.palette) ?? moodColor(mood, dark);

  const ink = livery?.ink ?? inkOn(ground);
  const accent = livery?.accent ?? (edition.palette?.[1] ?? shade(ground, luma(ground) > 0.5 ? -0.35 : 0.35));

  return {
    ...metrics,
    background: bind(ground, shade(ground, 0.16), shade(ground, -0.22)),
    ink,
    accent,
    pattern: livery?.pattern ?? 'plain',
    direction: spineDirection(input.language ?? edition.language),
    ...(livery?.imprint ? { imprint: livery.imprint } : {}),
    ...(livery ? { livery } : {}),
    /* Only where no livery matched: a livery is a real convention for how
       that publisher's spine looks, and beats a guess made from one edge
       of the front cover the same way it already beats the cover's own
       palette a few lines up. */
    ...(!livery && edition.edgeTexture ? { textureUrl: edition.edgeTexture } : {}),
    real: true,
  };
}
