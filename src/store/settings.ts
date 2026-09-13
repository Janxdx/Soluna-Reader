import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PACER, type PacerConfig } from '../engine/pacer';

export type Theme = 'paper' | 'sepia' | 'ink';
export type ThemeMode = Theme | 'auto';

export interface Settings {
  mode: ThemeMode;
  /** the theme actually applied (auto resolves against prefers-color-scheme) */
  fontSize: number; // px
  lineHeight: number;
  margin: number; // 0–1, scales the page gutter
  serif: boolean;
  justify: boolean;
  /** fade words the pacer hasn't reached — a strong focus aid, not for everyone */
  dim: boolean;
  autoTurn: boolean;
  keepAwake: boolean;
  pacer: PacerConfig;
  /** Whether the shelf tab is allowed to ask outside catalogues (Google
      Books, Open Library) for a book's printing — publisher, page count,
      year. The cover itself is never one of these any more: every spine
      is drawn from the EPUB's own cover, which needs no network and no
      consent at all. See engine/spine.ts, meta/editions.ts and
      SHELF-3D.md. A hundred-book shelf opened for the first time still
      makes close to a hundred metadata requests, paced at one a second,
      so this is real consent rather than a display preference and lives
      here rather than in the tab's own state for the same reason:
      resetting it on every visit would make it feel like a toy. */
  lookupCoversOnline: boolean;

  set<K extends keyof Settings>(key: K, value: Settings[K]): void;
  setPacer(patch: Partial<PacerConfig>): void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      mode: 'auto',
      fontSize: 20,
      lineHeight: 1.62,
      margin: 0.5,
      serif: true,
      justify: true,
      dim: false,
      autoTurn: true,
      keepAwake: true,
      pacer: { ...DEFAULT_PACER },
      lookupCoversOnline: true,
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
      setPacer: (patch) =>
        set((s) => ({ pacer: { ...s.pacer, ...patch } })),
    }),
    {
      name: 'soluna.settings',
      version: 3,
      // v1 stored the rhythm as an on/off flag; carry the choice over.
      // v3 drops the Data/Shelf toggle (`shelfMode`) — the shelf tab draws
      // one way now, see SHELF-3D.md — in favour of `lookupCoversOnline`,
      // which answers a different question (may the shelf ask the network
      // at all) and always starts back at its own default rather than
      // trying to infer consent from which display mode someone had left
      // selected.
      migrate: (state, from) => {
        const s = state as Settings & { shelfMode?: string };
        if (from < 2 && s?.pacer) {
          const legacy = s.pacer as PacerConfig & { natural?: boolean };
          s.pacer = {
            wpm: legacy.wpm ?? DEFAULT_PACER.wpm,
            ramp: legacy.ramp ?? DEFAULT_PACER.ramp,
            rhythm: legacy.rhythm ?? (legacy.natural === false ? 0 : DEFAULT_PACER.rhythm),
          };
        }
        if (from < 3) {
          delete s.shelfMode;
          s.lookupCoversOnline = true;
        }
        return s;
      },
    }
  )
);

export function resolveTheme(mode: ThemeMode): Theme {
  if (mode !== 'auto') return mode;
  const dark =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? 'ink' : 'paper';
}
