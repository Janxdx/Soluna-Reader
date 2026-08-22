import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../store/auth';
import { useLibrary } from '../store/library';
import { useSync } from '../sync/sync';
import { syncEnabled } from '../sync/client';
import { formatCount, formatDuration, totals } from '../engine/stats';
import {
  IconAccount,
  IconCheck,
  IconCloud,
  IconDownload,
  IconExit,
  IconKey,
  IconSync,
} from './Icons';

const relative = (t: number | null): string => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function Account({ onImpressum }: { onImpressum: () => void }) {
  const { ready, user, init } = useAuth();

  useEffect(() => {
    init();
  }, [init]);

  if (!syncEnabled) return <NotConfigured onImpressum={onImpressum} />;
  if (!ready) return <div className="scroller" />;

  return user ? <SignedIn onImpressum={onImpressum} /> : <SignIn onImpressum={onImpressum} />;
}

/* ── signed out ──────────────────────────────────────────────────── */

/* One screen, shaped by what the backend can actually do rather than by a
   build-time flag: the Worker offers a magic link and a passkey, never a
   password. Rendering from capabilities means it never shows a control
   that would error — and leaves room for a future backend that does
   support passwords without this screen changing. */

function SignIn({ onImpressum }: { onImpressum: () => void }) {
  const {
    busy,
    error,
    notice,
    capabilities,
    passkeysUsable,
    signIn,
    signUp,
    resetPassword,
    requestLink,
    signInWithPasskey,
    clearMessages,
  } = useAuth();

  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const books = useLibrary((s) => s.books.length);
  const linkOnly = capabilities.magicLink && !capabilities.passwords;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (linkOnly) await requestLink(email);
    else if (mode === 'in') await signIn(email, password);
    else await signUp(email, password);
  };

  const emailOk = /\S+@\S+\.\S+/.test(email);
  const valid = linkOnly ? emailOk : emailOk && password.length >= 6;

  return (
    <div className="scroller">
      <div className="wrap auth">
        <div className="auth-mark">
          <IconCloud size={26} />
        </div>

        <h1 className="display">
          {linkOnly ? 'Your library, everywhere' : mode === 'in' ? 'Welcome back' : 'Keep your library'}
        </h1>
        <p className="auth-lede">
          {linkOnly
            ? 'Enter your email and we’ll send a link. No password to choose, forget, or have stolen.'
            : mode === 'in'
              ? 'Sign in to pick up exactly where you left off, on any device.'
              : 'An account syncs your books, your place in each one, and every statistic across your devices.'}
        </p>

        {/* Offered first, because on a device that already has a passkey it
            is the whole sign-in: one prompt, no typing, no inbox. */}
        {capabilities.passkeys && passkeysUsable && (
          <>
            <button
              className="btn primary auth-submit"
              disabled={busy}
              onClick={() => void signInWithPasskey()}
            >
              <IconKey size={16} />
              Sign in with a passkey
            </button>
            <div className="auth-or">
              <span>or</span>
            </div>
          </>
        )}

        <form className="auth-form" onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              placeholder="you@example.com"
              onChange={(e) => {
                setEmail(e.target.value);
                clearMessages();
              }}
            />
          </label>

          {capabilities.passwords && (
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                value={password}
                placeholder={mode === 'up' ? 'At least 6 characters' : '••••••••'}
                onChange={(e) => {
                  setPassword(e.target.value);
                  clearMessages();
                }}
              />
            </label>
          )}

          {error && <div className="auth-msg bad">{error}</div>}
          {notice && <div className="auth-msg good">{notice}</div>}

          <button className="btn primary auth-submit" disabled={!valid || busy}>
            {busy
              ? 'One moment…'
              : linkOnly
                ? 'Email me a link'
                : mode === 'in'
                  ? 'Sign in'
                  : 'Create account'}
          </button>
        </form>

        {capabilities.passwords && (
          <div className="auth-alt">
            {mode === 'in' ? (
              <>
                <button
                  className="linky"
                  onClick={() => {
                    setMode('up');
                    clearMessages();
                  }}
                >
                  Create an account
                </button>
                <button className="linky muted" onClick={() => void resetPassword(email)}>
                  Forgot password
                </button>
              </>
            ) : (
              <button
                className="linky"
                onClick={() => {
                  setMode('in');
                  clearMessages();
                }}
              >
                I already have an account
              </button>
            )}
          </div>
        )}

        {books > 0 && (
          <p className="auth-foot">
            The {books} {books === 1 ? 'book' : 'books'} already on this device will be
            uploaded once you sign in.
          </p>
        )}
        <p className="auth-foot">
          Reading works without an account. Nothing leaves this device until you sign in.
        </p>
        <button className="linky muted" onClick={onImpressum}>
          Impressum
        </button>
      </div>
    </div>
  );
}

/* ── signed in ───────────────────────────────────────────────────── */

function SignedIn({ onImpressum }: { onImpressum: () => void }) {
  const { status, step, error, lastSyncedAt, pendingUploads, missingFiles, syncNow, downloadAll, init, forget } =
    useSync();
  const { books, sessions } = useLibrary();
  const {
    user,
    busy,
    notice,
    error: authError,
    capabilities,
    passkeysUsable,
    loadPasskeys,
    resendConfirmation,
    recheck,
    signOut,
  } = useAuth();
  const [confirming, setConfirming] = useState(false);

  const email = user?.email ?? '';
  const verified = user?.verified ?? true;

  useEffect(() => {
    void init();
    void syncNow();
    void loadPasskeys();
  }, [init, syncNow, loadPasskeys]);

  const t = useMemo(() => totals(sessions), [sessions]);
  const initial = email.trim().charAt(0).toUpperCase() || '?';

  const label =
    status === 'syncing'
      ? (step ?? 'Syncing…')
      : status === 'unverified'
        ? 'Sync paused — email not confirmed'
        : status === 'offline'
          ? 'Offline — will sync when you reconnect'
          : status === 'error'
            ? (error ?? 'Sync failed')
            : `Last synced ${relative(lastSyncedAt)}`;

  return (
    <div className="scroller">
      <div className="wrap">
        <div className="eyebrow">Account</div>

        {!verified && (
          <div className="panel warn">
            <div className="row">
              <div>
                <div className="label">Confirm your email</div>
                <div className="hint">
                  Your library keeps working on this iPad. Syncing to other
                  devices starts once you open the link sent to {email}.
                </div>
                {notice && <div className="hint good">{notice}</div>}
                {authError && <div className="hint bad">{authError}</div>}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" disabled={busy} onClick={() => void recheck()}>
                  I've confirmed
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void resendConfirmation()}
                >
                  Resend
                </button>
              </div>
            </div>
          </div>
        )}

        {verified && (notice || authError) && (
          <div className={`auth-msg ${authError ? 'bad' : 'good'} acct-msg`}>
            {authError ?? notice}
          </div>
        )}

        <div className="acct-head">
          <div className="avatar">{initial}</div>
          <div className="acct-id">
            <div className="acct-email">{email}</div>
            <div className={`acct-status ${status}`}>
              {status === 'syncing' ? (
                <IconSync size={14} className="spin" />
              ) : status === 'idle' ? (
                <IconCheck size={14} />
              ) : (
                <IconCloud size={14} />
              )}
              <span>{label}</span>
            </div>
          </div>
        </div>

        <div className="stat-grid">
          <div className="card">
            <div className="k">Synced books</div>
            <div className="v num">{books.length}</div>
            {pendingUploads > 0 && (
              <div className="sub">{pendingUploads} still uploading</div>
            )}
          </div>
          <div className="card">
            <div className="k">Sessions</div>
            <div className="v num">{formatCount(sessions.length)}</div>
          </div>
          <div className="card">
            <div className="k">Time read</div>
            <div className="v num">{formatDuration(t.ms)}</div>
          </div>
        </div>

        <div className="panel">
          <div className="row">
            <div>
              <div className="label">Sync now</div>
              <div className="hint">
                {verified
                  ? 'Progress, statistics, bookmarks and settings, both ways.'
                  : 'Available once your email is confirmed.'}
              </div>
            </div>
            <button
              className="btn"
              disabled={status === 'syncing' || !verified}
              onClick={() => void syncNow()}
            >
              <IconSync size={16} className={status === 'syncing' ? 'spin' : undefined} />
              {status === 'syncing' ? 'Syncing' : 'Sync'}
            </button>
          </div>

          <div className="row">
            <div>
              <div className="label">Books on this device</div>
              <div className="hint">
                {missingFiles === 0
                  ? 'Every book in your library is downloaded.'
                  : `${missingFiles} ${missingFiles === 1 ? 'book is' : 'books are'} in the cloud only — they download when you open them.`}
              </div>
            </div>
            <button
              className="btn"
              disabled={missingFiles === 0 || status === 'syncing'}
              onClick={() => void downloadAll()}
            >
              <IconDownload size={16} />
              Download all
            </button>
          </div>

          <div className="row">
            <div>
              <div className="label">Sign out</div>
              <div className="hint">
                Your books stay on this device. Sync stops until you sign back in.
              </div>
            </div>
            {confirming ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      await syncNow();
                      await forget();
                      await signOut();
                    })();
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button className="btn" onClick={() => setConfirming(true)}>
                <IconExit size={16} />
                Sign out
              </button>
            )}
          </div>
        </div>

        {capabilities.passkeys && passkeysUsable && <Passkeys />}

        {status === 'error' && error && <div className="auth-msg bad">{error}</div>}

        <button className="linky muted" onClick={onImpressum} style={{ marginTop: 'var(--s4)' }}>
          Impressum
        </button>

        <BuildStamp />
      </div>
    </div>
  );
}

/* When this copy of the app was built.
 *
 * The offline shell never activates a new build without being asked — that
 * is deliberate, so that a worker cannot seize a page whose lazy chunks it
 * has just deleted. The cost is that a device can sit several builds behind
 * while every deploy looks perfectly successful from the outside, and a
 * client-side fix that has simply not arrived is indistinguishable from one
 * that does not work. This is the line that tells the two apart. */
function BuildStamp() {
  const built = new Date(__BUILT_AT__);
  const stamp = Number.isNaN(built.getTime())
    ? __BUILT_AT__
    : built.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <p className="muted" style={{ fontSize: 11, marginTop: 'var(--s4)', opacity: 0.7 }}>
      Build {stamp}
    </p>
  );
}

/* ── passkeys ────────────────────────────────────────────────────────

   Registering one here is what turns the next sign-in from an email round
   trip into a glance at the camera. Kept as its own panel because it is
   about this *device*, not about the account: the list is every device that
   can currently get in, which is also the list you revoke from when one of
   them is no longer yours. */

function Passkeys() {
  const { passkeys, busy, addPasskey, removePasskey } = useAuth();

  /* A default worth having: without a name, a list of three passkeys is
     three identical rows and the revoke button becomes a guess. */
  const suggested = useMemo(() => deviceName(), []);

  return (
    <div className="panel">
      <h3>
        Passkeys
        <span>{passkeys.length || ''}</span>
      </h3>

      {passkeys.length === 0 ? (
        <p className="hint" style={{ marginBottom: 'var(--s4)' }}>
          Add one and this device signs in with Face ID — no link, no inbox, nothing
          to type. It stays in your keychain and never reaches the server.
        </p>
      ) : (
        <ul className="key-list">
          {passkeys.map((k) => (
            <li key={k.id}>
              <div>
                <div className="label">{k.label || 'Unnamed device'}</div>
                <div className="hint">
                  Added {new Date(k.createdAt).toLocaleDateString()}
                  {k.lastUsedAt
                    ? ` · last used ${relative(k.lastUsedAt)}`
                    : ' · not used yet'}
                </div>
              </div>
              <button
                className="linky muted"
                disabled={busy}
                onClick={() => void removePasskey(k.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        className="btn"
        disabled={busy}
        onClick={() => void addPasskey(suggested)}
      >
        <IconKey size={16} />
        Add a passkey for this device
      </button>
    </div>
  );
}

/* A readable guess at what this device is, from the only clue available.
   Wrong occasionally, editable never — but "iPad" beside a date is enough
   to tell three entries apart, which is all the label is for. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}

/* ── no backend configured ───────────────────────────────────────── */

function NotConfigured({ onImpressum }: { onImpressum: () => void }) {
  return (
    <div className="scroller">
      <div className="wrap auth">
        <div className="auth-mark">
          <IconAccount size={26} />
        </div>
        <h1 className="display">Sync is switched off</h1>
        <p className="auth-lede">
          Soluna is running without a backend, so everything stays on this device.
          Remove <code>VITE_BACKEND=none</code> from your environment to use
          Soluna's own Worker — same origin, nothing else to configure — and
          accounts appear here.
        </p>
        <button className="linky muted" onClick={onImpressum}>
          Impressum
        </button>
      </div>
    </div>
  );
}
