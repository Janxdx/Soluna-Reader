# Soluna — Reader App

A beautiful EPUB reader for iPad (and iPhone/Mac), built web-first as an installable PWA, structured so the reader engine ports into a native shell later.

---

## 1. Principles

1. **The page is the product.** Every pixel of chrome earns its place or disappears. Controls fade out while reading and return on tap.
2. **Our typography, not the publisher's.** Book CSS is stripped; semantic HTML is kept. Every book reads with the same considered type. This is also what makes pagination and word-level pacing tractable.
3. **Motion is physical.** Spring easing, transform/opacity only, nothing that reflows during animation.
4. **Statistics are a reward, not a dashboard.** Rich data, presented as something you *want* to look at after finishing a session.
5. **Colour is spent in one place.** The whole app runs on a single warm accent so that the shelf — where colour carries meaning rather than decoration — can spend a palette without competing with anything.

## 2. Design language

**Palette** — three reading themes, all with the same UI structure.

| | Background | Surface | Ink | Accent |
|---|---|---|---|---|
| Paper (light) | `#FAF7F2` | `#FFFFFF` | `#1A1714` | `#B4763A` |
| Sepia | `#F3E9D8` | `#FBF3E4` | `#3A2E22` | `#A2632C` |
| Ink (dark) | `#0E0D0C` | `#171614` | `#EDE7DE` | `#D89A5B` |

Accent is a warm amber — used for the pacer highlight, progress arcs, and nothing else. Restraint is the whole design.

**The mood palette** — the one exception, and it exists only on the shelf. Eight bookbinding-cloth colours, stored as HSL parts so the dark theme lifts them rather than keeping a second palette in step.

| | | | |
|---|---|---|---|
| Ember · *Consuming* | Gold · *Joyful* | Moss · *Comforting* | Sea · *Contemplative* |
| Indigo · *Haunting* | Plum · *Melancholy* | Oxblood · *Brutal* | Ash · *Cold* |

They are muted on purpose — cloth, not highlighter pens — because a wall of them has to sit calmly next to warm paper.

**Type** — reading text in a system serif stack (`Iowan Old Style` / `Palatino` / Georgia), UI in the system sans. The rule was never "no fonts", it's "nothing fetched at runtime" — the shelf's editorial layer (§4) bundles three bookish faces of its own, subset and shipped in the PWA, not loaded from a CDN, so offline and instant-load both still hold.

**The shelf's own faces** — Cormorant Garamond (display, for the headline and a spine's vertical title), Karla (its segmented controls and mood chips), and Space Mono (the eyebrow, the count line, and the score stamped at a spine's foot) — Latin + Latin-Ext, woff2 only, ~99 KB together. Nowhere else in the app: everywhere but the shelf still reads in the system stacks above.

**Texture** — a barely-there film grain over backgrounds, a soft page-edge shadow at the gutter, and generous margins that scale with viewport. On a 12.9" iPad the text column caps at ~34em so line length stays readable.

**Motion** — page turns slide on a spring (`cubic-bezier(.22,1,.36,1)`, 420ms). Chrome fades at 200ms. The pacer highlight itself does not animate — it snaps, because a lagging highlight breaks the pacing illusion.

## 3. Architecture

```
src/
  engine/          ← framework-free, portable to a native shell
    epub/          parse container.xml → OPF → spine, manifest, TOC, cover
    sanitize.ts    allowlist HTML, resolve images to blob URLs, strip book CSS
    tokenize.ts    wrap every word in a span — powers pacer + exact word counts
    paginate.ts    CSS multi-column pagination + page-of-word lookup
    pacer.ts       rAF scheduler: WPM + punctuation/length dwell modelling
    stats.ts       session aggregation, streaks, heatmap, WPM trend
    device.ts      page ⇄ percent ⇄ word position, pace projection, matching
    rating.ts      axes, mood palette, taste profile, shelf sorting
    tasteCard.ts   the shareable card, built as a string of SVG
  db/              Dexie (IndexedDB): books, files, progress, sessions, ratings, settings
  store/           app state (zustand)
  ui/              Library · Reader · Pacer · Device · Shelf · Stats · Settings
```

`engine/` never imports React. In a native shell the reading surface is a `WKWebView` running the same engine — which is what Apple Books and Kindle do, since EPUB *is* HTML and CSS.

## 4. Core features

**Import** — drop or pick an `.epub`. The original file is stored as a blob; chapters are unzipped on demand. Metadata, cover, and TOC are extracted at import.

**Reader** — paginated columns, tap edges or swipe to turn, TOC drawer, adjustable font size / line height / margins / theme, resume-where-you-left-off per book.

**Pacer** — the distinguishing feature. Set a target WPM; words highlight in sequence. Dwell time per word is modelled, not uniform:

```
dwell = base × lengthFactor × punctuationFactor
base  = 60000 / wpm
lengthFactor      1 + (chars − 5) × 0.03   (clamped 0.75–1.6)
punctuationFactor , ; : → 1.5    . ! ? → 2.2    ¶ end → 2.6
```

Pages auto-turn when the highlight crosses the page boundary. Play/pause, ±10 WPM, and a "ramp" mode that eases from a comfortable speed to the target over the first minute.

**Device shelf** — a second library for books read on an e-ink reader. You give
a book its page count, time a session, and enter the page you stopped on; the
page count is the scale that converts that into the percentage the rest of the
app speaks in, and from there into a spine index and word offset. Each logged
session is mirrored into the ordinary session history, so reading done away
from the app counts towards every statistic. Books link to their library
counterpart by exact title and author, and progress only ever moves forward —
a reader entry behind the app is recorded but does not rewind your place.

**The shelf** — what you thought of what you read.

One number is the verdict; five more are the reasons (prose, pacing, characters, ideas, feeling); a mood colour is how it felt. Nothing is required except the verdict — a rating you had to fill in completely is a rating you would not have bothered to make, and an axis you never touched stays *absent* rather than becoming a zero that would drag every average down.

A rating is its own record, not a column on a book. It carries the title and author, so it survives the EPUB being deleted to free space and can be about a book only ever read on the e-reader. Both shelves feed the picker.

The screen itself is a wall of real CSS 3D objects — spine, cover, fore-edge and top, four faces on one `preserve-3d` body — fanned per row around a shared vanishing point the way books actually sit angled on a shelf, rather than shown flat-on. It reads three properties without a legend because a real shelf already has them, each falling back a step at a time so a half-known book still looks like a book rather than a mismatch of styles:

- **colour** — the cover's own bound colour where a cover was found; failing that, a matched publisher's livery (Reclam yellow, the Penguin tri-band, edition suhrkamp — real conventions, drawn in CSS at any thickness); failing that, the mood you rated it in. A livery beats the cover, not the other way round: it's what the spine *is*, not an inference about it.
- **height** — the object's own real size, from the catalogue or a matched livery's known trim, where either is known; otherwise a height guessed from the book's length with a small jitter hashed from its title, so an unlooked-up shelf is ragged rather than a fence of identical spines. The score no longer sets height — see below.
- **thickness** — real page count where known, else the word count a rating already carries, mapped logarithmically and clamped.

The score itself is the number stamped at the foot of the spine — you have to walk up and read it, the way you would on a real book — rather than the shelf's height, which now belongs to the object's own size.

Above the wall: a Space Mono eyebrow, a Cormorant Garamond headline that is the reader's own generated tagline rather than a book count, and a mono count line underneath it. Mood chips filter the wall to one cloth colour at a time (or to favourites) without re-sorting it; sort by rating, recency, mood, title or length separately. Hovering a spine — or holding one, on a touch device — raises a peek card with the title, author, printing and the first line of what's known about the book, without opening the rating sheet. Underneath the wall: your score distribution with your average marked on it — almost everyone discovers a spike at 8 with nothing below 6 — a radar of what you reward across every rating, and the mood mix as one ribbon of cloth.

A setting, "Look up covers online" (on by default), gates whether the shelf asks outside catalogues for a cover and a printing at all — real spines are not data anyone publishes, so a cover is a best-effort catalogue match, paced and cached, never required for a book to stand on the shelf.

**The taste card** — the whole shelf as one shareable image: the generated sentence about you, the average, the spines in miniature, the curve, the colours, and the book you loved most. Authored as a string of SVG and used twice, rendered inline and rasterised into a PNG, so the saved image cannot drift from the preview. Saved through the share sheet where there is one.

**Statistics** — tracked per session and rolled up:

- *Session*: duration, words, actual WPM, pages, pauses, idle time
- *Book*: % complete, time spent, sessions, avg/best WPM, estimated time remaining, first and last read
- *Global*: total time, books started/finished, current and longest streak, daily-minutes bars, a year heatmap, time-of-day distribution, WPM trend over time, words/day, average session length

All charts are hand-drawn SVG — no chart library, full control over the look.

## 5. Storage & offline

IndexedDB via Dexie, `navigator.storage.persist()` requested on first import, service worker for offline. JSON export/import of the whole library as a backup, since Safari can evict data for sites that aren't installed to the Home Screen.

## 6. Path to native

Web app → Capacitor/WKWebView shell (adds App Store, `.epub` file associations, guaranteed persistence) → optional SwiftUI chrome around the same reading webview. Keeping `engine/` framework-free is what makes each step cheap.
