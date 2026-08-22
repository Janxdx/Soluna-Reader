/* Editions, as React sees them.
 *
 * A thin reactive layer over `meta/editions.ts`: the fetching, pacing and
 * caching all live there, and this holds the result in memory so a shelf
 * re-renders when a book arrives. Deliberately not a mirror of the whole
 * table — it fills as screens ask for things, because the only shelf big
 * enough to matter is one you have to scroll anyway.
 */

import { create } from 'zustand';
import { db, type EditionRecord } from '../db';
import { editionKey } from '../engine/edition';
import { ensureEdition, fillShelf, lookupTrouble, paused, type LookupTrouble } from '../meta/editions';

/** A book as any of the three shelves can describe it. */
export interface EditionSubject {
  title: string;
  author: string;
  /** the edition's own language, from the EPUB where there is one */
  lang?: string;
  /** the EPUB's publisher, which beats the catalogue's when present —
      it is the actual edition in hand rather than a best match for it */
  publisher?: string;
}

interface EditionState {
  /** by `editionKey`, so one entry serves every shelf showing that book */
  byKey: Record<string, EditionRecord>;
  /** true while a shelf-wide fill is running, for the quiet progress line */
  filling: boolean;
  /** why nothing is arriving, when that is the case. The realistic shelf
      degrades to the ordinary one on failure, which is right and which
      also makes every failure look like "the button does nothing" — so
      the reason has to reach the screen. */
  trouble: LookupTrouble | null;
  loaded: boolean;

  load(): Promise<void>;
  get(subject: EditionSubject): EditionRecord | undefined;
  ensure(subject: EditionSubject): Promise<void>;
  fill(subjects: EditionSubject[]): Promise<void>;
  /** Throw the local cache away and fetch it all again. */
  refill(subjects: EditionSubject[]): Promise<void>;
}

/* The language to ask Wikipedia in when the book does not say. The browser's
   is the best guess available and a much better one than a hard-coded
   'en' — somebody reading on a German iPad is overwhelmingly likely to have
   read the German edition of a book they logged by hand. */
const defaultLang = (): string =>
  (typeof navigator !== 'undefined' && navigator.language) || 'en';

export const useEditions = create<EditionState>((set, get) => ({
  byKey: {},
  filling: false,
  trouble: null,
  loaded: false,

  /* Read whole on boot. A few hundred rows of small JSON plus the cover
     bytes — which are already in memory as ArrayBuffers rather than
     decoded images, so this is megabytes at worst and it is what lets the
     shelf draw complete on the first frame instead of popping in. */
  async load() {
    const rows = await db.editions.toArray();
    set({
      byKey: Object.fromEntries(rows.map((r) => [r.key, r])),
      loaded: true,
    });
  },

  get(subject) {
    return get().byKey[editionKey(subject.title, subject.author)];
  },

  async ensure(subject) {
    const key = editionKey(subject.title, subject.author);
    if (get().byKey[key]) return;

    const row = await ensureEdition(subject.title, subject.author, subject.lang ?? defaultLang());
    if (row) set((s) => ({ byKey: { ...s.byKey, [key]: row }, trouble: null }));
    else set({ trouble: lookupTrouble() });
  },

  /* One at a time and a second apart — see `fillShelf`. The store is
     updated as it goes rather than at the end, so the shelf fills in book
     by book instead of jumping when the whole run finishes. */
  async fill(subjects) {
    if (get().filling || paused()) return;
    set({ filling: true, trouble: null });
    try {
      await fillShelf(
        subjects.map((s) => ({
          title: s.title,
          author: s.author,
          lang: s.lang ?? defaultLang(),
        })),
        () => void refresh(set)
      );
      await refresh(set);
    } finally {
      set({ filling: false, trouble: lookupTrouble() });
    }
  },

  /* Safe to be this blunt because the table is a cache and nothing else:
     no user data is in it, the server has every answer already, and a
     re-fetch therefore costs one round trip to our own Worker and nothing
     to any catalogue. `EXTRACT_VERSION` handles the case where *we* know a
     row is out of date; this is for when the reader does — a wrong cover,
     or a fix that shipped and did not seem to arrive. */
  async refill(subjects) {
    if (get().filling) return;
    await db.editions.clear();
    set({ byKey: {}, trouble: null });
    await get().fill(subjects);
  },
}));

/* Re-read rather than threading the new row through the callback: `fillShelf`
   owns the write and this owns the view of it, and a table read of a few
   hundred small rows once a second is not the expensive part of a run whose
   pacing is deliberate. */
async function refresh(set: (partial: Partial<EditionState>) => void): Promise<void> {
  const rows = await db.editions.toArray();
  set({ byKey: Object.fromEntries(rows.map((r) => [r.key, r])) });
}
