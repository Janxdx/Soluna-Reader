/* The book's own cover, drawn on the spine when no catalogue has heard of
 * it.
 *
 * Google Books and Open Library answer most lookups, but not all — a
 * self-published or obscure title has no entry in either, and `ensureEdition`
 * still writes a row for that (`{ key }`, nothing else) so the app stops
 * asking. `knowsAnything` in `engine/spine.ts` is what reads that row and
 * says "nothing here" — and until now that meant the realistic shelf had
 * nothing to draw the spine with either: no cover, no metrics, so it fell
 * back to the mood colour exactly as if the shelf were still in Data mode.
 *
 * The EPUB's own cover is sitting on the device the whole time, though —
 * every imported book keeps one in `db.covers` — so on a definitive miss
 * this reads *that* cover's colour and edge the same way `meta/editions.ts`
 * reads a catalogue cover's, and the spine draws in the book's own colours
 * (or, where no livery applies, the book's own edge — see
 * `meta/palette.ts:extractEdgeStrip`) instead of grey. Deliberately a last
 * resort: a catalogue match is preferred whenever `knowsAnything` says there
 * is one, because it carries real metrics (a page count, a trim height) and
 * not just a guess made from a thumbnail.
 *
 * No network here, unlike `meta/editions.ts` — the source is already on
 * disk — so there is no pacing, no trouble to report, and no server row to
 * write: the answer is cheap enough to hold in memory for the session and
 * recompute next launch, the same way a device book's own metadata does.
 */

import { coverToBlob, db } from '../db';
import { extractEdgeStrip, extractPalette } from './palette';

export interface OwnCoverArt {
  /** dominant colours, darkest first — null when nothing usable survived */
  palette: string[] | null;
  /** a blurred strip off the cover's own edge, stretched to fill a spine —
      a data URL; see `extractEdgeStrip`. Null only when the cover itself
      could not be decoded, since the extractor never refuses an image the
      way the palette's quantizer can. */
  texture: string | null;
}

const NOTHING: OwnCoverArt = { palette: null, texture: null };

/* In memory only. Re-extracted each launch, which costs one canvas pass
   over one thumbnail per book actually shown on the realistic shelf — far
   cheaper than the round trip a catalogue cover pays for, so there is
   nothing here worth persisting. */
const cache = new Map<string, OwnCoverArt>();
const inFlight = new Map<string, Promise<OwnCoverArt>>();

/**
 * What a book's own cover offers a spine, or `{ palette: null, texture:
 * null }` when the book has no cover on this device or none of it survived
 * extraction.
 *
 * Cached and de-duplicated in flight the same way `ensureEdition` is: a
 * shelf full of spines can ask for the same book more than once in a tick.
 */
export async function ownCoverArt(bookId: string): Promise<OwnCoverArt> {
  const cached = cache.get(bookId);
  if (cached) return cached;

  const started = inFlight.get(bookId);
  if (started) return started;

  const run = load(bookId).finally(() => inFlight.delete(bookId));
  inFlight.set(bookId, run);
  return run;
}

async function load(bookId: string): Promise<OwnCoverArt> {
  let result = NOTHING;
  try {
    const record = await db.covers.get(bookId);
    if (record) {
      const blob = coverToBlob(record);
      /* Two independent decodes of the same small image rather than one
         shared bitmap: `extractPalette` owns its bitmap end to end and does
         not hand it out, and duplicating a few milliseconds of decode once
         per book, once per session, is simpler than threading one through
         both extractors for the sake of avoiding it. */
      const swatches = await extractPalette(blob);
      const texture = await extractEdgeStrip(blob);
      result = {
        palette: swatches.length ? swatches.map((s) => s.hex) : null,
        texture,
      };
    }
  } catch {
    /* Same contract as the rest of this feature: a failure here is a spine
       drawn by mood, not an error the reader sees. */
  }
  cache.set(bookId, result);
  return result;
}
