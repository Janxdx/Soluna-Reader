/* How a book is drawn standing up.
 *
 * One shelf, drawn from whatever is known about each book — the honest
 * version of a choice that used to be a toggle. Three things, layered so a
 * half-known book still looks like a book rather than a mismatch of two
 * styles:
 *
 *   Thickness   real page count where one is known, else the word count a
 *               rating already carries. Both readings always fell back
 *               this way; there was never a second thickness to merge.
 *
 *   Height      real millimetres where the catalogue or a matched livery
 *               says so. Otherwise a height derived from the book's own
 *               length, with a small deterministic jitter on top — a
 *               flat default height for everything unknown reads as a
 *               fence, not a shelf, and jittering from the title rather
 *               than the clock keeps a given shelf looking the same on
 *               every launch.
 *
 *   Colour      the cover's own bound colour where a cover exists, a
 *               matched publisher's livery where one applies (and a
 *               livery beats the cover: it is what the spine *is*, not an
 *               inference about it), and the mood you rated the book in
 *               as the last resort. That last fallback is not a
 *               downgrade — it is the whole reason a shelf of nothing but
 *               ratings still reads as a shelf, and it is also the only
 *               place score used to live. It doesn't any more: with
 *               height spoken for by the object's own size, the score
 *               survives only as the number stamped at the foot, which
 *               you have to walk up and read, exactly as you would with a
 *               real shelf. The mood ribbon, the score curve and the
 *               radar below the wall are where the numbers actually live
 *               now.
 *
 * Browser-free like the rest of engine/: colours in, CSS values out, no DOM.
 */

import {
  liveryFor,
  realMetrics,
  spineDirection,
  type EditionData,
  type Livery,
  type LiveryPattern,
  type SpineDirection,
} from './edition';
import { moodColor, moodInk, moodOf, spineWeight, type RatingRecord } from './rating';

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
  /** true when this is drawn from real data rather than an unknown book's
      fallback */
  real: boolean;
}

/** The gradient that makes a flat rectangle look like a bound edge: lit down
    the left where the light falls, shadowed at the right where it turns away. */
const bind = (face: string, lip: string, edge: string): string =>
  `linear-gradient(100deg, ${lip} 0 8%, ${face} 22% 78%, ${edge} 100%)`;

/* ── height for a book whose real trim size isn't known ──────────────
 *
 * The common case for anything logged by hand rather than looked up. A
 * flat default height for every such book would make the "unknown" rows
 * of a shelf a visible fence — the one thing a real shelf never is, even
 * one nobody has catalogued. Trim height correlates loosely with length
 * (a doorstop novel is rarely a duodecimo), so the same length signal that
 * sets thickness sets a baseline here too, with a small jitter on top so
 * two books of similar length don't stand dead level with each other.
 *
 * The jitter is hashed from the title rather than drawn from `Math.random`
 * on purpose: a shelf that reshuffled its own guesses on every launch
 * would read as broken, not alive. Hashing the title keeps a given book at
 * the same guessed height for as long as it goes unlooked-up, and gives it
 * a new, real one the moment a lookup lands.
 */
const THIN_BOOK = 25_000;
const THICK_BOOK = 260_000;
const MIN_H = 55;
const MAX_H = 88;
const JITTER_H = 7;

function titleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function jitterHeight(rating: RatingRecord): string {
  const words = spineWeight(rating);
  const t =
    (Math.log(Math.max(THIN_BOOK, Math.min(THICK_BOOK, words))) - Math.log(THIN_BOOK)) /
    (Math.log(THICK_BOOK) - Math.log(THIN_BOOK));
  const base = MIN_H + t * (MAX_H - MIN_H);
  const jitter = ((titleHash(rating.title) % 1000) / 1000 - 0.5) * 2 * JITTER_H;
  const h = Math.max(40, Math.min(96, base + jitter));
  return `${h.toFixed(1)}%`;
}

export interface LookInput {
  rating: RatingRecord;
  edition?: EditionData;
  /** the publisher named by the EPUB, which beats the catalogue's guess */
  publisher?: string;
  /** the edition's language, for which way the title runs */
  language?: string;
  dark: boolean;
}

/**
 * How to draw one book.
 *
 * Falls back a step at a time rather than all at once, which matters
 * because a half-known book is the common case: a shelf where the six
 * books with covers look real and the rest look like a placeholder is a
 * mess, so this uses whatever it has — real thickness from a page count
 * with no cover, real colour from a cover with no page count — and only
 * what is genuinely unknown falls back to the mood.
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
  const { rating, edition, dark } = input;
  const mood = moodOf(rating.mood);

  if (!edition || !knowsAnything(edition)) {
    const face = moodColor(mood, dark);
    return {
      width: realMetrics({ words: rating.words }).width,
      height: jitterHeight(rating),
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

  /* A livery knows its own trim height, and it is a better number than a
     flat default: a Reclam is 148 mm and a Manesse is 168, and neither is
     the 190 that "a book" means. Only the catalogue's own measurement
     beats it, since that one is about this printing rather than the
     series. Nothing here falls back to a flat default any more — where
     neither is known, the height guess above is used instead. */
  const resolvedHeightMm = edition.heightMm ?? livery?.heightMm;
  const metrics = realMetrics({
    heightMm: resolvedHeightMm,
    pageCount: edition.pageCount,
    words: rating.words,
  });
  const height = resolvedHeightMm ? metrics.height : jitterHeight(rating);

  const ground =
    /* The livery wins over the cover's own colours, which sounds backwards
       and is not: a series livery is the thing the spine *is*, while the
       cover palette is an inference about what it might be. When a book is
       a Penguin, drawing it in Penguin orange is not an approximation. */
    livery?.ground ?? groundFrom(edition.palette) ?? moodColor(mood, dark);

  const ink = livery?.ink ?? inkOn(ground);
  const accent = livery?.accent ?? (edition.palette?.[1] ?? shade(ground, luma(ground) > 0.5 ? -0.35 : 0.35));

  return {
    width: metrics.width,
    height,
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
