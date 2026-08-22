import { useMemo } from 'react';
import { useLibrary } from '../store/library';
import {
  byDay,
  byHour,
  dayKey,
  dayTotal,
  formatCount,
  formatDuration,
  lastDays,
  totals,
  wpm,
  wpmTrend,
} from '../engine/stats';
import { ClockDial, DailyBars, Ring, TrendLine } from './Charts';
import { IconFlame } from './Icons';

const HEATMAP_WEEKS = 26;

export function Stats() {
  const { sessions, books, progress } = useLibrary();

  const t = useMemo(() => totals(sessions), [sessions]);
  const today = useMemo(() => dayTotal(sessions), [sessions]);
  const days30 = useMemo(() => lastDays(sessions, 30), [sessions]);
  const hours = useMemo(() => byHour(sessions), [sessions]);
  const trend = useMemo(() => wpmTrend(sessions), [sessions]);

  const heat = useMemo(() => {
    const map = byDay(sessions);
    const cells: { key: string; ms: number }[] = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    // start on the Sunday that begins the window
    cursor.setDate(cursor.getDate() - (HEATMAP_WEEKS * 7 - 1) - cursor.getDay());
    for (let i = 0; i < HEATMAP_WEEKS * 7 + 7; i++) {
      const key = dayKey(cursor);
      cells.push({ key, ms: map.get(key)?.ms ?? 0 });
      cursor.setDate(cursor.getDate() + 1);
    }
    const peak = Math.max(1, ...cells.map((c) => c.ms));
    return { cells, peak };
  }, [sessions]);

  const perBook = useMemo(() => {
    const map: Record<string, { ms: number; words: number }> = {};
    for (const s of sessions) {
      const entry = map[s.bookId] ?? { ms: 0, words: 0 };
      entry.ms += s.ms;
      entry.words += s.words;
      map[s.bookId] = entry;
    }
    return books
      .map((b) => ({ book: b, ...(map[b.id] ?? { ms: 0, words: 0 }) }))
      .filter((r) => r.ms > 0)
      .sort((a, b) => b.ms - a.ms);
  }, [sessions, books]);

  const finished = books.filter((b) => b.finishedAt).length;
  const started = books.filter(
    (b) => (progress[b.id]?.percent ?? 0) > 0.01 && !b.finishedAt
  ).length;
  const peakHour = hours.indexOf(Math.max(...hours));
  const maxBookMs = Math.max(1, ...perBook.map((r) => r.ms));

  if (sessions.length === 0) {
    return (
      <div className="scroller">
        <div className="wrap">
          <div className="eyebrow">Statistics</div>
          <h1 className="display" style={{ marginTop: 6, marginBottom: 28 }}>
            Nothing measured yet
          </h1>
          <div className="empty">
            <p style={{ fontSize: 14 }}>
              Open a book and read for a minute. Everything on this page is
              computed from your sessions — pace, streaks, time of day, and where
              your hours actually went.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="scroller">
      <div className="wrap">
        <div className="eyebrow">Statistics</div>
        <h1 className="display" style={{ marginTop: 6, marginBottom: 28 }}>
          {formatDuration(t.ms, true)} of reading
        </h1>

        <div className="stat-grid">
          {/* first, because it is the only number that is still moving */}
          <div className="card">
            <div className="k">Today</div>
            <div className="v num">{formatDuration(today.ms)}</div>
            <div className="sub">
              {today.ms > 0
                ? `${formatCount(today.words)} words · ${today.sessions} ${
                    today.sessions === 1 ? 'session' : 'sessions'
                  }`
                : t.streak > 0
                ? `nothing yet · ${t.streak} ${t.streak === 1 ? 'day' : 'days'} on the line`
                : 'nothing yet today'}
            </div>
          </div>

          <div className="card">
            <div className="k">Current streak</div>
            <div className="v num" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {t.streak}
              {t.streak > 0 && <IconFlame size={22} className="muted" />}
            </div>
            <div className="sub">
              {t.streak === 1 ? 'day' : 'days'} · best {t.best}
            </div>
          </div>

          <div className="card">
            <div className="k">Average pace</div>
            <div className="v num">
              {t.avgWpm}
              <small>wpm</small>
            </div>
            <div className="sub">best session {t.bestWpm} wpm</div>
          </div>

          <div className="card">
            <div className="k">Words read</div>
            <div className="v num">{formatCount(t.words)}</div>
            <div className="sub">across {t.sessions} sessions</div>
          </div>

          <div className="card">
            <div className="k">Books</div>
            <div className="v num">{finished}</div>
            <div className="sub">
              finished · {started} in progress
            </div>
          </div>

          <div className="card">
            <div className="k">Typical session</div>
            <div className="v num">{formatDuration(t.avgSessionMs)}</div>
            <div className="sub">longest {formatDuration(t.longestSessionMs)}</div>
          </div>

          <div className="card">
            <div className="k">Paced reading</div>
            <div className="v num">
              {t.ms > 0 ? Math.round((t.pacedMs / t.ms) * 100) : 0}
              <small>%</small>
            </div>
            <div className="sub">of your time with the pacer on</div>
          </div>

          <div className="card">
            <div className="k">Days read</div>
            <div className="v num">{t.daysRead}</div>
            <div className="sub">
              {formatDuration(t.daysRead ? t.ms / t.daysRead : 0)} per reading day
            </div>
          </div>

          <div className="card">
            <div className="k">Pages turned</div>
            <div className="v num">{formatCount(t.pages)}</div>
            <div className="sub">peak hour {formatHour(peakHour)}</div>
          </div>
        </div>

        <div className="panel">
          <h3>
            Last 30 days <span>{formatDuration(days30.reduce((a, d) => a + d.ms, 0))}</span>
          </h3>
          <DailyBars days={days30} />
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: 'var(--ink-3)',
              marginTop: 6,
            }}
          >
            <span>{days30[0]?.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
            <span>hold a bar for its day</span>
            <span>today</span>
          </div>
        </div>

        <div className="panel">
          <h3>
            Reading history <span>last {HEATMAP_WEEKS} weeks</span>
          </h3>
          <div className="heatmap">
            {heat.cells.map((c) => (
              <i
                key={c.key}
                title={`${c.key} · ${formatDuration(c.ms)}`}
                style={
                  c.ms > 0
                    ? {
                        background: 'var(--accent)',
                        opacity: 0.22 + 0.78 * Math.sqrt(c.ms / heat.peak),
                      }
                    : undefined
                }
              />
            ))}
          </div>
          <div className="legend">
            less
            <i style={{ background: 'var(--line)' }} />
            <i style={{ background: 'var(--accent)', opacity: 0.35 }} />
            <i style={{ background: 'var(--accent)', opacity: 0.6 }} />
            <i style={{ background: 'var(--accent)', opacity: 1 }} />
            more
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
              Pace trend <span>per session</span>
            </h3>
            <TrendLine values={trend} />
            {trend.length >= 2 && (
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                {trend[trend.length - 1]} wpm most recently, {trend[0]} wpm when you
                started tracking.
              </p>
            )}
          </div>

          <div className="panel">
            <h3>
              When you read <span>{formatHour(peakHour)} is your hour</span>
            </h3>
            <ClockDial hours={hours} />
          </div>
        </div>

        <div className="panel">
          <h3>
            Where the time went <span>by book</span>
          </h3>
          {perBook.map((r) => (
            <div key={r.book.id} className="bar-row">
              <div className="n" title={r.book.meta.title}>
                {r.book.meta.title}
              </div>
              <div className="track">
                <i style={{ width: `${(r.ms / maxBookMs) * 100}%` }} />
              </div>
              <div className="v">{formatDuration(r.ms)}</div>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>
            Per book <span>progress and pace</span>
          </h3>
          <div
            style={{
              display: 'grid',
              gap: 'var(--s4)',
              gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
            }}
          >
            {perBook.map((r) => (
              <div key={r.book.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Ring value={progress[r.book.id]?.percent ?? 0} />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 560,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {r.book.meta.title}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    {Math.round((progress[r.book.id]?.percent ?? 0) * 100)}% ·{' '}
                    {wpm(r.words, r.ms) || '—'} wpm ·{' '}
                    {formatDuration(
                      estimateRemaining(
                        r.book.totalWords,
                        progress[r.book.id]?.percent ?? 0,
                        wpm(r.words, r.ms)
                      )
                    )}{' '}
                    left
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function estimateRemaining(totalWords: number, percent: number, pace: number): number {
  const remaining = totalWords * (1 - percent);
  return (remaining / Math.max(120, pace)) * 60_000;
}

function formatHour(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}
