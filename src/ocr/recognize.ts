/* Reading a page of print, on the device.

   Two ways in, and the difference between them matters more than it looks.

   On iPadOS the keyboard itself will scan: focus a text field, choose Scan
   Text, point the camera at the page, and the words arrive in the field
   already recognised — by the same engine that does it in Notes, which is
   markedly better at curved paper and raking light than anything that fits
   in a download. Nothing is captured. There is no image, no file, no blob;
   the photograph never exists at any point, so there is nothing to promise
   to delete.

   Everywhere else there has to be a picture, so this module makes one, reads
   it, and destroys it. `recognizeImage` takes the bitmap no further than the
   canvas it is drawn on: the canvas is torn down before the function
   returns, the Tesseract worker is fed pixels rather than a file handle, and
   nothing is written to storage at any point. The image exists for about a
   second, in memory, and then does not.

   The recognised text is not stored either — it goes to `locatePassage`,
   which turns it into a position, and the position is all that is kept.

   Browser code: canvas, OffscreenCanvas, dynamic import. Not engine. */

import type { Worker as TesseractWorker } from 'tesseract.js';
import { flatten } from './field';
import { DEFAULT_LANG } from './language';

export { DEFAULT_LANG, isNonDefault, tesseractLang } from './language';

/* ── which path is available ───────────────────────────────────────── */

/**
 * Whether the keyboard is likely to offer Scan Text.
 *
 * There is no feature query for this — Live Text is a keyboard affordance,
 * not a web API, and the page is never told whether it appeared. So this is
 * a platform guess, and it is used only to decide which option to put first
 * and how to word the hint. Both paths stay reachable whatever it returns,
 * because a guess that silently removed the working option would be a bug
 * you could not report.
 */
export function liveTextLikely(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const macSafari = /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua);
  return iOS || macSafari;
}

/* ── preparing the picture ─────────────────────────────────────────── */

/* Tesseract wants roughly 300 dpi of text and nothing else. A modern phone
   camera hands over twelve megapixels, which is four times more detail than
   the recogniser can use and about four times the work. Downscaling the long
   edge to this is the single biggest speed win available, and it costs no
   accuracy on body text photographed from a normal distance. */
const TARGET_LONG_EDGE = 1800;

/* Wider than this and we assume the camera caught both pages of an open
   book. It is a crude test and it is the right one: a single page is taller
   than it is wide in every trade format there is, so anything landscape is
   either a spread or a photograph with a lot of desk in it, and both want
   the layout analyser switched on rather than off. */
const SPREAD_ASPECT = 1.15;

interface Prepared {
  canvas: HTMLCanvasElement;
  /** true when the frame looks like an open book rather than one page */
  spread: boolean;
  /** releases the canvas and every pixel behind it */
  dispose: () => void;
}

/**
 * Decode, downscale and flatten a captured image, and hand back something
 * disposable. The caller must call `dispose` — the whole privacy claim of
 * this module rests on it, so `recognizeImage` does it in a `finally`.
 *
 * "Flatten" here means the lighting, not the greys: see `./field`.
 */
async function prepare(blob: Blob): Promise<Prepared> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, TARGET_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not prepare the image for scanning.');
    ctx.drawImage(bitmap, 0, 0, w, h);

    const pixels = ctx.getImageData(0, 0, w, h);
    flatten(pixels.data, w, h);
    ctx.putImageData(pixels, 0, 0);

    return {
      canvas,
      spread: w / h > SPREAD_ASPECT,
      dispose: () => {
        /* Setting either dimension to zero frees the backing store
           immediately rather than whenever the collector next runs — worth
           doing explicitly for something we have just told the reader we
           would not keep. */
        canvas.width = 0;
        canvas.height = 0;
      },
    };
  } finally {
    bitmap.close();
  }
}

/* ── the recogniser ────────────────────────────────────────────────── */

/* Starting a Tesseract worker means fetching a WASM core and a language
   model and initialising both: a few seconds and a few megabytes, once. The
   worker is kept between scans because correcting a mis-scan is the common
   case and paying that twice in a row would be unforgivable. It is not kept
   forever — an idle recogniser holding tens of megabytes is the kind of
   thing that gets a tab killed on an iPad.

   It is kept *per language*, which in practice means one at a time. A
   Tesseract worker is initialised with its traineddata and cannot be asked
   to change its mind, so scanning a German novel after an English one has to
   tear the first one down. That is the right trade: nobody alternates
   between two books mid-scan, and holding two WASM heaps to make the rare
   case fast would cost the common case its tab.

   Where those megabytes come from is worth stating plainly, because it is
   the one part of this feature that is not local: on first use tesseract.js
   fetches its worker script, its WASM core and `<lang>.traineddata` from
   jsdelivr, and caches the language data in IndexedDB afterwards. So the
   photo path needs a connection the first time it meets a given language and
   none after it, and the Live Text path needs none ever. What never leaves
   the device either way is the page: the image is decoded, recognised and
   destroyed here, and nothing is uploaded to anyone at any point.

   To make the photo path work offline from the start, vendor the files into
   `public/` and pass `workerPath`, `corePath` and `langPath` below. That is
   a deliberate trade — about 15 MB in the app shell, per language — and
   until someone asks for it, the download stays lazy. */
const IDLE_TERMINATE_MS = 90_000;

interface Live {
  worker: TesseractWorker;
  lang: string;
}

let live: Live | null = null;
let starting: Promise<Live> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export type ScanStage = 'loading' | 'recognizing';
export type ScanProgress = (stage: ScanStage, fraction: number) => void;

export interface ScanOptions {
  /** traineddata name, from `tesseractLang(book.meta.language)` */
  lang?: string;
  onProgress?: ScanProgress;
}

async function getWorker(lang: string, onProgress?: ScanProgress): Promise<TesseractWorker> {
  if (live && live.lang === lang) return live.worker;
  if (starting) {
    const ready = await starting;
    if (ready.lang === lang) return ready.worker;
  }
  if (live && live.lang !== lang) await releaseRecognizer();

  starting = (async () => {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(lang, 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') onProgress?.('recognizing', m.progress);
        else onProgress?.('loading', m.progress);
      },
    });

    const ready: Live = { worker, lang };
    live = ready;
    return ready;
  })();

  try {
    return (await starting).worker;
  } finally {
    starting = null;
  }
}

/* A page of a novel is one block of text in one column, and saying so stops
   the layout analyser from deciding that a running head, a folio and the
   body are three unrelated regions and returning them in an order that is
   not reading order — which matters here, because the whole match depends on
   word sequence.

   A spread is the opposite case, and the old code got it badly wrong. Told
   there is a single block, Tesseract reads *across the gutter*: line one of
   the left page, then line one of the right, then line two of the left. The
   words are all correct and the sequence is shredded, which is the one
   failure `locatePassage` cannot absorb — it aligns sequences, so a perfect
   scan of a spread scores about as well as noise. `AUTO` finds the two
   columns and reads them in order. */
async function segmentFor(worker: TesseractWorker, spread: boolean): Promise<void> {
  const { PSM } = await import('tesseract.js');
  await worker.setParameters({
    tessedit_pageseg_mode: spread ? PSM.AUTO : PSM.SINGLE_BLOCK,
    preserve_interword_spaces: '1',
  });
}

function scheduleTerminate(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const w = live?.worker;
    live = null;
    idleTimer = null;
    void w?.terminate();
  }, IDLE_TERMINATE_MS);
}

/** Drop the recogniser now, freeing its WASM heap. Safe to call any time. */
export async function releaseRecognizer(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const w = live?.worker;
  live = null;
  if (w) await w.terminate();
}

/**
 * Text from a photograph of a page. The image is not stored, and is
 * destroyed before this returns.
 *
 * Errors are left to the caller: a failure here is worth showing, because
 * the alternative is a reader waiting on a spinner that has already given up.
 */
export async function recognizeImage(
  blob: Blob,
  options: ScanOptions = {}
): Promise<string> {
  const { lang = DEFAULT_LANG, onProgress } = options;
  let prepared: Prepared | null = null;
  try {
    onProgress?.('loading', 0);
    const worker = await getWorker(lang, onProgress);
    prepared = await prepare(blob);
    await segmentFor(worker, prepared.spread);
    const result = await worker.recognize(prepared.canvas);
    return result.data.text ?? '';
  } finally {
    prepared?.dispose();
    scheduleTerminate();
  }
}
