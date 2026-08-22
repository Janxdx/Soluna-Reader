import { useEffect, useRef, useState } from 'react';
import { useLibrary } from './store/library';
import { useAuth } from './store/auth';
import { resolveTheme, useSettings } from './store/settings';
import { initSync, useSync } from './sync/sync';
import { syncEnabled } from './sync/client';
import { useDevice } from './store/device';
import { useRatings } from './store/ratings';
import { useEditions } from './store/editions';
import { Library } from './ui/Library';
import { Stats } from './ui/Stats';
import { Account } from './ui/Account';
import { Device } from './ui/Device';
import { Impressum } from './ui/Impressum';
import { Ratings } from './ui/Ratings';
import { Reader } from './ui/Reader';
import { UpdateBanner } from './ui/UpdateBanner';
import { IconAccount, IconDevice, IconLibrary, IconShelf, IconStats } from './ui/Icons';

type Tab = 'library' | 'device' | 'shelf' | 'stats' | 'account';

const TABS: Tab[] = ['library', 'device', 'shelf', 'stats', 'account'];

/* Which tab the address bar is asking for.

   There is no router here and there does not need to be one — the tabs are
   state, not pages. But the magic-link callback has to land somewhere, and
   the Worker sends it to `#/account`, so the hash is read once at boot and
   kept in step afterwards. Anything unrecognised means the library, which
   is also what an empty hash means. */
function tabFromHash(): Tab {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0] as Tab;
  return TABS.includes(name) ? name : 'library';
}

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [reading, setReading] = useState<string | null>(null);
  const [showImpressum, setShowImpressum] = useState(false);
  const load = useLibrary((s) => s.load);
  const loading = useLibrary((s) => s.loading);
  const mode = useSettings((s) => s.mode);
  const signedIn = useAuth((s) => Boolean(s.user));
  const timerRunning = useDevice((s) => Boolean(s.timer?.runningSince));

  useEffect(() => {
    void load();
    void useRatings.getState().load();
    /* Cached editions, so a shelf that has already found its covers draws
       complete on the first frame instead of popping in. Nothing is
       fetched here — this only reads what is already on disk. */
    void useEditions.getState().load();
  }, [load]);

  /* The device shelf loads alongside the library, and every time the library
     changes size the matcher runs: importing an EPUB you have been reading
     on the e-reader should link the two without you asking. */
  useEffect(() => {
    void (async () => {
      await useDevice.getState().load();
      await useDevice.getState().autoLink();
    })();
    let count = useLibrary.getState().books.length;
    return useLibrary.subscribe((s) => {
      if (s.books.length === count) return;
      count = s.books.length;
      void useDevice.getState().autoLink();
    });
  }, []);

  /* Account and sync boot. Neither blocks the library from rendering: the
     session is restored in the background and a sync is kicked off once an
     account is known, so a cold start on the sofa still opens instantly. */
  useEffect(() => {
    if (!syncEnabled) return;
    useAuth.getState().init();
    initSync();
    void useSync.getState().init();
    return useAuth.subscribe((s, prev) => {
      if (s.user && s.user.id !== prev.user?.id) void useSync.getState().syncNow();
    });
  }, []);

  /* Keep the hash pointing at the tab you are on, so a reload puts you back
     where you were rather than in the library.

     Deliberately skipped on the first render. The hash arriving from the
     callback carries `?welcome=1`, and the account store reads that in an
     effect of its own to show "Signed in." — writing over it here would
     make whether the message appears depend on which effect happened to run
     first. */
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    history.replaceState(null, '', `${location.pathname}#/${tab}`);
  }, [tab]);

  /* Back and forward should move between tabs, not out of the app. */
  useEffect(() => {
    const onPop = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onPop);
    return () => window.removeEventListener('hashchange', onPop);
  }, []);

  /* theme follows the setting, and tracks the system when set to auto */
  useEffect(() => {
    const apply = () => {
      const theme = resolveTheme(mode);
      document.documentElement.dataset.theme = theme;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) {
        meta.setAttribute('content', theme === 'ink' ? '#0E0D0C' : theme === 'sepia' ? '#F3E9D8' : '#FAF7F2');
      }
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [mode]);

  return (
    <div className="app">
      {showImpressum ? (
        <Impressum onClose={() => setShowImpressum(false)} />
      ) : loading ? (
        <div style={{ flex: 1 }} />
      ) : tab === 'library' ? (
        <Library onOpen={setReading} />
      ) : tab === 'device' ? (
        <Device />
      ) : tab === 'shelf' ? (
        <Ratings />
      ) : tab === 'stats' ? (
        <Stats />
      ) : (
        <Account onImpressum={() => setShowImpressum(true)} />
      )}

      {!reading && !showImpressum && (
        <nav className="tabbar">
          <button
            className={tab === 'library' ? 'on' : ''}
            onClick={() => setTab('library')}
          >
            <IconLibrary size={18} /> Library
          </button>
          <button className={tab === 'device' ? 'on' : ''} onClick={() => setTab('device')}>
            <IconDevice size={18} /> Reader
            {timerRunning && <i className="dot live" aria-hidden />}
          </button>
          <button className={tab === 'shelf' ? 'on' : ''} onClick={() => setTab('shelf')}>
            <IconShelf size={18} /> Shelf
          </button>
          <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>
            <IconStats size={18} /> Statistics
          </button>
          <button
            className={tab === 'account' ? 'on' : ''}
            onClick={() => setTab('account')}
          >
            <IconAccount size={18} /> Account
            {syncEnabled && !signedIn && <i className="dot" aria-hidden />}
          </button>
        </nav>
      )}

      {reading && <Reader bookId={reading} onClose={() => setReading(null)} />}

      {/* Not while reading: the offer keeps until the book is closed, and a
          pill sliding up over a page is exactly the interruption the reader
          is built to avoid. */}
      {!reading && <UpdateBanner />}
    </div>
  );
}
