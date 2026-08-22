/* The shelf tab.
 *
 * Two things, in this order: the wall of what you have read, and the
 * arithmetic underneath it. The wall comes first deliberately — the numbers
 * are interesting but the shelf is the reason to open the tab, and a screen
 * that opens on a grid of statistics is a screen you check once.
 */

import { useEffect, useMemo, useState } from 'react';
import { MoodRibbon, Radar, ScoreCurve } from './Charts';
import { SpineWall, type SpineExtras } from './SpineWall';
import { TasteCard } from './TasteCard';
import { RatingSheet } from './RatingSheet';
import { Sheet } from './Sheet';
import { IconPencil, IconPlus, IconStar } from './Icons';
import { useDarkTheme } from './theme';
import { useRatings, rateableBooks, type Rateable } from '../store/ratings';
import { useLibrary } from '../store/library';
import { useDevice } from '../store/device';
import { useEditions, type EditionSubject } from '../store/editions';
import { useOwnCovers } from '../store/ownCovers';
import type { TroubleKind } from '../meta/editions';
import { useSettings } from '../store/settings';
import { editionKey, type EditionData } from '../engine/edition';
import { knowsAnything } from '../engine/spine';
import {
  MOODS,
  SORTS,
  moodColor,
  moodOf,
  sortRatings,
  tasteProfile,
  type RatingRecord,
  type SortKey,
} from '../engine/rating';
import { relativeDate } from '../engine/stats';

/* Each of these is a different thing to go and do, which is the whole
   reason they are not one "couldn't load covers". `no-endpoint` is the one
   that bit in practice: `vite dev` has no Worker behind it and answers
   /api/lookup with the app's own index.html, so the shelf is talking to
   itself. `npm run worker` is the local setup that has an API. */
const TROUBLE: Record<TroubleKind, string> = {
  'signed-out': 'Sign in on the account tab to look covers up.',
  'no-endpoint':
    'No lookup service answered. On a dev server use `npm run worker`; on the live app, deploy again.',
  offline: 'Offline — the shelf will fill in next time you have a connection.',
  'rate-limited': 'Pausing for a minute, then carrying on where it left off.',
  /* Never shown: a 'server' trouble always carries the Worker's own
     sentence, which is more specific than anything that could be written
     here. Present so the map stays exhaustive. */
  server: 'The lookup service reported a problem.',
};

/** `EditionSubject` plus the library book it resolved to, purely so the
    own-cover fallback below knows which `db.covers` row to read — the
    catalogue lookup itself only ever sees the four fields it always saw. */
interface RatingSubject extends EditionSubject {
  bookId?: string;
}

export function Ratings() {
  const ratings = useRatings((s) => s.ratings);
  const dark = useDarkTheme();

  const [sort, setSort] = useState<SortKey>('rating');
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<RatingRecord | null>(null);
  const [rating, setRating] = useState<Rateable | null>(null);

  /* Both stores are read here purely so this component re-renders when a
     book is imported or a reader book added — `rateableBooks()` reaches
     into them imperatively and would otherwise show a stale list. */
  useLibrary((s) => s.books);
  useDevice((s) => s.books);

  const profile = useMemo(() => tasteProfile(ratings), [ratings]);
  const wall = useMemo(() => sortRatings(ratings, sort), [ratings, sort]);
  const candidates = useMemo(() => (picking ? rateableBooks() : []), [picking]);

  /* ── the realistic shelf ──────────────────────────────────────────
     Which mode the wall is in is a setting rather than local state: it is
     a way of looking at your reading, not a filter, and having it reset
     every time the tab is left would make it feel like a toy. */
  const shelfMode = useSettings((s) => s.shelfMode);
  const setSetting = useSettings((s) => s.set);
  const byKey = useEditions((s) => s.byKey);
  const filling = useEditions((s) => s.filling);
  const trouble = useEditions((s) => s.trouble);
  const fill = useEditions((s) => s.fill);
  const refill = useEditions((s) => s.refill);

  /* What each rating's book knows about itself, over and above the rating.
     The publisher and the language come from the EPUB when there is one —
     both beat the catalogue, because they describe the edition actually in
     hand rather than a best match for its title. */
  const subjects = useMemo((): Map<string, RatingSubject> => {
    const lib = useLibrary.getState().books;
    const dev = useDevice.getState().books;
    const out = new Map<string, RatingSubject>();

    for (const r of ratings) {
      const book = r.bookId ? lib.find((b) => b.id === r.bookId) : undefined;
      /* A device book may be linked to a library one, in which case the
         EPUB is the better source even though the rating points at the
         reader shelf. */
      const device = r.deviceBookId ? dev.find((d) => d.id === r.deviceBookId) : undefined;
      const linked = device?.bookId ? lib.find((b) => b.id === device.bookId) : undefined;
      const resolved = book ?? linked;

      out.set(r.id, {
        /* The rating's own title and author, not the book's. They are what
           the shelf shows and what a deleted book leaves behind, so the
           lookup has to key off them or a book removed to save space would
           quietly lose its cover. */
        title: r.title,
        author: r.author,
        ...(resolved?.meta.language ? { lang: resolved.meta.language } : {}),
        ...(resolved?.meta.publisher ? { publisher: resolved.meta.publisher } : {}),
        ...(resolved ? { bookId: resolved.id } : {}),
      });
    }
    return out;
  }, [ratings]);

  /* The own-cover fallback. `byId` from `useOwnCovers` so the wall re-renders
     once an extraction lands. */
  const ownCoverById = useOwnCovers((s) => s.byId);
  const ensureOwnCover = useOwnCovers((s) => s.ensure);

  /* Only for a book the catalogue has definitively said nothing about — a
     row exists (the lookup ran) and `knowsAnything` is false — never for one
     still waiting on a lookup, so this can't flash the own cover and then
     the catalogue's a moment later. Reading `db.covers` and running the
     palette extractor is local and instant, so unlike the catalogue fill
     this doesn't need pacing; it is still gated on `shelfMode` so a book
     never spends a canvas pass for a shelf nobody switched to. */
  useEffect(() => {
    if (shelfMode !== 'shelf') return;
    for (const subject of subjects.values()) {
      if (!subject.bookId) continue;
      const row = byKey[editionKey(subject.title, subject.author)];
      if (row && !knowsAnything(row.data) && !(subject.bookId in ownCoverById)) {
        void ensureOwnCover(subject.bookId);
      }
    }
  }, [shelfMode, subjects, byKey, ownCoverById, ensureOwnCover]);

  const extras = useMemo((): Record<string, SpineExtras> => {
    const out: Record<string, SpineExtras> = {};
    for (const [id, subject] of subjects) {
      const key = editionKey(subject.title, subject.author);
      const row = byKey[key];
      const ownArt = subject.bookId ? ownCoverById[subject.bookId] : undefined;
      /* The book's own cover stands in only on a definitive miss — see the
         effect above — and only when something of it actually survived
         extraction. */
      const fallback: EditionData | undefined =
        row && !knowsAnything(row.data) && (ownArt?.palette?.length || ownArt?.texture)
          ? {
              key,
              ...(ownArt.palette?.length ? { palette: ownArt.palette } : {}),
              ...(ownArt.texture ? { edgeTexture: ownArt.texture } : {}),
            }
          : undefined;
      const edition = fallback ?? row?.data;
      out[id] = {
        ...(edition ? { edition } : {}),
        ...(subject.publisher ? { publisher: subject.publisher } : {}),
        ...(subject.lang ? { language: subject.lang } : {}),
      };
    }
    return out;
  }, [subjects, byKey, ownCoverById]);

  /* Only fetched once the realistic shelf has actually been asked for.
     Looking every book up on the chance that somebody might switch would
     be a few dozen requests to three other people's services for a screen
     nobody opened — and the run is paced at one a second, so it is not
     free even when it is idle. */
  useEffect(() => {
    if (shelfMode !== 'shelf' || !ratings.length) return;
    void fill([...subjects.values()]);
  }, [shelfMode, subjects, ratings.length, fill]);

  const closeSheets = () => {
    setEditing(null);
    setRating(null);
  };

  return (
    <div className="scroller">
      <div className="wrap">
        <div className="lib-head">
          <div>
            <div className="eyebrow">The shelf</div>
            <h1 className="display" style={{ marginTop: 6 }}>
              {ratings.length === 0
                ? 'Nothing rated yet'
                : `${ratings.length} ${ratings.length === 1 ? 'book' : 'books'} rated`}
            </h1>
          </div>
          <button className="btn primary" onClick={() => setPicking(true)}>
            <IconPlus size={17} /> Rate a book
          </button>
        </div>

        {ratings.length === 0 ? (
          <div className="empty">
            <p style={{ fontFamily: 'var(--font-read)', fontSize: 20, color: 'var(--ink-2)' }}>
              An empty shelf
            </p>
            <p style={{ fontSize: 13, marginTop: 8, maxWidth: 400, marginInline: 'auto' }}>
              Give a book a score, five reasons and a colour. It comes back as a
              spine — taller when you liked it, thicker when it was long — and
              the shelf slowly becomes a picture of your taste.
            </p>
          </div>
        ) : (
          <>
            <p className="taste-line">{profile.tagline}</p>

            <div className="shelf-controls">
              <div className="segment">
                {SORTS.map((s) => (
                  <button
                    key={s.key}
                    className={sort === s.key ? 'on' : ''}
                    onClick={() => setSort(s.key)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Two readings of the same shelf, not a display preference.
                  See the note at the top of engine/spine.ts: the realistic
                  one gives height and colour back to the object and hands
                  the score down to the stamp at the foot. */}
              <div className="segment">
                <button
                  className={shelfMode === 'data' ? 'on' : ''}
                  onClick={() => setSetting('shelfMode', 'data')}
                  title="Colour is the mood, height is the score"
                >
                  Data
                </button>
                <button
                  className={shelfMode === 'shelf' ? 'on' : ''}
                  onClick={() => setSetting('shelfMode', 'shelf')}
                  title="The books as they actually look"
                >
                  Shelf
                </button>
              </div>

              {/* Throwing the local cache away is safe here in a way it is
                  nowhere else in this app: the table holds no user data,
                  and the server has every answer already, so this costs a
                  round trip to our own Worker and nothing to any
                  catalogue. It is the answer to a wrong cover, and to a
                  fix that shipped and did not seem to arrive. */}
              {shelfMode === 'shelf' && !filling && (
                <button
                  className="linky muted"
                  onClick={() => void refill([...subjects.values()])}
                  title="Discard what is stored and ask the catalogues again"
                >
                  Look up again
                </button>
              )}
            </div>

            {shelfMode === 'shelf' && (filling || trouble) && (
              <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                {/* The realistic shelf degrades to the ordinary one when a
                    lookup fails, which is right — and which also makes
                    every possible failure look identical from here: you
                    press Shelf and nothing happens. So say which one. */}
                {trouble
                  ? (trouble.detail ?? TROUBLE[trouble.kind])
                  : 'Finding covers — the shelf fills in as they arrive.'}
              </p>
            )}

            <SpineWall
              ratings={wall}
              dark={dark}
              mode={shelfMode}
              extras={extras}
              activeId={editing?.id}
              onOpen={(r) => setEditing(r)}
            />

            <div className="stat-grid" style={{ marginTop: 'var(--s7)' }}>
              <div className="card">
                <div className="k">Average</div>
                <div className="v num">{profile.mean.toFixed(1)}</div>
                <div className="sub">median {profile.median.toFixed(1)}</div>
              </div>
              <div className="card">
                <div className="k">Range you use</div>
                <div className="v num">
                  ±{profile.spread.toFixed(1)}
                </div>
                <div className="sub">
                  {profile.spread < 1
                    ? 'a narrow band'
                    : profile.spread > 2.4
                      ? 'the whole scale'
                      : 'a healthy spread'}
                </div>
              </div>
              <div className="card">
                <div className="k">Rated this year</div>
                <div className="v num">{profile.thisYear}</div>
                <div className="sub">
                  {profile.count - profile.thisYear} before that
                </div>
              </div>
              <div className="card">
                <div className="k">Favourites</div>
                <div className="v num">{ratings.filter((r) => r.favourite).length}</div>
                <div className="sub">
                  {profile.topMood
                    ? `mostly ${moodOf(profile.topMood)?.label.toLowerCase()}`
                    : 'no mood yet'}
                </div>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gap: 'var(--s5)',
                gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))',
              }}
            >
              <div className="panel">
                <h3>
                  Your curve <span>where the scores land</span>
                </h3>
                <ScoreCurve histogram={profile.histogram} mean={profile.mean} />
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  {profile.spread < 1
                    ? 'Almost everything gets the same score — the shelf is doing more work than the number is.'
                    : 'The dashed line is your average.'}
                </p>
              </div>

              <div className="panel">
                <h3>
                  What you reward <span>averaged across every rating</span>
                </h3>
                <Radar values={profile.axisMeans} size={200} />
                {profile.rewards && profile.punishes && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    You are kindest to {profile.rewards} and hardest on {profile.punishes}.
                  </p>
                )}
              </div>
            </div>

            <div className="panel">
              <h3>
                The colour of the shelf <span>by mood</span>
              </h3>
              <MoodRibbon moods={profile.moods} dark={dark} />
              <div className="mood-legend">
                {profile.moods.map((m) => (
                  <span key={m.mood}>
                    <i style={{ background: moodColor(moodOf(m.mood), dark) }} />
                    {MOODS.find((x) => x.key === m.mood)?.label} · {m.count}
                  </span>
                ))}
              </div>
            </div>

            <TasteCard ratings={ratings} />

            {profile.best && (
              <div className="panel">
                <h3>
                  Standouts <span>best and worst</span>
                </h3>
                <Standout rating={profile.best} kind="Highest" onEdit={setEditing} />
                {profile.worst && profile.worst.id !== profile.best.id && (
                  <Standout rating={profile.worst} kind="Lowest" onEdit={setEditing} />
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* pick something to rate */}
      <Sheet open={picking} onClose={() => setPicking(false)}>
        <div style={{ maxWidth: 620, margin: '0 auto' }}>
          <h2 className="display" style={{ fontSize: 22 }}>
            What did you read?
          </h2>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            Everything on both shelves — finished books first.
          </p>
          <div style={{ marginTop: 18 }}>
            {candidates.length === 0 && (
              <p className="muted" style={{ fontSize: 13 }}>
                Import an EPUB or add a book to the reader shelf first.
              </p>
            )}
            {candidates.map((c) => {
              const already = c.bookId
                ? ratings.find((r) => r.bookId === c.bookId)
                : ratings.find((r) => r.deviceBookId === c.deviceBookId);
              return (
                <button
                  key={c.key}
                  className="pick-row"
                  onClick={() => {
                    setPicking(false);
                    if (already) setEditing(already);
                    else setRating(c);
                  }}
                >
                  <div className="n">
                    <div className="t">{c.title}</div>
                    <div className="a">
                      {c.author || 'Unknown'} ·{' '}
                      {c.finished ? 'finished' : `${Math.round(c.percent * 100)}% read`}
                    </div>
                  </div>
                  {already ? (
                    <span className="pick-score">{already.overall}</span>
                  ) : (
                    <IconPlus size={16} className="muted" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </Sheet>

      <RatingSheet
        open={Boolean(editing || rating)}
        existing={editing}
        subject={rating}
        dark={dark}
        onClose={closeSheets}
      />
    </div>
  );
}

function Standout({
  rating,
  kind,
  onEdit,
}: {
  rating: RatingRecord;
  kind: string;
  onEdit: (r: RatingRecord) => void;
}) {
  const dark = useDarkTheme();
  const mood = moodOf(rating.mood);
  return (
    <button className="standout" onClick={() => onEdit(rating)}>
      <i style={{ background: moodColor(mood, dark) }} aria-hidden />
      <div style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
        <div className="label">
          {kind}
          {rating.favourite && <IconStar size={12} solid />}
        </div>
        <div className="t">{rating.title}</div>
        {rating.note ? (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            “{rating.note}”
          </p>
        ) : (
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            rated {relativeDate(rating.ratedAt)}
          </p>
        )}
      </div>
      <span className="pick-score">{rating.overall}</span>
      <IconPencil size={15} className="muted" />
    </button>
  );
}
