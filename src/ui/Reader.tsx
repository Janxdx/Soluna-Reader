import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { db, type BookRecord } from '../db';
import { EpubZip } from '../engine/epub/zip';
import { sanitizeChapter } from '../engine/sanitize';
import { tokenizeInto } from '../engine/tokenize';
import { gutterFor, measure, pageOf, scrollToPage, type Geometry } from '../engine/paginate';
import { Pacer } from '../engine/pacer';
import { useSettings } from '../store/settings';
import { useLibrary } from '../store/library';
import { formatEta, readingPace, timeForWords } from '../engine/stats';
import { useSync } from '../sync/sync';
import { Sheet } from './Sheet';
import { ReaderSettings } from './ReaderSettings';
import {
  IconBack,
  IconList,
  IconMinus,
  IconPause,
  IconPlay,
  IconPlus,
  IconSliders,
} from './Icons';

const IDLE_MS = 90_000;
const HEARTBEAT_MS = 5_000;

export function Reader({ bookId, onClose }: { bookId: string; onClose: () => void }) {
  const settings = useSettings();
  // selectors, not the whole store: the reader must not re-render every time
  // a session is written back to the library
  const saveProgress = useLibrary((s) => s.saveProgress);
  const recordSession = useLibrary((s) => s.recordSession);

  const [book, setBook] = useState<BookRecord | null>(null);
  const [spineIndex, setSpineIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [toc, setToc] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [wordIndex, setWordIndex] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const zipRef = useRef<EpubZip | null>(null);
  const spansRef = useRef<HTMLElement[]>([]);
  const geoRef = useRef<Geometry | null>(null);
  const pageRef = useRef(0);
  const wordRef = useRef(0);
  const litRef = useRef(-1);
  const startWordRef = useRef(0);
  const landOnEndRef = useRef(false);
  const bookRef = useRef<BookRecord | null>(null);
  const spineRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  /* set by goChapter when a navigation is a jump (TOC, chapter scrubber)
     rather than a turn; consumed once the landing chapter finishes
     rendering, see the jumpRef check below */
  const jumpRef = useRef(false);
  /* goChapter needs to call flushSession, but flushSession is declared
     later in this component (it closes over the pacer). A ref sidesteps
     the ordering problem without hoisting ~150 lines of hooks around. */
  const flushSessionRef = useRef<() => void>(() => {});

  const sessionRef = useRef({
    start: Date.now(),
    activeMs: 0,
    pages: 0,
    startWords: 0,
    pacedMs: 0,
  });

  bookRef.current = book;
  spineRef.current = spineIndex;

  /* ── absolute position in the book, in words ─────────────────── */
  const globalWords = useCallback((si: number, wi: number): number => {
    const b = bookRef.current;
    if (!b) return 0;
    let before = 0;
    for (let i = 0; i < si; i++) before += b.spine[i].words;
    const chapterWords = b.spine[si]?.words ?? 0;
    const rendered = spansRef.current.length || chapterWords || 1;
    return before + Math.round((wi / rendered) * chapterWords);
  }, []);

  /* ── load the book ───────────────────────────────────────────── */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [record, progress] = await Promise.all([
        db.books.get(bookId),
        db.progress.get(bookId),
      ]);
      if (!record || !alive) return;

      /* The book may have arrived from another device as metadata only.
         Fetch the EPUB now — this is the moment the reader actually needs
         the bytes, and it keeps a fresh iPad from downloading a whole
         library before you can open anything. */
      let file = await db.files.get(bookId);
      if (!file) {
        setBook(record); // title in the bar while the download runs
        if (!(await useSync.getState().ensureFile(bookId))) {
          if (alive) setUnavailable(true);
          return;
        }
        file = await db.files.get(bookId);
      }
      if (!file || !alive) return;

      zipRef.current = await EpubZip.open(file.data);
      if (!alive) return;
      startWordRef.current = progress?.wordIndex ?? 0;
      bookRef.current = record;
      setBook(record);
      setSpineIndex(Math.min(progress?.spineIndex ?? 0, record.spine.length - 1));
      sessionRef.current = {
        start: Date.now(),
        activeMs: 0,
        pages: 0,
        startWords: 0,
        pacedMs: 0,
      };
      setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [bookId]);

  /* ── page navigation ─────────────────────────────────────────── */
  const goto = useCallback((target: number) => {
    const geo = geoRef.current;
    const el = columnsRef.current;
    if (!geo || !el) return;
    const p = Math.min(Math.max(0, target), geo.pages - 1);
    scrollToPage(el, p, geo);
    if (p !== pageRef.current) sessionRef.current.pages++;
    pageRef.current = p;
    setPage(p);
  }, []);

  /** first word span on a given page — binary search over document order */
  const firstWordOnPage = useCallback((target: number): number => {
    const spans = spansRef.current;
    const el = columnsRef.current;
    const geo = geoRef.current;
    if (!el || !geo || spans.length === 0) return 0;
    let lo = 0;
    let hi = spans.length - 1;
    let answer = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pageOf(spans[mid], el, geo) >= target) {
        answer = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return answer;
  }, []);

  const highlight = useCallback((index: number) => {
    const spans = spansRef.current;
    const previous = spans[litRef.current];
    if (previous) {
      previous.classList.remove('lit');
      previous.classList.add('said');
    }
    const current = spans[index];
    if (current) current.classList.add('lit');
    litRef.current = index;
  }, []);

  /* ── layout ──────────────────────────────────────────────────── */
  const relayout = useCallback(
    (targetWord: number, toEnd = false) => {
      const el = columnsRef.current;
      const vp = viewportRef.current;
      if (!el || !vp) return;

      const gap = Math.round(gutterFor(vp.clientWidth) * (0.5 + settings.margin));
      vp.style.paddingLeft = `${gap / 2}px`;
      vp.style.paddingRight = `${gap / 2}px`;
      el.style.fontSize = `${settings.fontSize}px`;
      el.style.lineHeight = String(settings.lineHeight);
      // reading clientWidth flushes the padding change before we size columns
      el.style.columnWidth = `${Math.max(160, el.clientWidth)}px`;
      el.style.columnGap = `${gap}px`;

      const geo = measure(el, gap);
      geoRef.current = geo;
      setPages(geo.pages);

      /* A word index can come from outside this render — a device sync
         computes one proportionally from a page number — so it may sit past
         the spans actually laid out. Clamp rather than fall back to page 0,
         which would silently throw away a restored position. */
      const spans = spansRef.current;
      const wanted = spans.length ? Math.min(targetWord, spans.length - 1) : targetWord;
      const span = spans[wanted];
      const target = toEnd ? geo.pages - 1 : span ? pageOf(span, el, geo) : 0;
      goto(target);
      const landed = toEnd ? firstWordOnPage(target) : wanted;
      wordRef.current = landed;
      setWordIndex(landed);
      highlight(landed);
    },
    [settings.margin, settings.fontSize, settings.lineHeight, goto, firstWordOnPage, highlight]
  );

  /* ── render the current chapter ──────────────────────────────── */
  useLayoutEffect(() => {
    if (!ready || !book || !zipRef.current) return;
    const el = columnsRef.current;
    if (!el) return;

    let chapter;
    try {
      chapter = sanitizeChapter(zipRef.current, book.spine[spineIndex].href);
    } catch {
      chapter = { html: '<p>This chapter could not be opened.</p>', objectUrls: [] };
    }

    el.innerHTML = chapter.html;
    tokenizeInto(el);
    spansRef.current = Array.from(el.querySelectorAll<HTMLElement>('.w'));
    litRef.current = -1;

    const start = Math.min(startWordRef.current, Math.max(0, spansRef.current.length - 1));
    const toEnd = landOnEndRef.current;
    startWordRef.current = 0;
    landOnEndRef.current = false;

    relayout(start, toEnd);
    if (jumpRef.current) {
      // land from a jump: count from here, not from where we jumped off
      sessionRef.current.startWords = globalWords(spineRef.current, wordRef.current);
      sessionRef.current.pages = 0;
      jumpRef.current = false;
    }
    pacer.load(
      spansRef.current.map((s) => s.textContent ?? ''),
      wordRef.current
    );

    // images arrive late and change the column count
    const images = Array.from(el.querySelectorAll('img'));
    let pending = images.filter((i) => !i.complete).length;
    const onLoad = () => {
      if (--pending <= 0) relayout(wordRef.current);
    };
    for (const img of images) {
      if (!img.complete) {
        img.addEventListener('load', onLoad, { once: true });
        img.addEventListener('error', onLoad, { once: true });
      }
    }

    return () => {
      for (const url of chapter.objectUrls) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, book, spineIndex]);

  /* ── typography changes reflow the chapter ───────────────────── */
  useLayoutEffect(() => {
    if (!ready) return;
    relayout(wordRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.fontSize, settings.lineHeight, settings.margin, settings.serif, settings.justify]);

  useEffect(() => {
    const onResize = () => relayout(wordRef.current);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [relayout]);

  /* ── chapter navigation ──────────────────────────────────────── */
  const goChapter = useCallback(
    (index: number, word = 0, toEnd = false, jump = false) => {
      const b = bookRef.current;
      if (!b) return false;
      if (index < 0 || index >= b.spine.length) return false;
      /* A jump — the TOC or the chapter scrubber, unlike turning pages —
         can leap over thousands of words in an instant, e.g. catching the
         app up after finishing a chapter somewhere else. Bank whatever was
         genuinely read up to now as its own session, then start the next
         one counting from the landing spot once it's rendered (see the
         jumpRef check in the chapter-render effect below). Otherwise the
         skipped words get credited as read in whatever few seconds the
         jump itself took — a session that "finishes" a chapter in no time. */
      if (jump && index !== spineRef.current) {
        flushSessionRef.current();
        jumpRef.current = true;
      }
      startWordRef.current = word;
      landOnEndRef.current = toEnd;
      setSpineIndex(index);
      return true;
    },
    []
  );

  const turn = useCallback(
    (delta: number) => {
      lastActivityRef.current = Date.now();
      const geo = geoRef.current;
      if (!geo) return;
      const next = pageRef.current + delta;
      if (next < 0) {
        goChapter(spineRef.current - 1, 0, true);
        return;
      }
      if (next >= geo.pages) {
        if (!goChapter(spineRef.current + 1)) pacer.pause();
        return;
      }
      goto(next);
      const landed = firstWordOnPage(next);
      wordRef.current = landed;
      setWordIndex(landed);
      if (!pacer.isRunning) highlight(landed);
      else pacer.seek(landed);
    },
    [goto, firstWordOnPage, goChapter, highlight]
  );

  /* ── pacer ───────────────────────────────────────────────────── */
  const pacer = useMemo(
    () =>
      new Pacer(
        (index) => {
          wordRef.current = index;
          lastActivityRef.current = Date.now();
          highlight(index);

          const el = columnsRef.current;
          const geo = geoRef.current;
          const span = spansRef.current[index];
          if (el && geo && span && useSettings.getState().autoTurn) {
            const p = pageOf(span, el, geo);
            if (p !== pageRef.current && p < geo.pages) goto(p);
          }
          if (index % 24 === 0) setWordIndex(index);
        },
        () => {
          // end of chapter: keep going into the next one
          setPlaying(false);
          const b = bookRef.current;
          if (b && spineRef.current < b.spine.length - 1) {
            startWordRef.current = 0;
            setSpineIndex(spineRef.current + 1);
            requestAnimationFrame(() => {
              pacer.play();
              setPlaying(true);
            });
          }
        }
      ),
    // built once per reader mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    pacer.setConfig(settings.pacer);
  }, [pacer, settings.pacer]);

  /** stop the pacer where it stands; returns false if it wasn't running */
  const stopPacer = useCallback(
    (revealChrome = false) => {
      lastActivityRef.current = Date.now();
      if (!pacer.isRunning) return false;
      pacer.pause();
      setPlaying(false);
      setWordIndex(pacer.position);
      highlight(pacer.position);
      if (revealChrome) setChrome(true);
      return true;
    },
    [pacer, highlight]
  );

  const togglePlay = useCallback(() => {
    lastActivityRef.current = Date.now();
    if (pacer.isRunning) {
      pacer.pause();
      setPlaying(false);
      setWordIndex(pacer.position);
    } else {
      pacer.seek(wordRef.current);
      pacer.play();
      setPlaying(true);
      setChrome(false);
    }
  }, [pacer]);

  useEffect(() => () => pacer.pause(), [pacer]);

  /* ── screen wake lock while pacing ───────────────────────────── */
  useEffect(() => {
    const want = playing && settings.keepAwake;
    const request = async () => {
      try {
        if (want && !wakeLockRef.current && 'wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          wakeLockRef.current.addEventListener('release', () => {
            wakeLockRef.current = null;
          });
        }
      } catch {
        /* denied — not fatal */
      }
    };
    if (want) void request();
    else {
      void wakeLockRef.current?.release();
      wakeLockRef.current = null;
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && want) void request();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [playing, settings.keepAwake]);

  /* ── session tracking ────────────────────────────────────────── */
  useEffect(() => {
    if (!ready) return;
    sessionRef.current.startWords = globalWords(spineRef.current, wordRef.current);
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivityRef.current < IDLE_MS) {
        sessionRef.current.activeMs += HEARTBEAT_MS;
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [ready, globalWords]);

  const flushSession = useCallback(() => {
    const s = sessionRef.current;
    const words = Math.max(0, globalWords(spineRef.current, wordRef.current) - s.startWords);
    void recordSession({
      bookId,
      start: s.start,
      end: Date.now(),
      ms: s.activeMs,
      words,
      pages: s.pages,
      pacedMs: Math.round(pacer.pacedMs),
    });
    s.start = Date.now();
    s.activeMs = 0;
    s.pages = 0;
    s.startWords = globalWords(spineRef.current, wordRef.current);
    pacer.pacedMs = 0;
  }, [bookId, globalWords, pacer, recordSession]);

  useEffect(() => {
    flushSessionRef.current = flushSession;
  }, [flushSession]);

  /* ── progress persistence ─────────────────────────────────────────
     `flushProgress` reads only refs, never render-time state, so it gives
     the exact same answer whether it fires from the debounce below or from
     an unmount/visibility handler that runs after this render has gone
     stale. That matters: closing the reader — tapping back, backgrounding
     the app, the iPad locking mid-chapter — used to race the 1.2s debounce.
     Turn a page, leave within that window, and the position write was
     simply dropped: not saved locally, so sync had nothing newer to send,
     and the *next* device to open the book landed wherever the last debounce
     happened to land, sometimes a chapter or two short. Every exit path now
     forces the same immediate write the debounce would have made anyway. */
  const flushProgress = useCallback(() => {
    const b = bookRef.current;
    if (!b) return;
    const total = b.totalWords || 1;
    void saveProgress({
      bookId,
      spineIndex: spineRef.current,
      wordIndex: wordRef.current,
      percent: Math.min(1, globalWords(spineRef.current, wordRef.current) / total),
      updatedAt: Date.now(),
    });
  }, [bookId, globalWords, saveProgress]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') {
        flushSession();
        flushProgress();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      flushSession();
      flushProgress();
    };
  }, [flushSession, flushProgress]);

  /* the debounced write during active reading — rate-limited so a fast
     swipe through several pages doesn't hit Dexie on every one */
  useEffect(() => {
    if (!ready || !book) return;
    const id = window.setTimeout(flushProgress, 1200);
    return () => window.clearTimeout(id);
  }, [ready, book, spineIndex, page, wordIndex, flushProgress]);

  /* ── input ───────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (toc || prefs) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') turn(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') turn(-1);
      else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, togglePlay, onClose, toc, prefs]);

  /**
   * Touches that land on the chrome (or anything interactive) belong to that
   * control, not to the page. On iOS the click is synthesized *after*
   * pointerup and re-hit-tests the DOM: if we hide the chrome here first, the
   * button is `pointer-events: none` by then and the click evaporates — the
   * bar just blinks out and nothing happens. Desktop dispatches the click from
   * the same gesture, which is why it only broke on iPad.
   */
  const isControl = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el?.closest) return false;
    // book content is never a control, even where it contains links
    if (el.closest('.columns')) return false;
    return !!el.closest('.chrome, .sheet, .scrim, button, input, select, textarea, a, label');
  };

  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent) => {
    if (isControl(e.target)) {
      swipeRef.current = null;
      return;
    }
    swipeRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerCancel = () => {
    swipeRef.current = null;
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || isControl(e.target)) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      turn(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || Date.now() - s.t > 500) return;

    // while the pacer is running, a tap anywhere on the page stops it — and
    // does nothing else, so it never doubles as a page turn
    if (stopPacer(true)) return;

    // Edge taps turn the page, the middle toggles the chrome. Resolved from
    // geometry rather than a click on the tap-zone divs — iOS does not
    // reliably synthesize click on plain, non-interactive elements.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width * 0.22) turn(-1);
    else if (x > rect.width * 0.78) turn(1);
    else setChrome((c) => !c);
  };

  /* ── derived display values ──────────────────────────────────── */
  const percent = book
    ? Math.min(1, globalWords(spineIndex, wordIndex) / (book.totalWords || 1))
    : 0;
  const chapterTitle =
    book?.toc.slice().reverse().find((t) => t.spineIndex >= 0 && t.spineIndex <= spineIndex)
      ?.label ?? `Chapter ${spineIndex + 1}`;

  /* ── how much longer ─────────────────────────────────────────────
     Two numbers, because they answer different questions: whether there is
     time for the rest of this chapter before bed, and how far off the end
     of the book is.

     The pace is measured, not the pacer's setting — the old estimate read
     off the WPM slider, so dragging it to 900 claimed you'd finish War and
     Peace tonight. It is sampled once per book rather than subscribed to,
     so a session being written back never re-renders the reader (the same
     reason `saveProgress` and `recordSession` are pulled out as selectors
     above). While the pacer *is* running it does set the tempo, so it wins
     for as long as it runs. */
  const measured = useMemo(() => readingPace(useLibrary.getState().sessions, bookId), [bookId]);
  const paceWpm = playing ? settings.pacer.wpm : measured.wpm;

  const wordsRead = book ? globalWords(spineIndex, wordIndex) : 0;
  const remainingWords = book ? Math.max(0, book.totalWords - wordsRead) : 0;
  /* `globalWords(spineIndex + 1, 0)` is the end of this chapter: the words
      of every chapter before the next one. Past the last chapter it is the
      whole book, which is the right answer there too. */
  const chapterWordsLeft = book ? Math.max(0, globalWords(spineIndex + 1, 0) - wordsRead) : 0;
  const bookLeft = formatEta(timeForWords(remainingWords, paceWpm));
  const chapterLeft = formatEta(timeForWords(chapterWordsLeft, paceWpm));
  const lastChapter = book ? spineIndex >= book.spine.length - 1 : false;

  const columnClass = [
    'columns',
    settings.serif ? '' : 'sans',
    settings.justify ? '' : 'ragged',
    settings.dim && playing ? 'dim' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const pad = Math.round(28 + settings.margin * 26);

  return (
    <div className="reader">
      <div
        className="page-area"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <div
          className="viewport"
          ref={viewportRef}
          style={{ paddingTop: pad, paddingBottom: pad + 14 }}
        >
          <div className={columnClass} ref={columnsRef} />
        </div>

        {/* the book exists in the library but its file is neither on this
            device nor reachable right now — say so instead of a blank page */}
        {unavailable && (
          <div className="reader-empty">
            <p className="display">Not downloaded</p>
            <p className="muted">
              This book lives in your account. Reconnect and open it again to
              download it.
            </p>
            <button className="btn" onClick={onClose}>
              Back to library
            </button>
          </div>
        )}

        {/* affordance only — the turn itself is resolved in onPointerUp */}
        <div className="tapzone l" />
        <div className="tapzone r" />

        {/* How much of this chapter is left, while you are reading it.
            The bottom chrome has carried this number all along, but the
            chrome is hidden for the whole of the act it describes — you
            hide it precisely in order to read — so the answer was only
            ever available to someone who had stopped. It sits in the
            outer corner, where a printed book keeps its folio, and stands
            down when the chrome comes up rather than saying the same
            thing twice a few pixels apart.

            `pointer-events: none` matters: it overlaps the right tap
            zone, and a countdown that swallowed page turns would be a bad
            trade for a number. */}
        {ready && !unavailable && (
          <div className={`chapter-left${chrome ? ' hidden' : ''}`} aria-hidden={chrome}>
            <b className="num">{chapterLeft}</b>
            <span>{lastChapter ? 'to the end' : 'left in chapter'}</span>
          </div>
        )}

        <div className={`chrome top${chrome ? '' : ' hidden'}`}>
          <button className="icon-btn" onClick={onClose} aria-label="Back to library">
            <IconBack />
          </button>
          <button className="icon-btn" onClick={() => setToc(true)} aria-label="Contents">
            <IconList />
          </button>
          <div className="title">{book?.meta.title ?? ''}</div>
          <button className="icon-btn" onClick={() => setPrefs(true)} aria-label="Settings">
            <IconSliders />
          </button>
        </div>

        <div className={`chrome bottom${chrome ? '' : ' hidden'}`}>
          <div className="pacer">
            <button className="play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Start pacer'}>
              {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
            </button>
            <button
              className="icon-btn"
              onClick={() =>
                settings.setPacer({ wpm: Math.max(80, settings.pacer.wpm - 25) })
              }
              aria-label="Slower"
            >
              <IconMinus size={17} />
            </button>
            <input
              type="range"
              min={80}
              max={900}
              step={5}
              value={settings.pacer.wpm}
              style={{ flex: 1 }}
              onChange={(e) => settings.setPacer({ wpm: Number(e.target.value) })}
            />
            <button
              className="icon-btn"
              onClick={() =>
                settings.setPacer({ wpm: Math.min(900, settings.pacer.wpm + 25) })
              }
              aria-label="Faster"
            >
              <IconPlus size={17} />
            </button>
            <div className="wpm">
              <b className="num">{settings.pacer.wpm}</b>
              <span>WPM</span>
            </div>
          </div>

          <div className="seek">
            <span className="num">{Math.round(percent * 100)}%</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, (book?.spine.length ?? 1) - 1)}
              step={1}
              value={spineIndex}
              onChange={(e) => goChapter(Number(e.target.value), 0, false, true)}
            />
            <span className="num" style={{ minWidth: 96, textAlign: 'right' }}>
              {page + 1}/{pages} · {bookLeft} left
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--ink-3)',
              marginTop: 6,
              textAlign: 'center',
            }}
          >
            {chapterTitle} · {chapterLeft} {lastChapter ? 'to the end' : 'to next chapter'}
          </div>
        </div>
      </div>

      <Sheet open={toc} onClose={() => setToc(false)} side>
        <div className="eyebrow" style={{ marginBottom: 14 }}>
          Contents
        </div>
        {book?.toc.map((entry, i) => (
          <button
            key={`${entry.href}-${i}`}
            className={`toc-item${entry.spineIndex === spineIndex ? ' on' : ''}`}
            style={{ paddingLeft: 12 + entry.depth * 14 }}
            onClick={() => {
              if (entry.spineIndex >= 0) {
                pacer.pause();
                setPlaying(false);
                goChapter(entry.spineIndex, 0, false, true);
              }
              setToc(false);
            }}
          >
            {entry.label}
          </button>
        ))}
      </Sheet>

      <Sheet open={prefs} onClose={() => setPrefs(false)}>
        <ReaderSettings />
      </Sheet>
    </div>
  );
}
