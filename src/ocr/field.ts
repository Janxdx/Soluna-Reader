/* Taking the lamp out of the photograph.

   A scanner gives Tesseract an evenly lit page. A phone held over a paperback
   at ten at night gives it a pool of light in the middle, a shadow down the
   gutter where the page curls into the spine, and the photographer's own head
   somewhere on the left. The paper in the bright part can be brighter than
   the *ink* in the dark part, and no single global threshold — which is what
   a contrast stretch about a fixed midpoint amounts to — can separate them,
   because there is no single number that is above the ink everywhere and
   below the paper everywhere.

   So don't look for one. Illumination varies slowly across the frame and ink
   varies fast, which means the slow part can be measured and divided out:

     estimate   for each tile of the image, what the *paper* is doing there —
                a high percentile of its brightness, because paper is the
                bright thing and ink is the rare dark thing
     smooth     blur that grid, so a tile that happened to be all ink doesn't
                punch a hole in the field
     divide     scale every pixel by how bright its paper was, so paper goes
                to white everywhere and ink keeps whatever it had

   What comes out is flat, which is the one thing Tesseract's own adaptive
   thresholding is entitled to assume and was not getting.

   Note what this deliberately does *not* do: binarise. Tesseract places
   character edges using the anti-aliasing in the greys, and handing it ones
   and zeroes throws that away. We flatten the lighting and leave the ink
   alone.

   Pure arithmetic over a pixel buffer. No DOM, no canvas — testable. */

/** Side of the square the background is measured over, in pixels.

    At the 1800px long edge `prepare` targets, this is about 28 tiles across:
    fine enough to follow a gutter shadow, coarse enough that a tile almost
    always contains some paper. Much smaller and a tile inside a bold heading
    is all ink; much larger and the field stops tracking the curl. */
export const TILE = 64;

/** Where in a tile's brightness histogram we call it "the paper".

    Not the maximum: one specular highlight off a gloss page, or a single
    blown-out pixel, would set the level for the whole tile and drag
    everything around it grey. The 90th percentile ignores that and still
    sits in the paper on any tile that is at least a tenth blank — which,
    for body text, every tile is. */
const PAPER_PERCENTILE = 0.9;

/** The most we will brighten any pixel.

    This is the guard for a tile that genuinely holds no paper — the middle of
    a woodcut, a full-bleed plate, the dark half of a photograph that caught
    the desk. There the percentile lands on ink, and dividing by it would
    amplify that tile into noise for the layout analyser to find words in.

    Capping the *gain* rather than flooring the background is what lets the
    two cases be told apart, and they have to be, because they look identical
    tile by tile. Six is a 6:1 range of illumination across one frame, which
    is more than a gutter shadow or a lamp off to one side ever produces and
    much less than paper-to-plate. So real paper in real shadow is always
    lifted to white; a region with no paper in it is left dark. */
const MAX_GAIN = 6;

/** After flattening, a last gentle pull about the midpoint. Small, because
    the flattening has already done the work this used to be doing alone. */
const CONTRAST = 1.2;

export interface Field {
  /** one background level per tile, row-major */
  level: Float32Array;
  cols: number;
  rows: number;
  tile: number;
}

/** Luminance, the usual weights, into a byte per pixel. */
export function toGrey(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const grey = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < grey.length; i += 4, p++) {
    grey[p] = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) | 0;
  }
  return grey;
}

/**
 * Measure what the paper is doing across the frame.
 *
 * One 256-bin histogram per tile, walked once to find the percentile. That
 * is a single pass over the image plus a pass over 28×40 tiny histograms,
 * which is why this can sit in front of every scan without being noticed.
 */
export function backgroundField(
  grey: Uint8Array,
  w: number,
  h: number,
  tile: number = TILE
): Field {
  const cols = Math.max(1, Math.ceil(w / tile));
  const rows = Math.max(1, Math.ceil(h / tile));
  const level = new Float32Array(cols * rows);

  const hist = new Int32Array(256);
  for (let ty = 0; ty < rows; ty++) {
    const y0 = ty * tile;
    const y1 = Math.min(h, y0 + tile);
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * tile;
      const x1 = Math.min(w, x0 + tile);

      hist.fill(0);
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          hist[grey[row + x]]++;
          n++;
        }
      }

      /* Walk down from white until we have passed the top tenth: that
         value is the paper. Counting from the bright end rather than the
         dark one means a tile that is mostly ink still reports whatever
         paper it has. */
      const target = Math.max(1, Math.round(n * (1 - PAPER_PERCENTILE)));
      let seen = 0;
      let v = 255;
      for (let b = 255; b >= 0; b--) {
        seen += hist[b];
        if (seen >= target) {
          v = b;
          break;
        }
      }
      level[ty * cols + tx] = v;
    }
  }

  /* A 3×3 box blur over the grid. Illumination is smooth by nature, so any
     sharp step in this field is measurement error — a tile that fell inside
     a heading, a tile clipped at the frame edge — and smoothing is how that
     error gets shared out instead of printed onto the image as a seam. */
  const smoothed = new Float32Array(level.length);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const y = ty + dy;
        if (y < 0 || y >= rows) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = tx + dx;
          if (x < 0 || x >= cols) continue;
          sum += level[y * cols + x];
          n++;
        }
      }
      smoothed[ty * cols + tx] = Math.max(1, sum / n);
    }
  }

  return { level: smoothed, cols, rows, tile };
}

/**
 * The background level under one pixel, interpolated between tile centres.
 *
 * Bilinear rather than nearest, because nearest would lay a 64px checkerboard
 * over the page and every tile boundary would become an edge for the layout
 * analyser to find.
 */
export function sampleField(field: Field, x: number, y: number): number {
  const { level, cols, rows, tile } = field;

  const fx = Math.min(cols - 1, Math.max(0, x / tile - 0.5));
  const fy = Math.min(rows - 1, Math.max(0, y / tile - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const a = level[y0 * cols + x0];
  const b = level[y0 * cols + x1];
  const c = level[y1 * cols + x0];
  const d = level[y1 * cols + x1];

  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * Flatten the lighting of an RGBA buffer in place, leaving it grey.
 *
 * In place because the buffer is an ImageData the caller is about to put
 * straight back onto the canvas it came from, and because the whole point of
 * this module's neighbourhood is that the photograph exists briefly and in
 * one place.
 */
export function flatten(rgba: Uint8ClampedArray, w: number, h: number): void {
  if (w <= 0 || h <= 0) return;

  const grey = toGrey(rgba, w, h);
  const field = backgroundField(grey, w, h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const bg = sampleField(field, x + 0.5, y + 0.5);
      const gain = Math.min(MAX_GAIN, 255 / bg);
      let v = grey[row + x] * gain;
      v = (v - 128) * CONTRAST + 128;
      v = v < 0 ? 0 : v > 255 ? 255 : v;

      const i = (row + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
    }
  }
}
