import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PACER, type PacerConfig } from '../engine/pacer';
import type { ShelfMode } from '../engine/spine';

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
  /** how the rating shelf draws its spines — see engine/spine.ts. Lives
      here rather than in the tab's own state because it is a way of
      looking at your reading, and resetting it on every visit would make
      it feel like a toy rather than a choice. */
  shelfMode: ShelfMode;

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
      /* Defaults to the data shelf: it is what the tab has always shown, it
         needs no network, and the realistic one costs lookups the moment it
         is switched on. Opting in is the honest default for a mode that
         goes and asks three other services about your books. */
      shelfMode: 'data',
      set: (key, value) => set({ [key]: value } as Partial<Settings>),
      setPacer: (patch) =>
        set((s) => ({ pacer: { ...s.pacer, ...patch } })),
    }),
    {
      name: 'soluna.settings',
      version: 2,
      // v1 stored the rhythm as an on/off flag; carry the choice over
      migrate: (state, from) => {
        const s = state as Settings;
        if (from < 2 && s?.pacer) {
          const legacy = s.pacer as PacerConfig & { natural?: boolean };
          s.pacer = {
            wpm: legacy.wpm ?? DEFAULT_PACER.wpm,
            ramp: legacy.ramp ?? DEFAULT_PACER.ramp,
            rhythm: legacy.rhythm ?? (legacy.natural === false ? 0 : DEFAULT_PACER.rhythm),
          };
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
