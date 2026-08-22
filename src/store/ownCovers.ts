/* Own-cover art, as React sees them.
 *
 * The same shape as `store/editions.ts` for the same reason: the actual work
 * — reading `db.covers`, running the canvas — lives in `meta/ownCover.ts`
 * and is plain async code with its own cache, so this is only the reactive
 * layer that makes a shelf re-render once an extraction lands.
 */

import { create } from 'zustand';
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
