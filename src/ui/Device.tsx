/* The device shelf.

   A second library for books you read on an e-ink reader, where the only
   things this app can know are the ones you tell it: how long the book is,
   how long you read, and what page you stopped on. Everything else on this
   screen is derived from those three numbers. */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { elapsedOf, useDevice } from '../store/device';
import { useLibrary } from '../store/library';
import { BookCover } from './BookCover';
import { Sheet } from './Sheet';
import {
  IconCheck,
  IconImage,
  IconLink,
  IconPause,
  IconPlay,
  IconPlus,
  IconStop,
  IconTimer,
  IconTrash,
} from './Icons';
import { ScanPanel } from './ScanSheet';
import { formatCount, formatDuration, formatEta, relativeDate, wpm } from '../engine/stats';
import {
  pageToPercent,
  pagesPerHour,
  pagesToWords,
  percentToPage,
  remaining,
  wordsPerPage,
  type Locus,
} from '../engine/device';
import type { BookRecord, DeviceBookRecord } from '../db';

/* ── small pieces ─────────────────────────────────────────────────── */

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

const dateInput = (t: number): string => {
  const d = new Date(t - d0(t));
  return d.toISOString().slice(0, 16);
};
const d0 = (t: number) => new Date(t).getTimezoneOffset() * 60_000;

function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} />
      {hint && (
        <em
          style={{
            fontStyle: 'normal',
            fontSize: 11.5,
            color: 'var(--ink-3)',
            marginTop: 4,
            display: 'block',
          }}
        >
          {hint}
        </em>
      )}
    </label>
  );
}

function DeviceCover({ book }: { book: DeviceBookRecord }) {
  return (
    <div
      className="cover-fallback"
      style={
        {
          '--c1': `hsl(${book.hue} 22% 38%)`,
          '--c2': `hsl(${(book.hue + 38) % 360} 18% 20%)`,
        } as CSSProperties
      }
    >
      <div className="t">{book.title}</div>
      <div className="a">{book.author || 'Unknown'}</div>
    </div>
  );
}

/* ── screen ───────────────────────────────────────────────────────── */

export function Device() {
  const {
    books,
    sessions,
    timer,
    lastSync,
    load,
    loaded,
    start,
    pause,
    resume,
    discard,
    finish,
    addBook,
    updateBook,
    removeBook,
    link,
    logManual,
    removeSession,
    clearReceipt,
  } = useDevice();
  const library = useLibrary((s) => s.books);
  const progress = useLibrary((s) => s.progress);
  const covers = useLibrary((s) => s.covers);

  const [adding, setAdding] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  /* one repaint a second while a session runs, and none at all otherwise */
  useEffect(() => {
    if (!timer?.runningSince) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [timer?.runningSince]);

  useEffect(() => {
    if (!lastSync) return;
    const id = window.setTimeout(clearReceipt, 6000);
    return () => window.clearTimeout(id);
  }, [lastSync, clearReceipt]);

  const byBook = useMemo(() => {
    const map: Record<string, typeof sessions> = {};
    for (const s of sessions) (map[s.deviceBookId] ??= []).push(s);
    return map;
  }, [sessions]);

  const totalMs = sessions.reduce((a, s) => a + s.ms, 0);
  const totalPages = sessions.reduce((a, s) => a + s.pages, 0);
  const timerBook = books.find((b) => b.id === timer?.deviceBookId) ?? null;
  const detail = books.find((b) => b.id === detailId) ?? null;

  return (
    <div className="scroller">
      <div className="wrap">
        <div className="lib-head">
          <div>
            <div className="eyebrow">E-Reader</div>
            <h1 className="display" style={{ marginTop: 6 }}>
              {books.length === 0
                ? 'Nothing tracked yet'
                : `${formatDuration(totalMs, true)} off-app`}
            </h1>
            {books.length > 0 && (
              <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                {totalPages.toLocaleString()} pages across {sessions.length}{' '}
                {sessions.length === 1 ? 'session' : 'sessions'} · counted in your statistics
              </p>
            )}
          </div>
          <button className="btn primary" onClick={() => setAdding(true)}>
            <IconPlus size={17} /> Track a book
          </button>
        </div>

        {/* ── the running session ─────────────────────────────── */}
        {timer && timerBook && (
          <div className="timer-card">
            <div className="timer-meta">
              <div className="eyebrow">
                {timer.runningSince ? 'Reading now' : 'Paused'}
              </div>
              <h2 className="display" style={{ fontSize: 'clamp(19px,2.4vw,25px)', marginTop: 6 }}>
                {timerBook.title}
              </h2>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                from page {timer.fromPage + 1} · {timerBook.pages - timer.fromPage} pages
                left in the book
              </p>
            </div>

            <div className={`timer-clock${timer.runningSince ? ' live' : ''}`}>
              {clock(elapsedOf(timer))}
            </div>

            <div className="timer-actions">
              {timer.runningSince ? (
                <button className="icon-btn" onClick={() => void pause()} aria-label="Pause">
                  <IconPause size={18} />
                </button>
              ) : (
                <button className="icon-btn on" onClick={() => void resume()} aria-label="Resume">
                  <IconPlay size={18} />
                </button>
              )}
              <button className="btn primary" onClick={() => setFinishing(true)}>
                <IconStop size={14} /> Finish
              </button>
              <button className="btn ghost" onClick={() => void discard()}>
                Discard
              </button>
            </div>
          </div>
        )}

        {/* ── the shelf ───────────────────────────────────────── */}
        {books.length === 0 ? (
          <div className="empty">
            <p style={{ fontFamily: 'var(--font-read)', fontSize: 20, color: 'var(--ink-2)' }}>
              Reading somewhere else
            </p>
            <p style={{ fontSize: 13, marginTop: 8, maxWidth: 460, marginInline: 'auto' }}>
              Add a book you're reading on your e-reader with its page count. Time a
              session, enter the page you stopped on, and it lands in your statistics —
              and in the same book here, if you have it.
            </p>
          </div>
        ) : (
          <div className="shelf">
            {books.map((b, i) => {
              const own = byBook[b.id] ?? [];
              const percent = pageToPercent(b, b.currentPage);
              const linked = library.find((x) => x.id === b.bookId);
              /* Same projection the book's own sheet shows, on the shelf
                 itself: how long is left is the thing you want to know
                 while choosing what to pick up, not after opening it. */
              const left = remaining(b, b.currentPage, own);
              return (
                <div
                  key={b.id}
                  className="book"
                  style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                >
                  <button
                    style={{ display: 'block', width: '100%' }}
                    onClick={() => setDetailId(b.id)}
                  >
                    <div className="cover">
                      {linked ? (
                        <BookCover book={linked} url={covers[linked.id]} />
                      ) : (
                        <DeviceCover book={b} />
                      )}
                      {linked && (
                        <span className="cloud-badge" title={`Linked to ${linked.meta.title}`}>
                          <IconLink size={13} />
                        </span>
                      )}
                    </div>
                    <div className="meta">
                      <div className="t">{b.title}</div>
                      <div className="a">
                        p. {b.currentPage || b.startPage} / {b.pages}
                      </div>
                      <div className="progress-rail">
                        <i style={{ width: `${percent * 100}%` }} />
                      </div>
                      <div className="a" style={{ marginTop: 4 }}>
                        {left.ms != null
                          ? `${formatEta(left.ms)} left`
                          : `${left.pages} pages left`}
                      </div>
                    </div>
                  </button>
                  {!timer && (
                    <button
                      className="btn ghost"
                      style={{ height: 28, padding: '0 10px', fontSize: 11.5, marginTop: 6 }}
                      onClick={() => void start(b.id)}
                    >
                      <IconTimer size={13} /> Start
                    </button>
                  )}
                  {own.length > 0 && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                      {formatDuration(own.reduce((a, s) => a + s.ms, 0))} ·{' '}
                      {relativeDate(Math.max(...own.map((s) => s.start)))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lastSync && (
        <div className="toast" onClick={clearReceipt}>
          {lastSync.moved
            ? `${lastSync.title} moved to ${Math.round(lastSync.to * 100)}% in your library`
            : `${lastSync.title} logged — the app was already further along, so your place kept`}
        </div>
      )}

      {/* ── sheets ─────────────────────────────────────────────── */}
      <AddSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={async (input) => {
          await addBook(input);
          setAdding(false);
        }}
      />

      <FinishSheet
        open={finishing && !!timer && !!timerBook}
        book={timerBook}
        linkedBook={library.find((b) => b.id === timerBook?.bookId) ?? null}
        fromPage={timer?.fromPage ?? 0}
        ms={elapsedOf(timer)}
        sessions={timerBook ? byBook[timerBook.id] ?? [] : []}
        totalWords={library.find((b) => b.id === timerBook?.bookId)?.totalWords}
        onClose={() => setFinishing(false)}
        onFinish={async (page, note, toLocus) => {
          await finish(page, note, toLocus);
          setFinishing(false);
        }}
      />

      <Sheet open={!!detail} onClose={() => setDetailId(null)}>
        {detail && (
          <BookDetail
            book={detail}
            sessions={byBook[detail.id] ?? []}
            libraryPercent={detail.bookId ? progress[detail.bookId]?.percent ?? 0 : null}
            libraryTitle={library.find((b) => b.id === detail.bookId)?.meta.title ?? null}
            linkedBook={library.find((b) => b.id === detail.bookId) ?? null}
            coverUrl={detail.bookId ? covers[detail.bookId] : undefined}
            totalWords={library.find((b) => b.id === detail.bookId)?.totalWords}
            candidates={library.map((b) => ({
              id: b.id,
              label: `${b.meta.title}${b.meta.author ? ` — ${b.meta.author}` : ''}`,
            }))}
            timerRunning={!!timer}
            onStart={() => {
              void start(detail.id);
              setDetailId(null);
            }}
            onUpdate={(patch) => void updateBook(detail.id, patch)}
            onLink={(bookId) => void link(detail.id, bookId)}
            onLog={(input) => void logManual({ deviceBookId: detail.id, ...input })}
            onRemoveSession={(id) => void removeSession(id)}
            onRemove={() => {
              void removeBook(detail.id);
              setDetailId(null);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

/* ── add ──────────────────────────────────────────────────────────── */

function AddSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (input: {
    title: string;
    author: string;
    pages: number;
    startPage: number;
    currentPage: number;
    device?: string;
    bookId?: string;
    linkPinned?: boolean;
  }) => Promise<void>;
}) {
  const library = useLibrary((s) => s.books);
  const [mode, setMode] = useState<'custom' | 'library'>('custom');
  const [libraryId, setLibraryId] = useState('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [pages, setPages] = useState('');
  const [startPage, setStartPage] = useState('1');
  const [currentPage, setCurrentPage] = useState('');
  const [device, setDevice] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('custom');
    setLibraryId('');
    setTitle('');
    setAuthor('');
    setPages('');
    setStartPage('1');
    setCurrentPage('');
  }, [open]);

  // picking a library book fixes the title/author and pins the link;
  // switching back to custom clears both so nothing is linked silently
  const pickLibraryBook = (id: string) => {
    setLibraryId(id);
    const b = library.find((x) => x.id === id);
    if (b) {
      setTitle(b.meta.title ?? '');
      setAuthor(b.meta.author ?? '');
    }
  };

  const valid =
    title.trim().length > 1 &&
    Number(pages) > 1 &&
    (mode === 'custom' || libraryId !== '');

  return (
    <Sheet open={open} onClose={onClose}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <h2 className="display" style={{ fontSize: 24 }}>
          Track a book
        </h2>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          The page count is what makes syncing possible: it's the scale that
          turns "I read to page 148" into a percentage this app understands.
        </p>

        {library.length > 0 && (
          <div className="segment" style={{ marginTop: 18 }}>
            <button
              className={mode === 'custom' ? 'on' : ''}
              onClick={() => {
                setMode('custom');
                setLibraryId('');
                setTitle('');
                setAuthor('');
              }}
            >
              Custom
            </button>
            <button
              className={mode === 'library' ? 'on' : ''}
              onClick={() => setMode('library')}
            >
              From your library
            </button>
          </div>
        )}

        {mode === 'library' && library.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <label className="field">
              <span>Library book</span>
              <select value={libraryId} onChange={(e) => pickLibraryBook(e.currentTarget.value)}>
                <option value="">Choose a book…</option>
                {library.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.meta.title}
                    {b.meta.author ? ` — ${b.meta.author}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              This links the tracked entry to that book right away, instead of
              waiting for the title and author to match automatically.
            </p>
          </div>
        )}

        <div className="auth-form" style={{ marginTop: 18 }}>
          {mode === 'custom' && (
            <>
              <Field
                label="Title"
                value={title}
                autoFocus
                onChange={(e) => setTitle(e.currentTarget.value)}
                placeholder="The Dispossessed"
              />
              <Field
                label="Author"
                value={author}
                onChange={(e) => setAuthor(e.currentTarget.value)}
                placeholder="Ursula K. Le Guin"
                hint="Matched against your library to link the two automatically."
              />
            </>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
            <Field
              label="Pages on the reader"
              inputMode="numeric"
              value={pages}
              onChange={(e) => setPages(e.currentTarget.value.replace(/\D/g, ''))}
              placeholder="384"
            />
            <Field
              label="Currently on page"
              inputMode="numeric"
              value={currentPage}
              onChange={(e) => setCurrentPage(e.currentTarget.value.replace(/\D/g, ''))}
              placeholder="0"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
            <Field
              label="Body starts on page"
              inputMode="numeric"
              value={startPage}
              onChange={(e) => setStartPage(e.currentTarget.value.replace(/\D/g, ''))}
              hint="Front matter skews every percentage. Leave at 1 if unsure."
            />
            <Field
              label="Device"
              value={device}
              onChange={(e) => setDevice(e.currentTarget.value)}
              placeholder="Kobo Libra"
            />
          </div>
        </div>

        <button
          className="auth-submit"
          disabled={!valid}
          style={{ marginTop: 18 }}
          onClick={() =>
            void onAdd({
              title,
              author,
              pages: Number(pages),
              startPage: Math.max(1, Number(startPage) || 1),
              currentPage: Number(currentPage) || 0,
              device: device || undefined,
              ...(mode === 'library' && libraryId
                ? { bookId: libraryId, linkPinned: true }
                : {}),
            })
          }
        >
          Add to shelf
        </button>
      </div>
    </Sheet>
  );
}

/* ── finish a timed session ───────────────────────────────────────── */

function FinishSheet({
  open,
  book,
  linkedBook,
  fromPage,
  ms,
  sessions,
  totalWords,
  onClose,
  onFinish,
}: {
  open: boolean;
  book: DeviceBookRecord | null;
  /** the same book in the library, when there is one and its EPUB is here */
  linkedBook: BookRecord | null;
  fromPage: number;
  ms: number;
  sessions: { ms: number; pages: number; start: number }[];
  totalWords?: number;
  onClose: () => void;
  onFinish: (toPage: number, note?: string, toLocus?: Locus) => Promise<void>;
}) {
  const [toPage, setToPage] = useState('');
  const [note, setNote] = useState('');
  const [locus, setLocus] = useState<Locus | null>(null);
  /* Scanning needs the book's own words, so it is offered only when the
     EPUB is on this device — everywhere else the page number is the only
     bridge there is, and asking for it plainly beats a shortcut that turns
     out not to work. Where it is offered, it's the default: a scan reads
     the exact spot, which is what the page number was always standing in
     for. `manual` is the fallback, reached either automatically (no scan
     possible) or by hand ("enter the page instead"). */
  const [manual, setManual] = useState(false);

  /* Prefill with what your own pace says you probably reached. It is a
     guess and is labelled as one, but it is a far better starting point
     than an empty box, and the number you type over it teaches the next
     estimate. */
  const guess = useMemo(() => {
    if (!book) return null;
    const rate = pagesPerHour(sessions);
    if (rate <= 0) return null;
    return Math.min(book.pages, Math.round(fromPage + (ms / 3_600_000) * rate));
  }, [book, sessions, fromPage, ms]);

  const canScan = !!book && !!linkedBook && !linkedBook.fileMissing;

  useEffect(() => {
    if (open) {
      setToPage(guess ? String(guess) : '');
      setNote('');
      setLocus(null);
      setManual(!canScan);
    }
  }, [open, guess, canScan]);

  if (!book) return null;

  if (canScan && !manual) {
    return (
      <Sheet open={open} onClose={onClose}>
        <ScanPanel
          open
          onClose={() => setManual(true)}
          bookId={linkedBook!.id}
          spine={linkedBook!.spine}
          title={book.title}
          action="That's where I stopped"
          cancelLabel="Enter the page number instead"
          describe={(l) =>
            `page ${percentToPage(book, l.percent)} · ${Math.round(l.percent * 100)}% through`
          }
          onLocated={(l) => {
            setLocus(l);
            setToPage(String(percentToPage(book, l.percent)));
            setManual(true);
          }}
        />
      </Sheet>
    );
  }

  const to = Number(toPage) || 0;
  const pages = Math.max(0, to - fromPage);
  const percent = pageToPercent(book, to);
  const words = pagesToWords(book, pages, totalWords);

  return (
    <Sheet open={open} onClose={onClose}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div className="eyebrow">Session finished</div>
        <h2 className="display" style={{ fontSize: 26, marginTop: 6 }}>
          {formatDuration(ms, true)} on {book.title}
        </h2>

        <div className="auth-form" style={{ marginTop: 20 }}>
          <Field
            label="Stopped on page"
            inputMode="numeric"
            autoFocus
            value={toPage}
            onChange={(e) => {
              // typing over a scanned page invalidates the exact position
              // it came with — the number is no longer standing in for it
              setLocus(null);
              setToPage(e.currentTarget.value.replace(/\D/g, ''));
            }}
            placeholder={String(fromPage)}
            hint={
              locus
                ? `Matched by scan · ${Math.round(locus.percent * 100)}% through the book`
                : guess
                  ? `You'd read to page ${fromPage}. Your recent pace suggests about ${guess}.`
                  : `You'd read to page ${fromPage} before this session.`
            }
          />

          {canScan && (
            <button
              className="btn ghost"
              style={{ justifyContent: 'center' }}
              onClick={() => setManual(false)}
            >
              <IconImage size={15} /> {locus ? 'Scan again' : 'Scan the page instead'}
            </button>
          )}

          <Field
            label="Note"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            placeholder="optional"
          />
        </div>

        {pages > 0 && (
          <div className="row" style={{ marginTop: 16 }}>
            <div>
              <div className="label">This session</div>
              <div className="hint">
                {pages} pages · {formatCount(words)} words ·{' '}
                {wpm(words, ms) || '—'} wpm
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="label">Book</div>
              <div className="hint">{Math.round(percent * 100)}% read</div>
            </div>
          </div>
        )}

        <button
          className="auth-submit"
          style={{ marginTop: 18 }}
          disabled={to < fromPage}
          onClick={() => void onFinish(to || fromPage, note, locus ?? undefined)}
        >
          <IconCheck size={16} /> Save session
        </button>
      </div>
    </Sheet>
  );
}

/* ── book detail ──────────────────────────────────────────────────── */

function BookDetail({
  book,
  sessions,
  libraryPercent,
  libraryTitle,
  linkedBook,
  coverUrl,
  totalWords,
  candidates,
  timerRunning,
  onStart,
  onUpdate,
  onLink,
  onLog,
  onRemoveSession,
  onRemove,
}: {
  book: DeviceBookRecord;
  sessions: {
    id?: number;
    start: number;
    ms: number;
    pages: number;
    words: number;
    fromPage: number;
    toPage: number;
    note?: string;
  }[];
  libraryPercent: number | null;
  libraryTitle: string | null;
  linkedBook: BookRecord | null;
  coverUrl?: string;
  totalWords?: number;
  candidates: { id: string; label: string }[];
  timerRunning: boolean;
  onStart: () => void;
  onUpdate: (patch: Partial<DeviceBookRecord>) => void;
  onLink: (bookId: string | null) => void;
  onLog: (input: {
    start: number;
    ms: number;
    fromPage: number;
    toPage: number;
    toLocus?: Locus;
    note?: string;
  }) => void;
  onRemoveSession: (id: number) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const canScan = !!linkedBook && !linkedBook.fileMissing;
  const percent = pageToPercent(book, book.currentPage);
  const ms = sessions.reduce((a, s) => a + s.ms, 0);
  const pages = sessions.reduce((a, s) => a + s.pages, 0);
  const words = sessions.reduce((a, s) => a + s.words, 0);
  const left = remaining(book, book.currentPage, sessions);
  const density = wordsPerPage(book, totalWords);

  /* The panel takes over the whole sheet rather than appearing below the
     statistics: reading a page off a camera wants the screen, and the
     numbers will still be here — corrected — when it hands back. */
  if (scanning && linkedBook) {
    return (
      <ScanPanel
        open
        onClose={() => setScanning(false)}
        bookId={linkedBook.id}
        spine={linkedBook.spine}
        title={book.title}
        action="Set as my current page"
        cancelLabel="Back"
        describe={(locus) =>
          `page ${percentToPage(book, locus.percent)} of ${book.pages} · ${Math.round(locus.percent * 100)}%`
        }
        onLocated={(locus) => {
          onUpdate({ currentPage: percentToPage(book, locus.percent), currentLocus: locus });
          setScanning(false);
        }}
      />
    );
  }

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 20 }}>
        <div
          className="cover"
          style={{
            width: 92,
            flex: 'none',
            aspectRatio: '2/3',
            borderRadius: '3px 8px 8px 3px',
            overflow: 'hidden',
            position: 'relative',
            boxShadow: 'var(--shadow-2)',
          }}
        >
          {linkedBook ? (
            <BookCover book={linkedBook} url={coverUrl} />
          ) : (
            <DeviceCover book={book} />
          )}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="display" style={{ fontSize: 23 }}>
            {book.title}
          </h2>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            {book.author || 'Unknown author'}
            {book.device ? ` · ${book.device}` : ''}
          </p>
          <div className="progress-rail" style={{ marginTop: 12 }}>
            <i style={{ width: `${percent * 100}%` }} />
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            page {book.currentPage || book.startPage} of {book.pages} ·{' '}
            {Math.round(percent * 100)}% · about {Math.round(density)} words a page
          </p>
        </div>
      </div>

      {/* what the app knows about the same book */}
      <div className={`link-strip${book.bookId ? ' on' : ''}`}>
        <IconLink size={15} />
        {book.bookId ? (
          <span>
            Synced with <b>{libraryTitle}</b> — {Math.round((libraryPercent ?? 0) * 100)}% in
            the app
            {libraryPercent != null && Math.abs(libraryPercent - percent) > 0.01 && (
              <em style={{ fontStyle: 'normal', color: 'var(--ink-3)' }}>
                {' '}· {percent > libraryPercent ? 'reader is ahead' : 'app is ahead'}
              </em>
            )}
          </span>
        ) : (
          <span>Not linked to a book in your library — time and pages still count.</span>
        )}
      </div>

      <div className="stat-grid" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="k">Time on this book</div>
          <div className="v num">{formatDuration(ms)}</div>
          <div className="sub">
            {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'} · {pages}{' '}
            pages · {formatCount(words)} words
          </div>
        </div>
        <div className="card">
          <div className="k">Pace</div>
          <div className="v num">
            {Math.round(left.pagesPerHour) || '—'}
            <small>pages/h</small>
          </div>
          <div className="sub">{wpm(words, ms) || '—'} wpm equivalent</div>
        </div>
        <div className="card">
          <div className="k">Left to read</div>
          <div className="v num">{left.pages}</div>
          <div className="sub">
            {left.ms != null ? `about ${formatDuration(left.ms, true)}` : 'pages'}
          </div>
        </div>
        <div className="card">
          <div className="k">Finishing</div>
          <div className="v num" style={{ fontSize: 22 }}>
            {left.finishAt
              ? new Date(left.finishAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })
              : '—'}
          </div>
          <div className="sub">
            {left.finishAt ? 'at your recent habit' : 'log a few sessions'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        {!timerRunning && (
          <button className="btn primary" onClick={onStart}>
            <IconTimer size={15} /> Start session
          </button>
        )}
        <button className="btn" onClick={() => setLogging((v) => !v)}>
          <IconPlus size={15} /> Log past session
        </button>
        {canScan && (
          <button className="btn" onClick={() => setScanning(true)}>
            <IconImage size={15} /> Scan my page
          </button>
        )}
        <button className="btn ghost" onClick={() => setEditing((v) => !v)}>
          Edit details
        </button>
      </div>

      {logging && (
        <ManualForm
          book={book}
          linkedBook={linkedBook}
          onCancel={() => setLogging(false)}
          onSubmit={(input) => {
            onLog(input);
            setLogging(false);
          }}
        />
      )}

      {editing && (
        <EditForm
          book={book}
          candidates={candidates}
          onLink={onLink}
          onSubmit={(patch) => {
            onUpdate(patch);
            setEditing(false);
          }}
        />
      )}

      {/* history */}
      {sessions.length > 0 && (
        <div className="panel" style={{ marginTop: 22 }}>
          <h3>
            Sessions <span>{sessions.length}</span>
          </h3>
          {sessions
            .slice()
            .sort((a, b) => b.start - a.start)
            .map((s) => (
              <div className="row" key={s.id ?? s.start}>
                <div>
                  <div className="label">
                    {new Date(s.start).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    · p. {s.fromPage}–{s.toPage}
                  </div>
                  <div className="hint">
                    {formatDuration(s.ms)} · {s.pages} pages ·{' '}
                    {wpm(s.words, s.ms) || '—'} wpm
                    {s.note ? ` · ${s.note}` : ''}
                  </div>
                </div>
                {s.id != null && (
                  <button
                    className="btn ghost"
                    style={{ height: 28, padding: '0 8px' }}
                    onClick={() => onRemoveSession(s.id as number)}
                    aria-label="Delete session"
                  >
                    <IconTrash size={14} />
                  </button>
                )}
              </div>
            ))}
        </div>
      )}

      <div style={{ marginTop: 22, textAlign: 'right' }}>
        {confirmRemove ? (
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Delete this book and its {sessions.length} sessions?
            </span>
            <button className="btn" onClick={onRemove}>
              Delete
            </button>
            <button className="btn ghost" onClick={() => setConfirmRemove(false)}>
              Keep
            </button>
          </span>
        ) : (
          <button className="btn ghost" onClick={() => setConfirmRemove(true)}>
            <IconTrash size={14} /> Remove from shelf
          </button>
        )}
      </div>
    </div>
  );
}

/* ── forms ────────────────────────────────────────────────────────── */

function ManualForm({
  book,
  linkedBook,
  onCancel,
  onSubmit,
}: {
  book: DeviceBookRecord;
  linkedBook: BookRecord | null;
  onCancel: () => void;
  onSubmit: (input: {
    start: number;
    ms: number;
    fromPage: number;
    toPage: number;
    toLocus?: Locus;
    note?: string;
  }) => void;
}) {
  const [when, setWhen] = useState(dateInput(Date.now() - 3_600_000));
  const [minutes, setMinutes] = useState('30');
  const [from, setFrom] = useState(String(book.currentPage || book.startPage));
  const [to, setTo] = useState('');
  const [locus, setLocus] = useState<Locus | null>(null);
  const [scanning, setScanning] = useState(false);

  const canScan = !!linkedBook && !linkedBook.fileMissing;
  const valid = Number(minutes) > 0 && Number(to) >= Number(from);

  if (scanning && linkedBook) {
    return (
      <div className="panel" style={{ marginTop: 16 }}>
        <ScanPanel
          open
          onClose={() => setScanning(false)}
          bookId={linkedBook.id}
          spine={linkedBook.spine}
          title={book.title}
          action="That's where I stopped"
          cancelLabel="Type the page number instead"
          describe={(l) =>
            `page ${percentToPage(book, l.percent)} · ${Math.round(l.percent * 100)}% through`
          }
          onLocated={(l) => {
            setLocus(l);
            setTo(String(percentToPage(book, l.percent)));
            setScanning(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3>Log a session you didn't time</h3>
      <div className="auth-form">
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
          <Field
            label="Started"
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.currentTarget.value)}
          />
          <Field
            label="Minutes read"
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.currentTarget.value.replace(/\D/g, ''))}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
          <Field
            label="From page"
            inputMode="numeric"
            value={from}
            onChange={(e) => setFrom(e.currentTarget.value.replace(/\D/g, ''))}
          />
          <Field
            label="To page"
            inputMode="numeric"
            value={to}
            onChange={(e) => {
              setLocus(null);
              setTo(e.currentTarget.value.replace(/\D/g, ''));
            }}
            hint={locus ? `Matched by scan · ${Math.round(locus.percent * 100)}% through` : undefined}
          />
        </div>
        {canScan && (
          <button
            className="btn ghost"
            style={{ justifyContent: 'center' }}
            onClick={() => setScanning(true)}
          >
            <IconImage size={15} /> {locus ? 'Scan again' : "Don't know the page? Scan it"}
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button
          className="btn primary"
          disabled={!valid}
          onClick={() =>
            onSubmit({
              start: new Date(when).getTime(),
              ms: Number(minutes) * 60_000,
              fromPage: Number(from),
              toPage: Number(to),
              toLocus: locus ?? undefined,
            })
          }
        >
          Save
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditForm({
  book,
  candidates,
  onLink,
  onSubmit,
}: {
  book: DeviceBookRecord;
  candidates: { id: string; label: string }[];
  onLink: (bookId: string | null) => void;
  onSubmit: (patch: Partial<DeviceBookRecord>) => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author);
  const [pages, setPages] = useState(String(book.pages));
  const [startPage, setStartPage] = useState(String(book.startPage));
  const [currentPage, setCurrentPage] = useState(String(book.currentPage));
  const [device, setDevice] = useState(book.device ?? '');

  /* The store refuses a combination that cannot exist — a start page past
     the end, a current page past the end — and quietly clamps it. Seed the
     boxes from the saved record whenever it changes, so what you are looking
     at is what the book actually says rather than what you typed at it. */
  useEffect(() => {
    setPages(String(book.pages));
    setStartPage(String(book.startPage));
    setCurrentPage(String(book.currentPage));
  }, [book.pages, book.startPage, book.currentPage]);

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3>Details</h3>
      <div className="auth-form">
        <Field label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        <Field
          label="Author"
          value={author}
          onChange={(e) => setAuthor(e.currentTarget.value)}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
          <Field
            label="Total pages"
            inputMode="numeric"
            value={pages}
            onChange={(e) => setPages(e.currentTarget.value.replace(/\D/g, ''))}
            hint="Correcting this recalculates every past session."
          />
          <Field
            label="Body starts on page"
            inputMode="numeric"
            value={startPage}
            onChange={(e) => setStartPage(e.currentTarget.value.replace(/\D/g, ''))}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
          <Field
            label="Currently on page"
            inputMode="numeric"
            value={currentPage}
            onChange={(e) => setCurrentPage(e.currentTarget.value.replace(/\D/g, ''))}
          />
          <Field
            label="Device"
            value={device}
            onChange={(e) => setDevice(e.currentTarget.value)}
          />
        </div>

        <label className="field">
          <span>Linked library book</span>
          <select
            value={book.bookId ?? ''}
            onChange={(e) => onLink(e.currentTarget.value || null)}
          >
            <option value="">Not linked</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        className="btn primary"
        style={{ marginTop: 14 }}
        onClick={() =>
          onSubmit({
            title: title.trim(),
            author: author.trim(),
            pages: Math.max(1, Number(pages) || book.pages),
            startPage: Math.max(1, Number(startPage) || 1),
            currentPage: Math.max(0, Number(currentPage) || 0),
            device: device.trim() || undefined,
          })
        }
      >
        Save details
      </button>
    </div>
  );
}
