/* Finding your place by showing the app the page.

   The screen has one job and it is not "run OCR": it is to end with the
   reader believing the position it is about to set. So the order of things
   is deliberate.

   The scan field comes first, because on an iPad it is the whole feature —
   focus it, choose Scan Text, point at the page. The photo path is offered
   second and quietly, because it downloads a recogniser and reads the page
   less well. Both funnel into the same box of text, which stays visible and
   editable: OCR is fallible, and a reader who can see the forty words it
   captured can fix the one that went wrong instead of starting again.

   Matching runs as the text settles, not on a button, so the answer is
   already there by the time you look up. And when the match is merely
   probable the app does not show a percentage and hope — it shows the
   sentence from the book and asks whether that is where you stopped. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PassageMatch } from '../engine/passage';
import { MIN_TOKENS } from '../engine/passage';
import type { Locus } from '../engine/device';
import type { SpineEntry } from '../engine/types';
import {
  excerptFor,
  locate,
  openScan,
  scanLanguage,
  ScanUnavailable,
  type Scan,
} from '../scan/session';
import {
  DEFAULT_LANG,
  isNonDefault,
  liveTextLikely,
  recognizeImage,
  type ScanStage,
} from '../ocr/recognize';
import { Sheet } from './Sheet';
import { IconCheck, IconClose, IconImage } from './Icons';

/* Long enough that a photograph's worth of text lands in one go, short
   enough that a stray keystroke doesn't re-run the search. */
const SETTLE_MS = 450;

interface Props {
  /** false unmounts the state, so a reopened panel never holds an old page */
  open: boolean;
  /** dismiss — on a nested panel this means "back", not "close the sheet" */
  onClose: () => void;
  /** the library book whose text we search */
  bookId: string;
  spine: SpineEntry[];
  title: string;
  /** what the surrounding screen does with a confirmed position */
  onLocated: (locus: Locus, match: PassageMatch) => void | Promise<void>;
  /** wording for the confirm button, e.g. "Set page" or "Open here" */
  action?: string;
  /** how the caller will phrase the resulting position, shown beside the % */
  describe?: (locus: Locus) => string;
}

type Phase =
  | { k: 'idle' }
  | { k: 'preparing' }
  | { k: 'reading'; stage: ScanStage; progress: number }
  | { k: 'ready' }
  | { k: 'failed'; message: string };

/**
 * The panel on its own, for callers that already have a sheet open.
 *
 * Two of the three places this appears are reached from inside a sheet —
 * finishing a session, editing a tracked book — and stacking a second sheet
 * on top of the first would put two scrims and two drag handles on screen at
 * once. Swapping the contents of the sheet you are already in is both
 * calmer to look at and easier to get back out of.
 */
export function ScanPanel({
  open,
  onClose,
  bookId,
  spine,
  title,
  onLocated,
  action = 'Use this position',
  describe,
  cancelLabel = 'Cancel',
}: Props & { cancelLabel?: string }) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [match, setMatch] = useState<PassageMatch | null>(null);
  const [searched, setSearched] = useState(false);
  const [excerpt, setExcerpt] = useState<{ text: string; markAt: number } | null>(null);
  const [applying, setApplying] = useState(false);
  /* Which traineddata the photo path should load. Held in state rather than
     read at the moment of capture, because looking it up is a database round
     trip and the moment of capture is the one moment the reader is watching
     a spinner. */
  const [lang, setLang] = useState(DEFAULT_LANG);

  const scanRef = useRef<Scan | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const liveText = useMemo(liveTextLikely, []);

  /* Reset on every open. A sheet that reopens holding the previous page's
     text would, at best, confirm a position you already used. */
  useEffect(() => {
    if (!open) return;
    setText('');
    setMatch(null);
    setSearched(false);
    setExcerpt(null);
    setPhase({ k: 'idle' });
    scanRef.current = null;

    let cancelled = false;
    void scanLanguage(bookId).then((l) => {
      if (!cancelled) setLang(l);
    });
    return () => {
      cancelled = true;
    };
  }, [open, bookId]);

  /* On a device with Live Text the field *is* the feature, and the Scan Text
     button only exists once the keyboard is up. Opening the panel with the
     caret already in the box saves a tap that a reader who hasn't used this
     before has no particular reason to know they need to make. Elsewhere the
     field is the fallback path, so leave the keyboard alone. */
  useEffect(() => {
    if (!open || !liveText) return;
    const t = setTimeout(() => areaRef.current?.focus(), 260);
    return () => clearTimeout(t);
  }, [open, liveText]);

  const ensureScan = useCallback(async (): Promise<Scan> => {
    if (scanRef.current) return scanRef.current;
    const scan = await openScan(bookId, spine);
    scanRef.current = scan;
    return scan;
  }, [bookId, spine]);

  /* ── searching ──────────────────────────────────────────────────── */

  const words = useMemo(
    () => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length,
    [text]
  );
  const enough = words >= MIN_TOKENS;

  useEffect(() => {
    if (!open || !enough) {
      setMatch(null);
      setSearched(false);
      setExcerpt(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          /* Building the index is the slow step and it happens at most once
             per book. Saying "preparing" rather than showing a bare spinner
             matters: the first scan of a long novel is otherwise a second of
             unexplained stillness. */
          if (!scanRef.current) setPhase({ k: 'preparing' });
          const scan = await ensureScan();
          if (cancelled) return;

          const hit = locate(scan, text);
          setMatch(hit);
          setSearched(true);
          setPhase({ k: 'idle' });

          /* Only fetch the surrounding sentence when it will be shown. A
             confident match does not need defending. */
          if (hit && hit.confidence === 'review') {
            const around = await excerptFor(bookId, spine, hit);
            if (!cancelled) setExcerpt(around);
          } else {
            setExcerpt(null);
          }
        } catch (e) {
          if (cancelled) return;
          setPhase({
            k: 'failed',
            message:
              e instanceof ScanUnavailable
                ? e.message
                : 'Could not search this book. Try again.',
          });
        }
      })();
    }, SETTLE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, text, enough, ensureScan, bookId, spine]);

  /* ── the photo path ─────────────────────────────────────────────── */

  const onPhoto = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setPhase({ k: 'reading', stage: 'loading', progress: 0 });
    try {
      const read = await recognizeImage(file, {
        lang,
        onProgress: (stage, progress) => setPhase({ k: 'reading', stage, progress }),
      });
      setText(read.trim());
      setPhase(read.trim() ? { k: 'idle' } : { k: 'failed', message: 'No text found on that photo.' });
    } catch {
      setPhase({
        k: 'failed',
        message: 'Could not read that photo. More light and a straight-on angle help.',
      });
    } finally {
      /* The file input keeps a handle on the picture until it is cleared,
         and the point of this feature is that we do not keep the picture. */
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /* ── applying ───────────────────────────────────────────────────── */

  const apply = async (): Promise<void> => {
    if (!match) return;
    setApplying(true);
    try {
      await onLocated(match.locus, match);
      onClose();
    } finally {
      setApplying(false);
    }
  };

  if (!open) return null;

  const percent = match ? Math.round(match.locus.percent * 100) : 0;

  return (
    <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <div className="eyebrow">Find your place</div>
        <h2 className="display" style={{ fontSize: 26, marginTop: 6 }}>
          {title}
        </h2>
        <p className="muted" style={{ marginTop: 8, fontSize: 13.5, lineHeight: 1.5 }}>
          {liveText
            ? 'Tap the box, then choose Scan Text on the keyboard and point the camera at the last page you read. No photo is taken.'
            : 'Photograph the last page you read, or paste its text. The picture is read on this device and discarded — it is never saved or uploaded.'}
        </p>

        <label className="field" style={{ marginTop: 18 }}>
          <span>Text from the page</span>
          <textarea
            ref={areaRef}
            className="scan-area"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder={liveText ? 'Scan Text, or type a line or two…' : 'Paste or type the text…'}
            rows={5}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        <div className="scan-bar">
          <span className={`hint${enough ? ' good' : ''}`}>
            {words === 0
              ? `About ${MIN_TOKENS} words or more`
              : enough
                ? `${words} words — enough to search`
                : `${words} of ${MIN_TOKENS} words`}
          </span>

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => void onPhoto(e.currentTarget.files?.[0])}
          />
          <button
            className="btn ghost"
            onClick={() => fileRef.current?.click()}
            disabled={phase.k === 'reading'}
          >
            <IconImage size={15} /> {liveText ? 'Use a photo' : 'Take a photo'}
          </button>
        </div>

        {/* ── what the app makes of it ── */}

        {phase.k === 'reading' && (
          <div className="scan-note">
            {phase.stage === 'loading'
              ? isNonDefault(lang)
                ? 'Loading the text recogniser and this book\u2019s language…'
                : 'Loading the text recogniser (once per session)…'
              : `Reading the page… ${Math.round(phase.progress * 100)}%`}
          </div>
        )}

        {phase.k === 'preparing' && (
          <div className="scan-note">Preparing the book for searching…</div>
        )}

        {phase.k === 'failed' && <div className="auth-msg bad">{phase.message}</div>}

        {searched && !match && phase.k === 'idle' && (
          <div className="scan-note">
            No confident match. That can mean the words came out garbled, or
            that the page repeats text found elsewhere in the book — try a
            different page, or a fuller one. A photograph of both pages at
            once is read as two columns, so it is worth checking the text
            above reads in order.
          </div>
        )}

        {match && phase.k === 'idle' && (
          <div className={`scan-hit${match.confidence === 'sure' ? ' sure' : ''}`}>
            <div className="row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
              <div>
                <div className="label">
                  {match.confidence === 'sure' ? 'Found it' : 'Probably here'}
                </div>
                <div className="hint">
                  {describe ? describe(match.locus) : `${percent}% through the book`}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="label">Match</div>
                <div className="hint">
                  {Math.round(match.score * 100)}% of {match.tokens} words
                </div>
              </div>
            </div>

            {excerpt && (
              <blockquote className="scan-excerpt">
                {excerpt.text.split(/\s+/).map((w, i) => (
                  <span key={i} className={i === excerpt.markAt ? 'stop' : undefined}>
                    {w}{' '}
                  </span>
                ))}
              </blockquote>
            )}

            {match.confidence === 'review' && (
              <p className="hint" style={{ marginTop: 10 }}>
                Check that this is where you stopped before using it.
              </p>
            )}
          </div>
        )}

        <button
          className="auth-submit"
          style={{ marginTop: 18 }}
          disabled={!match || applying}
          onClick={() => void apply()}
        >
          <IconCheck size={16} /> {applying ? 'Saving…' : action}
        </button>

        <button className="btn ghost scan-cancel" onClick={onClose}>
          <IconClose size={15} /> {cancelLabel}
        </button>
    </div>
  );
}

/** The same panel as a sheet of its own, for callers starting from a screen. */
export function ScanSheet(props: Props) {
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <ScanPanel {...props} />
    </Sheet>
  );
}
