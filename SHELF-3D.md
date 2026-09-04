# The shelf, rebuilt in three dimensions

A plan for the ratings tab. The target is the look of
`carollia-library.lovable.app`: a shelf that reads as a photograph of real
books rather than a bar chart standing on end.

Decisions taken with Jan, 2026-09-03:

- **Scope** — the 3D shelf *and* the editorial top (eyebrow, display headline,
  count, filter chips). The statistics panels below stay as they are.
- **Layout** — wrapping rows, not one horizontal scroller. Each row fans on its
  own vanishing point.
- **Type** — bundle Cormorant Garamond / Karla / Space Mono locally. Offline
  stays absolute; the fonts ship in the bundle, not from a CDN.
- **Modes** — the Data / Shelf toggle goes. One shelf.

---

## 1. What the reference actually does

Read off the live DOM, not guessed. Worth recording because two of these are
the whole effect and neither is obvious.

**Each spine is a real CSS 3D object**, four faces on one `preserve-3d` body:

| face | construction |
|---|---|
| spine | the element itself: ground colour, cover image stretched `height:100%; width:auto` at 70% and tinted back at 0.62, two hairline bands, vertical title (`writing-mode: vertical-rl`) |
| front cover | `left:100%`, `transform-origin: left center`, `rotateY(90deg)`, `backface-visibility: hidden`, the real cover image |
| top edge | `height: 5px`, `transform-origin: center top`, `rotateX(78deg)`, a warm paper gradient |
| — | *no fore-edge*; see §5, we add one |

The cylindrical sheen is one gradient, and it is the single most valuable line
in their stylesheet:

```css
linear-gradient(90deg,
  rgba(0,0,0,.42) 0%, rgba(0,0,0,.06) 16%,
  rgba(255,255,255,.34) 38%, rgba(255,255,255,.10) 52%,
  rgba(0,0,0,.14) 78%, rgba(0,0,0,.36) 100%)
```

**The fan is the other half.** The row container carries `perspective: 1400px`
and every book carries its own `--ry`, running from about **−34° at the left
edge through 0° in the middle to +34° at the right**. It is a function of the
book's horizontal position, computed once — it does *not* react to scroll. That
is what stops the row looking like a repeated sprite: one lens, one vanishing
point, every book seen from a slightly different angle. Books left of centre
show their cover; books right of centre turn away.

The shelf board itself is almost nothing: a 1px gradient hairline plus a 24px
top-down shadow beneath it, and a left/right background-coloured fade over the
row. No wood, no texture.

Palette is warm off-white (`oklch(89.5% .004 95)`) with a film grain — which is
what `DESIGN.md` already specifies for Paper. Nothing to change there.

---

## 2. What we already have

Almost all of it, which is why this is a rebuild of the *drawing* and not of the
model.

- `engine/spine.ts` already returns width, height, ground colour, ink, accent,
  livery pattern, imprint, title direction, and an `edgeTexture` data URL.
- `engine/edition.ts:realMetrics` already converts millimetres and page counts
  into px, at 2.6 px/mm.
- `db.editions` already caches **the cover bytes** per edition key, in memory
  after `useEditions.load()`. So the front face works with no network and no
  new fetching.
- `EditionData` already carries publisher, series, year, page count, ISBN and a
  Wikipedia teaser — everything the peek card in §6 wants.

What is missing is only: an object URL per edition cover, a row breaker, and
the 3D markup.

---

## 3. Phase 0 — the fonts

Three faces, subset to Latin + Latin-Ext, woff2 only.

- Cormorant Garamond 400/600 — headlines, and the spine titles.
- Karla 400/500/700 — UI.
- Space Mono 400 — eyebrows, counts, the score stamped at the foot.

Put them in `src/styles/fonts/` and `@font-face` them from `global.css` with
relative `url()`, so **Vite emits them into `dist/assets/`** — which is exactly
what `vite.config.ts`'s `sw-assets` plugin globs, so they precache into the
offline shell with no change to the service worker. `font-display: swap`, with
the current system stacks as the fallback in each stack.

Budget: ~140 KB total subset. `DESIGN.md` §2 gets a corrected paragraph — the
rule was never "no fonts", it was "nothing fetched at runtime", and bundling
keeps that true.

---

## 4. Phase 1 — one shelf

Dropping the toggle is the largest behavioural change here, and it has a
consequence worth being deliberate about.

`shelfMode: 'data'` is the current default **because the realistic mode goes and
asks three other people's services about your books**, paced at one a second.
Opting in was the honest default for that. Removing the toggle removes the
consent along with it — a hundred-book shelf will now make a hundred lookups the
first time the tab is opened.

**Proposal:** the toggle leaves the shelf tab, but the *choice* survives as one
line in Settings — **"Look up covers online"**, default **on**. The shelf is one
thing; the network behaviour is still yours. Flagging it rather than deciding
it. If you'd rather have no setting at all, say so and it goes.

Mechanically:

- `ShelfMode`, the `shelfMode` setting and its persisted key are removed;
  `store/settings.ts` gets a migration that drops the key.
- `spineLook()` loses its `mode` parameter and merges the two readings:
  - **thickness** — real page count where known, else word count. True in both
    old readings already.
  - **height** — real millimetres where known; otherwise a height derived from
    length with a small deterministic jitter, so a shelf of unknown books is
    still ragged rather than flat.
  - **ground** — the cover's own bound colour where a cover exists, the livery
    where one matches, and **the mood colour as the fallback**, which is how the
    data reading survives at all.
  - **score** — always the number stamped at the foot.
- The header comment at the top of `engine/spine.ts` is rewritten. It currently
  argues at length that the two readings cannot both be true; that argument is
  now settled and the file should say how, not re-open it.
- The data reading is not lost, it moves: the mood ribbon, the score curve and
  the radar below the shelf are all still there and are now the only place the
  numbers are drawn. Worth a sentence of copy under the shelf saying so.
- `Ratings.tsx` loses the mode segment and the two `shelfMode !== 'shelf'`
  guards on the fill and own-cover effects — both now run unconditionally
  (subject to the setting above).

---

## 5. Phase 2 — the row breaker and the fan

A wrapping flex container cannot fan, because nothing knows which row a book
landed in until after layout. So we break the rows ourselves.

New `engine/shelf.ts`, framework-free like the rest of `engine/`:

```ts
export interface ShelfRow { books: Placed[]; width: number }
export interface Placed  { id: string; look: SpineLook; x: number; ry: number }

export function breakRows(
  looks: { id: string; look: SpineLook }[],
  containerWidth: number,
): ShelfRow[]
```

- Greedy: fill until the next spine would overflow, then start a row. The last
  row stays ragged — a real shelf is.
- `x` is the running centre of each spine.
- `ry = MAX_RY * sign(t) * |t|^1.15` where `t = 2·x/rowWidth − 1`, `MAX_RY = 30`.
  The exponent keeps books near the centre flatter than a straight line would,
  which is what the reference's own numbers do.
- The fan is based on **the row's own width**, not the container's, so a short
  last row fans gently instead of splaying.

Pure input → output, so it gets a unit test (`tests/shelf.test.mts`): rows never
exceed the container, every book appears exactly once, `ry` is monotonic across
a row and symmetric about its centre.

`SpineWall` calls it from a `ResizeObserver` on its own element, debounced to a
frame. Rows re-break on rotation and on split view.

---

## 6. Phase 3 — the spine, in three dimensions

`SpineWall.tsx` is rewritten around this shape:

```tsx
<div className="shelf-row">          {/* perspective: 1400px; perspective-origin: 50% 62% */}
  <span className="slot" style={{ width, '--ry': `${ry}deg` }}>
    <button className="book" style={{ height }}>
      <span className="body">        {/* rotateY(var(--ry)); origin bottom; translateZ(1.4px) */}
        <span className="face"> …title, bands, gilt, imprint, score… </span>
        <span className="cover" />   {/* left:100%;  rotateY(90deg)  — the real cover */}
        <span className="fore"  />   {/* right:100%; rotateY(-90deg) — see below */}
        <span className="head"  />   {/* top; rotateX(78deg) — paper */}
      </span>
    </button>
  </span>
</div>
```

**The fore-edge is ours, not theirs.** The reference builds only a cover face, so
every book right of centre turns away onto nothing — a hole in the shelf that
its neighbour happens to cover. We add the page block on the other side: cream,
with a fine repeating gradient for the leaves and a `1px` inset at the head.
Cheap, and it is the difference between a fan that works in one direction and
one that works in both.

Other details that matter:

- **Cover depth** comes from the cover image's own aspect ratio
  (`naturalWidth/naturalHeight × height`), clamped to 0.60–0.74 of the height,
  rather than the reference's flat 0.78. A trade paperback is not that square.
- **Cover object URLs** — one `useEditionCovers()` hook that lazily makes an
  object URL per edition key from the cached `ArrayBuffer` and revokes on
  unmount. Today `EditionCard` makes and revokes one per open; the shelf needs
  a hundred at once and must not leak them.
- **Spine texture** — `edgeTexture` where we have it (we already extract it),
  falling back to the reference's trick: the whole cover stretched to the spine's
  height and tinted back to the ground colour at 0.62.
- **Faces are conditional.** A book within ±4° of flat shows neither side face;
  below ~24 px wide it shows no imprint. Fewer layers, and it is also true.
- **The board** stays as it is conceptually but moves from the wall's repeating
  gradient to a per-row element — hairline + falloff shadow, plus the left/right
  fades. Simpler than the current `repeating-linear-gradient`, and correct for
  ragged rows by construction.
- **Performance** — `contain: layout paint` and `content-visibility: auto` per
  row; no `will-change` at rest; the entry stagger keeps its 22 ms step but caps
  at the first row. Target is a steady 60 fps scrolling 120 books on the iPad,
  measured before this is called done.
- **Reduced motion** — no entry animation, no hover tilt; the fan itself stays,
  because it is a static picture and not a movement.

---

## 7. Phase 4 — the editorial top

Above the shelf, replacing the current `lib-head`:

- Eyebrow in Space Mono, letterspaced: **A PERSONAL SHELF**.
- Cormorant display headline — the taste tagline `tasteProfile()` already
  writes, which is better copy than "97 volumes" and is already computed.
- Count line in mono: `97 VOLUMES · 4 THIS MONTH`.
- **Filter chips.** The reference filters by genre; we have no genre, but we do
  have the eight moods, which are better — they are yours rather than a
  publisher's. Chips: `ALL · EMBER · GOLD · MOSS · SEA · INDIGO · PLUM ·
  OXBLOOD · ASH · ★ FAVOURITES`, each drawn in its own mood colour when active,
  hidden when that mood is unused. The count line becomes "44 MATCHING VOLUMES"
  when a filter is on, as the reference does.
- The existing sort segment (Rating / Recent / Mood / Title / Length) stays,
  restyled to match.
- "Rate a book" stays where it is.

*(If you want real genres later: Google Books returns `categories` and the
Worker already parses that response — it is one field on `EditionData` and one
column, not a project.)*

---

## 8. Phase 5 — the peek card

The reference shows a floating card on hover: title, author, year · format,
genres. We have more to say and a touch device to say it on.

- **Tap** keeps today's behaviour — the `RatingSheet` opens. Nothing regresses.
- **Hover**, under `@media (hover: hover)` only, raises a card: title, author,
  year, publisher or livery, your score and mood, and the first line of the
  Wikipedia teaser we already store. Positioned above the book, clamped to the
  viewport, `pointer-events: none`.
- **Press-and-hold** on touch shows the same card without opening the sheet.

---

## 9. Phase 6 — checks

- `npm run typecheck`, `npm test`, `npm run build` — all three pass today, per
  `CLAUDE.md`, so a failure is ours.
- New: `tests/shelf.test.mts` for the row breaker.
- `tests/rating.test.mts` and `edition.test.mts` need updating where they assert
  on `mode`.
- Visual check on the iPad at 1024 and 1366 wide, portrait and landscape, and in
  Split View at 507 — the row breaker's real test is a narrow container.
- Dark theme: the sheen gradient and the paper head are both tuned for the light
  ground and will need their own values on Ink.
- Empty shelf, one-book shelf, and a 300-book shelf.

---

## 10. Order of work

Each of these is a commit on `develop` that leaves the app working.

1. Fonts bundled, type scale applied. *Visible on its own.*
2. `engine/shelf.ts` + tests. *Nothing rendered yet.*
3. One shelf: merge the modes, drop the toggle, settings migration.
4. The 3D spine and the per-row board. **The big one.**
5. Editorial top and the mood chips.
6. The peek card.
7. `DESIGN.md` updated — §2 on fonts, §4 on the shelf.

Sequence matters at step 3/4: merging the modes first means step 4 is drawing
one thing rather than two.

---

## 11. Open questions

1. **The lookup setting** (§4). Keep "Look up covers online" in Settings, or no
   setting at all?
2. **Sorting and the fan.** The fan is a function of position, so re-sorting
   re-fans every book. Should that animate — books turning as they slide — or
   snap? Animating ~100 rotations at once is the one place this could cost
   frames.
3. **Height for unknown books** (§4). Deterministic jitter from the title hash
   keeps a shelf ragged and stable across launches, but it is invented data.
   The honest alternative is a flat default height, which looks like a fence.
