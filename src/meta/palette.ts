/* The colours a book actually is.
 *
 * A generated spine is honest but arbitrary — `book.hue` is a number derived
 * from an id, so a Penguin and a Suhrkamp get whatever the hash felt like.
 * Reading the cover instead is the single change that makes a shelf look
 * like a shelf: the orange stays orange, the yellow Reclam stays yellow, and
 * a run of books from one publisher lines up the way it does on a real one.
 *
 * ─── why this can work at all ──────────────────────────────────────
 *
 * Only because the cover is served from our own origin. `getImageData` on a
 * canvas that has drawn a cross-origin image throws a SecurityError — the
 * canvas is *tainted*, and no amount of crossOrigin juggling fixes it when
 * the far end doesn't send the header. Proxying the cover through the
 * Worker into R2 was mostly done for the User-Agent and the API key; this
 * is the part that would have forced it anyway.
 *
 * ─── the algorithm, and why not a better one ───────────────────────
 *
 * Bucket into a coarse cube, drop the near-greys, take the fullest buckets.
 * k-means would give prettier centroids and it is not worth it: this runs
 * once per book on an iPad, the input is a 64-pixel-wide thumbnail, and the
 * question being asked is "roughly what colour is this", which a histogram
 * answers exactly as well.
 */

/** Colours per book. Enough for a ground, a band and an ink. */
const WANT = 4;

/* Downscale target. Small on purpose: it is 4096 pixels to walk instead of
   half a million, and averaging away the type and the texture is a feature
   — a cover's *colour* is what survives being squinted at. */
const SAMPLE = 64;

/** Bits kept per channel when bucketing. Five would separate shades nobody
    can tell apart; three collapses a cover into eight boxes. */
const BITS = 4;
const SHIFT = 8 - BITS;

export interface Swatch {
  hex: string;
  /** 0–1, share of the sampled pixels */
  weight: number;
  /** perceived lightness, 0–1 — what decides whether ink goes light or dark */
  luma: number;
}

const luminance = (r: number, g: number, b: number): number =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * The dominant colours of an image, most common first.
 *
 * Returns an empty array rather than throwing when anything goes wrong —
 * a decode failure, a tainted canvas, a browser without OffscreenCanvas.
 * Every caller's fallback is the generated spine it was already drawing,
 * so a failure here costs nothing and must not take a shelf down with it.
 */
export async function extractPalette(blob: Blob): Promise<Swatch[]> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);

    const scale = Math.min(1, SAMPLE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);
    return quantize(data);
  } catch {
    return [];
  } finally {
    /* Explicitly, in a finally, for the same reason the OCR path does it:
       an ImageBitmap holds decoded pixels outside the JS heap, so leaving
       it to the collector means a shelf of sixty books can hold sixty
       full-size decoded covers in memory at once. */
    bitmap?.close();
  }
}

/* ── the edge, stretched into a spine ────────────────────────────────
 *
 * `extractPalette` answers "roughly what colour is this cover" with one
 * flat swatch. A spine is not flat, and a real one usually carries the
 * cover's own edge — its background colour, and whatever horizontal bands
 * sit near that margin — down its whole height. Sampling that edge and
 * stretching it, rather than averaging the cover into a single ground the
 * way `groundFrom` does, is what lets a spine with no livery still read as
 * an edition of *this* cover rather than of the mood it was rated.
 */

/** How far in from the cover's edge to sample, as a share of its width —
    not a fixed pixel count, so a phone photo and a Google Books thumbnail
    crop the same fraction of the cover regardless of resolution. */
const EDGE_FRACTION = 0.08;

/** Output size. Small on purpose: the blur below throws away anything a
    few pixels of width could not hold, and a canvas this size keeps the
    resulting PNG a few hundred bytes — cheap enough to store inline as a
    data URL rather than a second object to fetch. */
const TEX_W = 12;
const TEX_H = 220;

/**
 * A strip off the edge of a cover, stretched and softened into something a
 * spine can be drawn in.
 *
 * Not a crop of the spine — nobody's catalogue holds one, see the note at
 * the top of `engine/edition.ts` — an *inference* from the one edge of the
 * cover that would, if the book were rebound, become the spine's own face.
 * Reads top to bottom rather than reducing to one swatch, which is the
 * point: a title block near the head and plain stock below comes back as a
 * title block near the head and plain stock below.
 *
 * Blurred hard, deliberately, rather than trying to judge whether the edge
 * is "clean enough" to use raw the way `quantize` judges a palette. A sharp
 * crop risks smearing a letter or a barcode fragment the width of a spine;
 * a soft one reads as an ambient colour wash whatever was actually printed
 * there, which is the honest thing to promise from a single edge of
 * pixels. Never lets a livery down, either — `spineLook` only reaches for
 * this where no livery matched, the same rule `groundFrom` already answers
 * to.
 */
export async function extractEdgeStrip(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);

    const edgePx = Math.max(2, Math.round(bitmap.width * EDGE_FRACTION));

    const canvas = document.createElement('canvas');
    canvas.width = TEX_W;
    canvas.height = TEX_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    /* The blur runs in the same draw that does the stretching, so nothing
       sharp survives long enough to alias when a few thousand source
       pixels become twelve. */
    ctx.filter = 'blur(3px)';
    ctx.drawImage(bitmap, 0, 0, edgePx, bitmap.height, 0, 0, TEX_W, TEX_H);

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/**
 * Is this pixel paper or ink rather than colour?
 *
 * Near-white and near-black are dropped before bucketing: almost every
 * cover has a white margin and black type, both would win on volume, and
 * "this book is mostly paper" is true of all of them.
 *
 * The test is on the *lowest* channel, not the highest, and that
 * distinction is the whole correctness of this function. White means every
 * channel is high. A saturated red is (250, 40, 40) — its highest channel
 * is as high as white's, so a test on the maximum throws away exactly the
 * vivid covers this feature exists for, and quietly: the palette comes back
 * empty, `groundFrom` returns null, and the spine falls back to the mood
 * grey as though nothing had been found at all. Which is what shipped.
 */
export function isPaperOrInk(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (min > 242) return true; // white: every channel high
  if (max < 26) return true; // black: every channel low
  // unsaturated and at either extreme — a grey margin, a grey shadow
  return max - min < 16 && (max > 220 || max < 40);
}

function quantize(data: Uint8ClampedArray): Swatch[] {
  /* Two passes over the same pixels rather than one. The first ignores
     paper and ink; the second, run only if the first found nothing, takes
     everything. A cover that really is all cream — plenty of literary
     paperbacks are — should come back cream rather than come back empty
     and be drawn as though the lookup had failed. */
  return bucket(data, true) ?? bucket(data, false) ?? [];
}

function bucket(data: Uint8ClampedArray, skipNeutrals: boolean): Swatch[] | null {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let counted = 0;

  for (let i = 0; i < data.length; i += 4) {
    // transparent corners are the frame, not the cover
    if (data[i + 3] < 128) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (skipNeutrals && isPaperOrInk(r, g, b)) continue;

    const key = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    const found = buckets.get(key);
    if (found) {
      found.r += r;
      found.g += g;
      found.b += b;
      found.n++;
    } else {
      buckets.set(key, { r, g, b, n: 1 });
    }
    counted++;
  }

  /* A handful of surviving pixels is noise — an anti-aliasing halo around
     black type on white — and averaging it gives a colour the cover does
     not have. Treat it as nothing found and let the second pass answer. */
  if (counted < 24) return null;

  return [...buckets.values()]
    .sort((x, y) => y.n - x.n)
    .slice(0, WANT)
    .map((c) => {
      /* The bucket's mean rather than its centre: the centre is a rounding
         artefact and lands slightly off every time, which is visible when
         the colour is meant to match a printed one. */
      const r = c.r / c.n;
      const g = c.g / c.n;
      const b = c.b / c.n;
      return { hex: hex(r, g, b), weight: c.n / counted, luma: luminance(r, g, b) };
    });
}

/* Turning a palette into a spine happens in engine/spine.ts, which is
   browser-free and therefore cannot live in this file — `extractPalette`
   needs a canvas, and everything under engine/ must not. */
