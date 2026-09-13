import { toGrey, backgroundField, sampleField, flatten, TILE } from '../src/ocr/field.ts';

let fails = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) { fails++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
  else console.log(`ok   ${name}`);
};
const near = (name: string, got: number, want: number, tol: number) => {
  ok(name, Math.abs(got - want) <= tol, `got ${got.toFixed(1)} want ~${want} ±${tol}`);
};

/* ── a page, lit from one side ─────────────────────────────────────────

   The synthetic page below is the exact situation that defeats a global
   contrast stretch, built so the numbers are checkable by hand.

   Illumination falls linearly from full on the left to a quarter on the
   right. The page itself is paper (reflectance 1) with horizontal bars of
   ink (reflectance 0.25) over a quarter of its rows. Multiply the two and
   the ink on the bright side and the paper on the dark side arrive at the
   *same* brightness, 64. No single threshold can separate them, and the old
   `(v - 128) * 1.35 + 128` was exactly such a threshold. */

const W = 512;
const H = 256;
const PAPER = 1;
const INK = 0.25;

const lit = (x: number): number => 255 * (1 - 0.75 * (x / W));
const inky = (y: number): boolean => y % 16 < 4;

function page(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = lit(x) * (inky(y) ? INK : PAPER);
      const i = (y * W + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

{
  const before = page();
  const g = toGrey(before, W, H);
  const inkLeft = g[1 * W + 0];              // an ink row, brightest column
  const paperRight = g[8 * W + (W - 1)];     // a paper row, darkest column
  near('the trap: ink in the light equals paper in the shadow', inkLeft, paperRight, 2);
}

/* ── greying ───────────────────────────────────────────────────────── */

{
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  const g = toGrey(rgba, 2, 1);
  ok('white greys to white', g[0] === 255);
  ok('black greys to black', g[1] === 0);
}

/* ── the field itself ──────────────────────────────────────────────── */

{
  const flat = new Uint8Array(W * H).fill(200);
  const f = backgroundField(flat, W, H);
  ok('a flat image gives a flat field', f.level.every((v) => Math.abs(v - 200) < 1));
  ok('the grid covers the image', f.cols === Math.ceil(W / TILE) && f.rows === Math.ceil(H / TILE));
}

{
  const g = toGrey(page(), W, H);
  const f = backgroundField(g, W, H);

  /* The field must follow the lamp, not the ink: it is measured from a high
     percentile precisely so that a quarter of the pixels being ink moves it
     hardly at all. Sampled at tile centres, where it is interpolated rather
     than extrapolated.

     It reads a few levels bright, consistently, and that is inherent rather
     than a bug: the brightest tenth of a tile sitting on a gradient is its
     upslope edge, not its centre. A background estimate that errs bright
     errs towards leaving ink alone, which is the safe direction — the
     opposite mistake eats thin strokes. */
  near('the field finds the paper on the lit side', sampleField(f, 96, 128), lit(96), 12);
  near('and in the shadow, four stops down', sampleField(f, 416, 128), lit(416), 12);
  ok(
    'the shadow is read as shadow, not floored to the page average',
    sampleField(f, 416, 128) < sampleField(f, 96, 128) / 2
  );

  let monotone = true;
  for (let x = TILE; x < W; x += 8) {
    if (sampleField(f, x, 128) > sampleField(f, x - 8, 128) + 1) monotone = false;
  }
  ok('the field falls the way the light does', monotone);
}

/* ── what the whole thing is for ───────────────────────────────────── */

{
  const rgba = page();
  flatten(rgba, W, H);

  /* Measured over the interior. The field is sampled at tile centres, so the
     outer half-tile is the one place it is extrapolated rather than measured,
     and on a gradient this steep that shows. On a real page that band is the
     margin the camera caught, not text. */
  let paperMin = 255;
  let inkMax = 0;
  for (let y = TILE / 2; y < H - TILE / 2; y++) {
    for (let x = TILE / 2; x < W - TILE / 2; x++) {
      const v = rgba[(y * W + x) * 4];
      if (inky(y)) inkMax = Math.max(inkMax, v);
      else paperMin = Math.min(paperMin, v);
    }
  }

  ok('paper comes out as paper everywhere', paperMin > 200, `darkest paper ${paperMin}`);
  ok('ink stays ink everywhere', inkMax < 120, `lightest ink ${inkMax}`);
  ok('one threshold now separates them', paperMin > inkMax, `${paperMin} vs ${inkMax}`);
}

/* ── the guard ─────────────────────────────────────────────────────── */

{
  /* A plate, a woodcut, a photograph of the facing page: a region with no
     paper in it at all. Dividing by a background measured from ink would
     amplify that region into noise, which the floor exists to prevent. */
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = x > W / 2 ? 4 : 240;
      const i = (y * W + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  flatten(rgba, W, H);

  let finite = true;
  let blackBlockMax = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = rgba[(y * W + x) * 4];
      if (!Number.isFinite(v)) finite = false;
      if (x > W / 2 + TILE) blackBlockMax = Math.max(blackBlockMax, v);
    }
  }
  ok('no pixel escapes the byte range', finite);
  ok('a paperless region is not amplified into noise', blackBlockMax < 64, `max ${blackBlockMax}`);
}

/* ── degenerate sizes ──────────────────────────────────────────────── */

{
  const one = new Uint8ClampedArray([120, 120, 120, 255]);
  flatten(one, 1, 1);
  ok('a single pixel survives', Number.isFinite(one[0]));

  const none = new Uint8ClampedArray(0);
  flatten(none, 0, 0);
  ok('an empty buffer is a no-op', none.length === 0);
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
