/* Own-cover art, as React sees them.
 *
 * The same shape as `store/editions.ts` for the same reason: the actual work
 * — reading `db.covers`, running the canvas — lives in `meta/ownCover.ts`
 * and is plain async code with its own cache, so this is only the reactive
 * layer that makes a shelf re-render once an extraction lands.
 */

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { coverToBlob, db } from '../db';
import { ownCoverArt, type OwnCoverArt } from '../meta/ownCover';

interface OwnCoverState {
  /** by book id. Absent means "not asked yet"; present-but-null fields
      mean asked and nothing usable came back — both distinct from real
      art, so a caller can tell "still waiting" from "tried, found nothing"
      the same way `store/editions.ts` does with an empty edition row. */
  byId: Record<string, OwnCoverArt>;
  ensure(bookId: string): Promise<void>;
}

export const useOwnCovers = create<OwnCoverState>((set, get) => ({
  byId: {},

  async ensure(bookId) {
    if (bookId in get().byId) return;
    const art = await ownCoverArt(bookId);
    set((s) => ({ byId: { ...s.byId, [bookId]: art } }));
  },
}));


/* ── the EPUB's own cover, as an image the shelf can actually show ───
 *
 * `ownCoverArt` above answers a different question — what a book's own
 * cover offers a spine's *colour and texture* — and only for a book the
 * catalogue has drawn a definitive blank on. This answers a plainer one:
 * every imported EPUB keeps its cover in `db.covers` regardless of what
 * any catalogue says, so whenever the online cover a shelf asked for
 * isn't there — not yet fetched, or fetched and empty — the book's own
 * cover is sitting on the device already and is strictly better than a
 * flat livery colour on the front face. No network, no palette, no
 * `lookupCoversOnline` gate: reading a few kilobytes already on disk and
 * handing back an object URL costs nothing worth asking permission for.
 *
 * Same cache/revoke shape as `useEditionCovers` in `store/editions.ts`,
 * keyed by book id instead of edition key, for the same reason: a shelf
 * asks for a hundred of these at once and they have to survive
 * re-renders without leaking the ones that scroll out of view.
 */
export function useOwnCoverUrls(bookIds: string[]): Record<string, string> {
  const cache = useRef<Map<string, string>>(new Map());
  const [, force] = useState(0);
  const key = bookIds.join('\u0000');

  useEffect(() => {
    let cancelled = false;
    const wanted = new Set(bookIds);

    void (async () => {
      let changed = false;
      for (const id of wanted) {
        if (cache.current.has(id)) continue;
        const record = await db.covers.get(id);
        if (cancelled) return;
        if (record) {
          cache.current.set(id, URL.createObjectURL(coverToBlob(record)));
          changed = true;
        }
      }
      for (const id of Array.from(cache.current.keys())) {
        if (!wanted.has(id)) {
          URL.revokeObjectURL(cache.current.get(id)!);
          cache.current.delete(id);
          changed = true;
        }
      }
      if (changed && !cancelled) force((n) => n + 1);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /* On the way out — see the identical note on useEditionCovers. */
  useEffect(
    () => () => {
      for (const url of cache.current.values()) URL.revokeObjectURL(url);
      cache.current.clear();
    },
    []
  );

  return Object.fromEntries(cache.current);
}
