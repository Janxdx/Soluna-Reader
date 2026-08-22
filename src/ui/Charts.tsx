/* Hand-drawn SVG charts.

   No chart library: these are simple enough to draw directly, and doing so
   keeps the visual language exactly consistent with the rest of the app
   (same accent, same corner radii, same restraint). */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { AXES, MOODS, moodColor, type AxisKey, type MoodShare } from '../engine/rating';
import { formatDuration, type DayBucket } from '../engine/stats';

/**
 * Minutes-per-day columns, with a day readable off any one of them.
 *
 * A bar chart of thirty days answers "which evenings" and refuses to answer
 * "how long on that evening" — the shape is the whole point, and printing
 * thirty numbers under it would destroy the shape to answer a question you
 * only ask about one day at a time. So the number is on demand: hover with
 * a pointer, hold with a finger.
 *
 * The hit target is one transparent strip laid over the SVG rather than the
 * `rect`s themselves. A bar for a day with no reading is one pixel tall and
 * a bar for a quiet day only slightly more, so hit-testing the drawing would
 * make exactly the days you most want to interrogate the ones you cannot
 * hit. The strip is full height and the day is resolved from where along it
 * you are, which is also what lets a finger drag across the month and read
 * every day in turn.
 *
 * `touch-action: pan-y` on the row is what keeps the page scrollable
 * through the chart: a vertical drag that starts on a bar scrolls, and the
 * browser tells us so by cancelling the pointer, which clears the readout.
 */
export function DailyBars({ days }: { days: DayBucket[] }) {
  const [active, setActive] = useState<number | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const max = Math.max(1, ...days.map((d) => d.ms));
  const w = 100 / days.length;

  /* Resolve from geometry, not from a per-cell handler: a finger dragged
     along the row keeps sending its moves to the cell it started on
     (implicit pointer capture on touch), so per-cell `onPointerEnter`
     would only ever fire once. */
  const at = useCallback(
    (clientX: number): number | null => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return null;
      const i = Math.floor(((clientX - rect.left) / rect.width) * days.length);
      return i >= 0 && i < days.length ? i : null;
    },
    [days.length]
  );

  const track = (e: ReactPointerEvent<HTMLDivElement>) => setActive(at(e.clientX));
  const clear = () => setActive(null);
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    // a mouse tracks on hover; a finger only once it is held down
    if (e.pointerType === 'mouse' || e.buttons > 0) track(e);
  };

  const shown = active !== null && active < days.length ? { i: active, day: days[active] } : null;

  return (
    <div className="daybars">
      {shown && (
        <div
          className="tip"
          style={{
            left: `${(shown.i + 0.5) * w}%`,
            // the two ends would otherwise hang off the panel
            transform: `translateX(${nudge(shown.i, days.length)})`,
          }}
        >
          <b>{shown.day.ms > 0 ? formatDuration(shown.day.ms, true) : 'no reading'}</b>
          <span>
            {shown.day.date.toLocaleDateString(undefined, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
            })}
          </span>
        </div>
      )}

      <svg className="spark" viewBox="0 0 100 34" preserveAspectRatio="none" role="img">
        {days.map((d, i) => {
          const h = (d.ms / max) * 30;
          const on = i === shown?.i;
          return (
            <rect
              key={d.key}
              x={i * w + w * 0.18}
              y={32 - h}
              width={w * 0.64}
              /* a day with no reading draws nothing — except while it is
                 the one being held, where a mark under the readout is
                 what says which day that is */
              height={Math.max(d.ms > 0 || on ? 1.2 : 0, h)}
              rx={Math.min(0.9, w * 0.3)}
              fill={on ? 'var(--ink)' : 'var(--accent)'}
              opacity={on ? 1 : d.ms > 0 ? 0.9 : 0.18}
            />
          );
        })}
        <line x1="0" y1="32.6" x2="100" y2="32.6" stroke="var(--line)" strokeWidth="0.4" />
      </svg>

      <div
        className="hits"
        ref={rowRef}
        onPointerDown={track}
        onPointerMove={onMove}
        onPointerUp={clear}
        onPointerCancel={clear}
        onPointerLeave={clear}
      />
    </div>
  );
}

/** Keep the readout inside the panel when the day is near either end. */
function nudge(i: number, count: number): string {
  if (i < count * 0.15) return '-14%';
  if (i > count * 0.85) return '-86%';
  return '-50%';
}

/** WPM over successive sessions. */
export function TrendLine({ values }: { values: number[] }) {
  if (values.length < 2) {
    return (
      <p className="muted" style={{ fontSize: 12.5, padding: '12px 0' }}>
        Read a couple more sessions and your pace trend will appear here.
      </p>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = 30 - ((v - min) / span) * 26;
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${line} L100 34 L0 34 Z`;
  return (
    <svg className="spark" viewBox="0 0 100 34" preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="trendfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#trendfill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.1"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Reading time by hour of day, as a 24-spoke radial. */
export function ClockDial({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  const cx = 50;
  const cy = 50;
  return (
    <svg viewBox="0 0 100 100" style={{ width: '100%', maxWidth: 210, display: 'block', margin: '0 auto' }} role="img">
      <circle cx={cx} cy={cy} r="19" fill="none" stroke="var(--line)" strokeWidth="0.6" />
      <circle cx={cx} cy={cy} r="42" fill="none" stroke="var(--line)" strokeWidth="0.6" />
      {hours.map((v, h) => {
        const angle = ((h / 24) * 360 - 90) * (Math.PI / 180);
        const inner = 19;
        const outer = 19 + (v / max) * 23;
        return (
          <line
            key={h}
            x1={cx + Math.cos(angle) * inner}
            y1={cy + Math.sin(angle) * inner}
            x2={cx + Math.cos(angle) * outer}
            y2={cy + Math.sin(angle) * outer}
            stroke="var(--accent)"
            strokeWidth="3.2"
            strokeLinecap="round"
            opacity={v > 0 ? 0.92 : 0.14}
          />
        );
      })}
      {['12a', '6a', '12p', '6p'].map((label, i) => {
        const angle = ((i / 4) * 360 - 90) * (Math.PI / 180);
        return (
          <text
            key={label}
            x={cx + Math.cos(angle) * 47.5}
            y={cy + Math.sin(angle) * 47.5 + 2}
            textAnchor="middle"
            fontSize="5"
            fill="var(--ink-3)"
            fontFamily="var(--font-ui)"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}

/* ── ratings ──────────────────────────────────────────────────────── */

/** Point on the pentagon for axis `i` at value 0–10, on a 100×100 canvas. */
function spoke(i: number, value: number, radius = 38): [number, number] {
  const angle = ((i / AXES.length) * 360 - 90) * (Math.PI / 180);
  const r = (Math.max(0, Math.min(10, value)) / 10) * radius;
  return [50 + Math.cos(angle) * r, 50 + Math.sin(angle) * r];
}

const polygon = (values: number[], radius?: number): string =>
  values.map((v, i) => spoke(i, v, radius).join(',')).join(' ');

/**
 * The five axes as a pentagon.
 *
 * An axis you never touched sits at the centre rather than being skipped,
 * which is the honest drawing: the shape says "this is a book I judged on
 * prose alone" instead of quietly inventing a regular pentagon out of two
 * numbers. `showLabels` is off inside the editor, where the sliders are
 * already labelled a few pixels away.
 */
export function Radar({
  values,
  size = 200,
  showLabels = true,
}: {
  values: Partial<Record<AxisKey, number>>;
  size?: number;
  showLabels?: boolean;
}) {
  const scores = AXES.map((a) => values[a.key] ?? 0);
  const judged = scores.filter((v) => v > 0).length;

  return (
    <svg
      viewBox="0 0 100 100"
      style={{ width: '100%', maxWidth: size, display: 'block', margin: '0 auto' }}
      role="img"
      aria-label="Ratings by axis"
    >
      {/* rings at 2, 4, 6, 8, 10 — a lattice to read heights against */}
      {[2, 4, 6, 8, 10].map((ring) => (
        <polygon
          key={ring}
          points={polygon(AXES.map(() => ring))}
          fill="none"
          stroke="var(--line)"
          strokeWidth={ring === 10 ? 0.7 : 0.45}
        />
      ))}
      {AXES.map((a, i) => {
        const [x, y] = spoke(i, 10);
        return <line key={a.key} x1="50" y1="50" x2={x} y2={y} stroke="var(--line)" strokeWidth="0.4" />;
      })}

      {judged > 0 && (
        <>
          <polygon points={polygon(scores)} fill="var(--accent)" fillOpacity="0.2" />
          <polygon
            points={polygon(scores)}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.1"
            strokeLinejoin="round"
          />
          {scores.map((v, i) =>
            v > 0 ? (
              <circle
                key={AXES[i].key}
                cx={spoke(i, v)[0]}
                cy={spoke(i, v)[1]}
                r="1.7"
                fill="var(--accent)"
              />
            ) : null
          )}
        </>
      )}

      {showLabels &&
        AXES.map((a, i) => {
          const [x, y] = spoke(i, 10, 47);
          return (
            <text
              key={a.key}
              x={x}
              y={y + 1.6}
              textAnchor={x > 56 ? 'start' : x < 44 ? 'end' : 'middle'}
              fontSize="4.6"
              fill="var(--ink-3)"
              fontFamily="var(--font-ui)"
            >
              {a.label}
            </text>
          );
        })}
    </svg>
  );
}

/**
 * How your scores are distributed, 0–10.
 *
 * The point of showing it at all is self-knowledge: almost everyone
 * discovers their curve is a spike at 8 with nothing below 6, which is what
 * makes the mean worth reporting next to it.
 */
export function ScoreCurve({ histogram, mean }: { histogram: number[]; mean: number }) {
  const peak = Math.max(1, ...histogram);
  const w = 100 / histogram.length;
  return (
    <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none" role="img">
      {histogram.map((count, score) => {
        const h = (count / peak) * 32;
        return (
          <rect
            key={score}
            x={score * w + w * 0.16}
            y={34 - h}
            width={w * 0.68}
            height={Math.max(count > 0 ? 1.4 : 0, h)}
            rx="1"
            fill="var(--accent)"
            opacity={count > 0 ? 0.35 + 0.6 * (count / peak) : 0.12}
          />
        );
      })}
      {/* where your average actually falls — usually a surprise */}
      <line
        x1={(mean / 10) * (100 - w) + w / 2}
        y1="1"
        x2={(mean / 10) * (100 - w) + w / 2}
        y2="34.5"
        stroke="var(--ink-2)"
        strokeWidth="0.7"
        strokeDasharray="2 1.6"
        vectorEffect="non-scaling-stroke"
      />
      <line x1="0" y1="34.6" x2="100" y2="34.6" stroke="var(--line)" strokeWidth="0.4" />
      {[0, 5, 10].map((s) => (
        <text
          key={s}
          x={(s / 10) * (100 - w) + w / 2}
          y="39.4"
          textAnchor="middle"
          fontSize="3.4"
          fill="var(--ink-3)"
          fontFamily="var(--font-ui)"
        >
          {s}
        </text>
      ))}
    </svg>
  );
}

/** The mood mix as one ribbon of cloth — the shelf's colour, averaged. */
export function MoodRibbon({ moods, dark }: { moods: MoodShare[]; dark: boolean }) {
  if (!moods.length) {
    return (
      <p className="muted" style={{ fontSize: 12.5, padding: '10px 0' }}>
        Give a few books a mood and the shelf finds its colour.
      </p>
    );
  }
  return (
    <div className="mood-ribbon" role="img" aria-label="Mood mix">
      {moods.map((m) => {
        const mood = MOODS.find((x) => x.key === m.mood) ?? null;
        return (
          <i
            key={m.mood}
            style={{ flexGrow: m.share, background: moodColor(mood, dark) }}
            title={`${mood?.label ?? m.mood} · ${Math.round(m.share * 100)}%`}
          />
        );
      })}
    </div>
  );
}

/** Progress ring, used for per-book completion. */
export function Ring({ value, size = 44 }: { value: number; size?: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 44 44">
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--line)" strokeWidth="3.4" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeDasharray={`${c * value} ${c}`}
        transform="rotate(-90 22 22)"
      />
    </svg>
  );
}
