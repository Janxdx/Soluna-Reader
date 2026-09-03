/* The shelf, in three dimensions.
 *
 * Every book you have rated, standing as a spine, drawn from whatever is
 * known about it — see the note at the top of engine/spine.ts for how a
 * half-known book still ends up looking like a book. Colour is the cover's
 * own where there is one, or a livery, or the mood you rated it in; height
 * and thickness are the object's own size where it's known, or a guess
 * from its length otherwise; the score is the number stamped at the foot.
 *
 * This file draws that as four real CSS faces on one `preserve-3d` body —
 * spine, cover, fore-edge, top — fanned around a per-row vanishing point
 * rather than shown flat-on. See SHELF-3D.md for the reference this was
 * modelled on and the reasoning behind each face; `engine/shelf.ts` is
 * where the fan angle and the row breaking actually happen, since neither
 * can be a CSS-only property of a wrapping flex container.
 *
 * Layout note. `breakRows()` re-runs whenever the wall's own width changes
 * (a `ResizeObserver`, debounced to a frame) or the shelf's contents,
 * theme or sort order do. Re-sorting therefore re-fans every book — the
 * angle is a function of where a spine sits in its row, and a new sort
 * puts it somewhere else — and that transition snaps rather than
 * animating: the alternative is rotating up to a hundred books in 3D at
 * once, which is the one place this shelf could visibly drop frames.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { spineLook, type SpineLook } from '../engine/spine';
import { breakRows } from '../engine/shelf';
import type { RatingRecord } from '../engine/rating';
import type { EditionData } from '../engine/edition';
import { PeekCard, type PeekAnchor } from './PeekCard';

/** What the wall needs to know about a book beyond its rating. Supplied by
    the tab, which is the thing holding the stores. */
export interface SpineExtras {
  edition?: EditionData;
  publisher?: string;
  language?: string;
}

/* The same lit-down-the-left, shadowed-at-the-right sheen `bind()` paints
   into every flat spine in engine/spine.ts — translucent here instead of
   opaque, because this one goes on top of a texture image rather than
   being the whole face. Kept out of engine/spine.ts because it is a CSS
   background layer, not a colour, and that file trades in colours.

   Two versions: the light one reads as a lacquer sheen on warm cloth; on
   Ink's already-dark grounds the same white highlight reads as a smear
   rather than a shine, so the dark one leans harder on the shadow side
   and softer on the highlight. */
const TEXTURE_SHEEN =
  'linear-gradient(100deg, rgba(255,255,255,0.26) 0 8%, rgba(0,0,0,0) 22% 78%, rgba(0,0,0,0.32) 100%)';
const TEXTURE_SHEEN_DARK =
  'linear-gradient(100deg, rgba(255,255,255,0.1) 0 8%, rgba(0,0,0,0) 22% 78%, rgba(0,0,0,0.5) 100%)';

/** The background half of a face's inline style, pulled out of the JSX
    below purely so TypeScript sees one object shape instead of a union of
    two — inlining the conditional there made every other property on the
    style object suspect too. */
function faceStyle(look: SpineLook, dark: boolean): React.CSSProperties {
  if (look.textureUrl) {
    return {
      backgroundImage: `${dark ? TEXTURE_SHEEN_DARK : TEXTURE_SHEEN}, url(${look.textureUrl})`,
      backgroundSize: '100% 100%, 100% 100%',
    };
  }
  return { background: look.background };
}

/* Mirrors `.wall3d`'s `--slot-h` in global.css. Duplicated rather than
   measured, because it only ever takes the two values the same media
   query fixes, and measuring the DOM would cost a second render just to
   learn a number the stylesheet already decided. Used only to turn a
   spine's height *percentage* into a real pixel figure for the cover-depth
   calculation below, which has to be a px width to mean anything once
   rotated 90°. */
const SLOT_H_WIDE = 250;
const SLOT_H_NARROW = 178;

function useSlotHeightPx(): number {
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(max-width: 640px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow ? SLOT_H_NARROW : SLOT_H_WIDE;
}

/* A book's depth — how far the cover face and the fore-edge face extend
   once rotated to face the room — clamped to a fraction of its height
   rather than fixed the way the reference's flat 0.78 is: a trade
   paperback is not that square, and a cover's own aspect ratio says so
   better than a constant can. */
const MIN_DEPTH_FRAC = 0.6;
const MAX_DEPTH_FRAC = 0.74;
const DEFAULT_DEPTH_FRAC = 0.68;

/** Probes the natural aspect ratio of each cover once, keyed by its own
    object URL so a re-render never re-decodes an image already measured.
    Falls back to `DEFAULT_DEPTH_FRAC` until — or unless — the probe lands,
    so a book's depth is set from the moment it draws either way; it just
    corrects itself a frame or two later once a real cover is known. */
function useCoverAspects(coverUrls: Record<string, string>): Record<string, number> {
  const [aspects, setAspects] = useState<Record<string, number>>({});
  const probed = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const [key, url] of Object.entries(coverUrls)) {
      if (probed.current.has(url)) continue;
      probed.current.add(url);
      const img = new Image();
      img.onload = () => {
        if (img.naturalHeight > 0) {
          const ratio = img.naturalWidth / img.naturalHeight;
          setAspects((a) => (a[key] === ratio ? a : { ...a, [key]: ratio }));
        }
      };
      img.src = url;
    }
  }, [coverUrls]);

  return aspects;
}

/* Below ~4° a book reads as flat-on: the cover and fore-edge faces would
   be edge-on to the point of invisibility, so skipping them there is both
   cheaper and more honest than drawing two faces nobody can see. */
const FLAT_THRESHOLD = 4;

/* How long a touch has to hold still before it counts as a press rather
   than the start of a tap or a scroll; how far it's allowed to drift
   before that counts as a scroll starting instead. */
const HOLD_MS = 480;
const HOLD_SLOP = 10;

interface Props {
  ratings: RatingRecord[];
  dark: boolean;
  /** by rating id — absent means "nothing known", which is a normal state */
  extras: Record<string, SpineExtras>;
  /** by edition key — object URLs for whatever covers are cached; see
      `useEditionCovers` in store/editions.ts */
  coverUrls: Record<string, string>;
  onOpen: (rating: RatingRecord) => void;
  /** highlighted while its sheet is open */
  activeId?: string | null;
}

export function SpineWall({ ratings, dark, extras, coverUrls, onOpen, activeId }: Props) {
  /* Recomputed only when the shelf or the theme changes — this runs over
     every spine and the wall re-renders on hover. `extras` is in the
     dependency list by identity, so the tab must hand over a new object
     when a lookup lands; it builds one with useMemo, which does. */
  const looks = useMemo(
    () =>
      ratings.map((r) => ({
        id: r.id,
        look: spineLook({
          rating: r,
          dark,
          edition: extras[r.id]?.edition,
          publisher: extras[r.id]?.publisher,
          language: extras[r.id]?.language,
        }),
      })),
    [ratings, dark, extras]
  );

  /* Everything the row breaker doesn't carry through: the rating itself
     (for the title, author and score) and the edition key a cover or an
     aspect ratio is filed under. Kept as a side map rather than widening
     `Placed` — engine/shelf.ts trades in spine widths and positions, not
     in what a spine's *contents* are. */
  const meta = useMemo(() => {
    const m = new Map<string, { rating: RatingRecord; editionKey?: string }>();
    for (const r of ratings) {
      const editionKey = extras[r.id]?.edition?.key;
      m.set(r.id, { rating: r, ...(editionKey ? { editionKey } : {}) });
    }
    return m;
  }, [ratings, extras]);

  const wallRef = useRef<HTMLDivElement>(null);
  const [wallWidth, setWallWidth] = useState(0);
  /* Layout effect, and an initial synchronous read: a ResizeObserver's
     first callback lands a tick after mount, and waiting for it would
     draw an empty shelf for a frame on every visit to the tab, even
     though the container's width was knowable before paint. */
  useLayoutEffect(() => {
    const el = wallRef.current;
    if (!el) return;
    setWallWidth(el.getBoundingClientRect().width);

    /* Debounced to a frame: a ResizeObserver fires on every pixel of a
       drag-resize (Split View, an external display), and re-breaking a
       few hundred spines into rows on each one is wasted work the frame
       after it happens anyway. */
    let raf = 0;
    const ro = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWallWidth(entry.contentRect.width));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  /* Before the first measurement, break nothing into rows at all — a
     container width of 0 would put every spine in its own row. */
  const rows = useMemo(
    () => (wallWidth > 0 ? breakRows(looks, wallWidth) : []),
    [looks, wallWidth]
  );

  const slotH = useSlotHeightPx();
  const aspects = useCoverAspects(coverUrls);

  /* Checked once, not per book: a mouse tracks in and out of a hundred
     spines, and a `matchMedia` read for each would be a hundred reads of
     the same answer. Absent on touch, which is exactly the split the
     peek card needs — see the note at the top of PeekCard.tsx. */
  const hoverCapable = useMemo(
    () => typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches,
    []
  );

  const [peek, setPeek] = useState<PeekAnchor | null>(null);
  const onPeek = useCallback((id: string, rect: DOMRect | null) => {
    setPeek(rect ? { id, rect } : null);
  }, []);
  /* The anchor rect is captured once, at the moment a hover or a hold
     starts — cheaper than tracking it live, and right for everything
     that actually moves a book: a re-sort re-fans the whole row (see the
     file header), which is exactly why the sort/filter changing at all,
     by way of a new `ratings` array, drops whatever was showing rather
     than leaving a card pointing at empty air. A resize does the same to
     every row's own width, so `wallWidth` clears it too. Scrolling isn't
     caught by either — `.scroller` is what actually scrolls, not the
     window, and its own scroll doesn't bubble, so this listens for it in
     the capture phase on `window`, the standard way to hear a
     non-bubbling event from an arbitrary descendant. */
  useEffect(() => setPeek(null), [ratings, wallWidth]);
  useEffect(() => {
    if (!peek) return;
    const dismiss = () => setPeek(null);
    window.addEventListener('scroll', dismiss, true);
    return () => window.removeEventListener('scroll', dismiss, true);
  }, [peek]);

  let entryIndex = 0;

  const peekedMeta = peek ? meta.get(peek.id) : undefined;
  const peekedLook = peek ? looks.find((l) => l.id === peek.id)?.look : undefined;
  const peekedExtras = peek ? extras[peek.id] : undefined;

  return (
    <div className="wall3d" ref={wallRef} role="list">
      {rows.map((row, ri) => (
        <div className="shelf-row" key={ri} style={{ width: row.width }}>
          {row.books.map(({ id, look, ry }) => {
            const m = meta.get(id);
            if (!m) return null;
            const i = entryIndex++;
            const coverUrl = m.editionKey ? coverUrls[m.editionKey] : undefined;
            const aspect = m.editionKey ? aspects[m.editionKey] : undefined;
            return (
              <Spine
                key={id}
                rating={m.rating}
                look={look}
                ry={ry}
                dark={dark}
                coverUrl={coverUrl}
                aspect={aspect}
                slotH={slotH}
                active={activeId === id}
                /* The stagger only plays out across the first row — a
                   hundred-book shelf staggering every row in turn would
                   take visibly longer to finish than it's worth. */
                entryDelay={ri === 0 ? Math.min(i, 24) * 22 : 0}
                onOpen={onOpen}
                onPeek={onPeek}
                hoverCapable={hoverCapable}
              />
            );
          })}
        </div>
      ))}
      {peek && peekedMeta && peekedLook && (
        <PeekCard
          anchor={peek}
          rating={peekedMeta.rating}
          look={peekedLook}
          edition={peekedExtras?.edition}
          publisher={peekedExtras?.publisher}
          dark={dark}
        />
      )}
    </div>
  );
}

function Spine({
  rating: r,
  look,
  ry,
  dark,
  coverUrl,
  aspect,
  slotH,
  active,
  entryDelay,
  onOpen,
  onPeek,
  hoverCapable,
}: {
  rating: RatingRecord;
  look: SpineLook;
  ry: number;
  dark: boolean;
  coverUrl?: string;
  aspect?: number;
  slotH: number;
  active: boolean;
  entryDelay: number;
  onOpen: (rating: RatingRecord) => void;
  onPeek: (id: string, rect: DOMRect | null) => void;
  hoverCapable: boolean;
}) {
  const flat = Math.abs(ry) < FLAT_THRESHOLD;
  const heightPx = slotH * (parseFloat(look.height) / 100);
  const depthFrac = Math.max(MIN_DEPTH_FRAC, Math.min(MAX_DEPTH_FRAC, aspect ?? DEFAULT_DEPTH_FRAC));
  const depthPx = Math.round(heightPx * depthFrac);
  const showImprint = Boolean(look.imprint) && look.width >= 26;

  const btnRef = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  const holdStart = useRef<{ x: number; y: number } | null>(null);
  /* Set the moment a hold fires, so the tap that ends it (touch sends a
     click after pointerup, same as a real tap does) can be told apart
     from an actual tap and swallowed instead of opening the sheet. */
  const heldRef = useRef(false);

  const clearHold = () => {
    if (holdTimer.current !== undefined) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = undefined;
    }
    holdStart.current = null;
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== 'touch') return;
    holdStart.current = { x: e.clientX, y: e.clientY };
    clearHold();
    holdTimer.current = window.setTimeout(() => {
      const el = btnRef.current;
      if (!el) return;
      heldRef.current = true;
      onPeek(r.id, el.getBoundingClientRect());
    }, HOLD_MS);
  };
  const handlePointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType !== 'touch' || !holdStart.current) return;
    const dx = e.clientX - holdStart.current.x;
    const dy = e.clientY - holdStart.current.y;
    /* Drifted far enough that this reads as the start of a scroll, not a
       hold — don't let the shelf eat the gesture. */
    if (Math.hypot(dx, dy) > HOLD_SLOP) clearHold();
  };
  const handlePointerEnd = () => {
    clearHold();
    if (heldRef.current) onPeek(r.id, null);
  };
  const handleMouseEnter = () => {
    if (!hoverCapable) return;
    const el = btnRef.current;
    if (!el) return;
    onPeek(r.id, el.getBoundingClientRect());
  };
  const handleMouseLeave = () => {
    if (!hoverCapable) return;
    onPeek(r.id, null);
  };
  const handleClick = () => {
    /* The tap that ended a hold, not a tap on its own — the peek card
       already said everything this click would have opened the sheet
       to see. */
    if (heldRef.current) {
      heldRef.current = false;
      return;
    }
    onOpen(r);
  };

  return (
    <div className="slot" role="listitem" style={{ width: look.width, '--ry': `${ry}deg` } as React.CSSProperties}>
      <button
        ref={btnRef}
        className={`tome${active ? ' on' : ''}`}
        style={{ height: look.height, animationDelay: `${entryDelay}ms` }}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        title={`${r.title}${r.author ? ` — ${r.author}` : ''} · ${r.overall}/10`}
      >
        <span className="tome-body">
          {/* the spine itself — everything the flat wall used to be */}
          <span
            className={`face spine p-${look.pattern}${look.real ? ' real' : ''}`}
            style={{ ...faceStyle(look, dark), color: look.ink, '--accent': look.accent } as React.CSSProperties}
          >
            <span className="band top" />
            <span className="band bottom" />
            {r.favourite && <span className="gilt" aria-hidden />}
            <span className={`title${look.direction === 'up' ? ' up' : ''}`}>{r.title}</span>
            {showImprint && <span className="imprint">{look.imprint}</span>}
            <span className="score">{r.overall}</span>
          </span>

          {/* the front cover, turned to face the room */}
          {!flat && (
            <span className="tome-cover" style={{ width: depthPx }}>
              {coverUrl ? (
                <img src={coverUrl} alt="" loading="lazy" decoding="async" />
              ) : (
                <span className="tome-cover-fallback" style={faceStyle(look, dark)} />
              )}
            </span>
          )}

          {/* the fore-edge — ours, not the reference's; see SHELF-3D.md §6.
              Without it every book turned the other way is a hole in the
              shelf that its neighbour happens to cover. */}
          {!flat && <span className="fore" style={{ width: depthPx }} />}

          {/* the top edge, foreshortened almost flat — visible as little
              more than a highlight line, and cheap enough to always draw */}
          <span className="head" />
        </span>
      </button>
    </div>
  );
}
