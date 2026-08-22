/* Bindings and configuration for the Soluna Worker.

   Everything here comes from wrangler.jsonc (bindings and vars) or from
   `wrangler secret put` (secrets). Nothing is read from a file at runtime —
   Workers have no filesystem. */

export interface Env {
  /* ── bindings ──────────────────────────────────────────────────── */

  /** the D1 database holding accounts and every reading row */
  DB: D1Database;
  /** object storage for EPUBs and cover images */
  BOOKS: R2Bucket;
  /** the built front-end, served for anything that isn't /api or /auth */
  ASSETS: Fetcher;

  /* Rate limiting, applied in worker/limit.ts ahead of every handler.
     Optional because a Worker deployed from a wrangler.jsonc that predates
     them should still serve books — see the note on failing open there. */

  /** short burst ceiling, per session */
  RL_BURST?: RateLimit;
  /** the same, per address — the one a forged cookie cannot escape */
  RL_ADDRESS?: RateLimit;
  /** sustained ceiling on reads that touch D1 */
  RL_READ?: RateLimit;
  /** sustained ceiling on /api/push, the write path */
  RL_WRITE?: RateLimit;
  /** the signed-out surface: passkeys, magic links */
  RL_AUTH?: RateLimit;
  /** EPUB and cover downloads from R2 — sized for syncing a whole library */
  RL_FILES_READ?: RateLimit;
  /** EPUB and cover uploads and deletes, the direction that costs storage */
  RL_FILES_WRITE?: RateLimit;
  /** catalogue lookups — the only endpoint that spends *somebody else's*
      quota, so it is the one where a loop in the client is a problem for
      a third party rather than for us */
  RL_LOOKUP?: RateLimit;

  /* ── vars ──────────────────────────────────────────────────────── */

  /** e.g. "https://readsoluna.com" — the canonical origin of the app */
  APP_ORIGIN: string;
  /** the address magic links are sent from, on a domain verified with Resend */
  MAIL_FROM: string;

  /* ── secrets ───────────────────────────────────────────────────── */

  /** Resend API key. Absent in local dev, where links are logged instead. */
  RESEND_API_KEY?: string;
  /** Google Books key. Optional — unkeyed requests work and are rationed by
      address, which is enough for one reader's shelf. Set it if lookups
      start coming back empty:  npx wrangler secret put GOOGLE_BOOKS_KEY */
  GOOGLE_BOOKS_KEY?: string;
}

/* ── WebAuthn identity ─────────────────────────────────────────────

   The relying party is the site a passkey belongs to, and the browser will
   refuse an assertion whose RP id doesn't match the page's domain. It has
   to be the registrable domain — "readsoluna.com", not a URL and not a
   path.

   Deriving it from APP_ORIGIN rather than configuring it separately removes
   the failure where the two drift apart and every sign-in fails with a
   browser error that names neither value. */

export const rpID = (env: Env): string => new URL(env.APP_ORIGIN).hostname;

export const rpName = 'Soluna';

/* ── lifetimes ─────────────────────────────────────────────────────

   A magic link is short because it sits in an inbox, which is exactly the
   place a stolen one would sit. A session is long because this is a reading
   app on a personal iPad: being signed out mid-book is a real cost, and
   there is nothing here worth a bank's timeout. */

export const LOGIN_TOKEN_TTL = 15 * 60_000;          // 15 minutes
export const CHALLENGE_TTL = 5 * 60_000;             // 5 minutes
export const SESSION_TTL = 180 * 24 * 60 * 60_000;   // 180 days
