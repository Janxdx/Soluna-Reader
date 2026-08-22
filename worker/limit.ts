/* Ceilings on how often the database can be asked for anything.

   ─── where this runs ────────────────────────────────────────────────

   Before the handlers, and — this is the point — before `requireUser`.
   Looking up a session is itself a D1 query joining two tables, so a gate
   placed after it would let every rejected request pay for the database
   read it was rejected for. The gate here reads a cookie and a header and
   nothing else; a caller who is over the line is turned away having cost
   one edge-local counter increment and no query at all.

   ─── what the counters are ──────────────────────────────────────────

   Cloudflare's rate limiting bindings, configured in wrangler.jsonc. The
   counters are cached on the machine the Worker is already running on, so
   `await limit()` is not a network round trip. That is why they are not in
   D1: a limiter that keeps its own counters in the database it protects
   adds queries to every request it inspects, so under a flood it makes the
   load worse in exact proportion to how hard it is being hit.

   One D1-backed limit remains, in auth.ts, on the magic-link endpoint. It
   is the exception that shows the rule — it needs a fifteen-minute window
   where these allow only ten or sixty seconds, and it has to hold across
   every Cloudflare location at once, because what it rations is mail
   arriving in somebody else's inbox rather than load arriving here.

   ─── keys ───────────────────────────────────────────────────────────

   Signed-in traffic is counted per session, signed-out traffic per address.
   Per session is the better key — Cloudflare's own guidance is to avoid
   addresses, since one can stand for a household, an office or an entire
   mobile carrier, and rationing it rations all of them together.

   But a key taken from the request is a key the caller chooses, and a
   script that invents a new cookie for every request would collect a new
   budget every time. So the per-session ceilings sit underneath one
   address-keyed ceiling that nothing can escape, set high enough that only
   a machine could reach it. Two different jobs: the session key divides the
   budget fairly between real users, the address key is what makes the
   division binding. */

import type { Env } from './env';
import { SESSION_COOKIE, readCookie, tooMany } from './http';

/** The caller's address, as Cloudflare sees it. */
export const clientIp = (req: Request): string =>
  req.headers.get('cf-connecting-ip') ?? 'unknown';

/* FNV-1a, twice over, for sixty-four bits of key.

   Not a security boundary — the session token is already a secret held in
   an HttpOnly cookie, and hashing it here only keeps it out of a counter
   key that some future diagnostic might print. What the hash has to do is
   not collide: two users sharing a bucket would ration each other. Sixty
   four bits makes that impossible to hit by accident at any number of
   readers this app will ever have.

   Synchronous on purpose. SHA-256 through crypto.subtle would be strictly
   better and also asynchronous, and this runs ahead of every request. */
function fold(input: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const hash = (input: string): string =>
  fold(input, 0x811c9dc5).toString(36) + fold(input, 0x7fffffff).toString(36);

/** Who to count this request against: the session if there is one, else the address. */
export function actorKey(req: Request): string {
  const token = readCookie(req, SESSION_COOKIE);
  /* Unverified deliberately — verifying costs a query, which is the cost
     this whole file exists to avoid paying before the decision. A forged
     cookie therefore buys a private budget, and RL_ADDRESS is what makes
     that worthless. */
  return token ? `s:${hash(token)}` : `a:${clientIp(req)}`;
}

/* ── the gate ──────────────────────────────────────────────────────── */

/** One ceiling. Fails open, loudly, if the binding is missing. */
async function check(binding: RateLimit | undefined, name: string, key: string): Promise<void> {
  if (!binding) {
    /* A deployment whose wrangler.jsonc predates these bindings should
       serve reading data rather than refuse every request — this is abuse
       defence, not authentication, and nothing behind it is unguarded:
       every endpoint still requires a session, and the mail path still has
       its own limit in D1. But it is a control that has silently stopped
       existing, so it says so every time rather than once. */
    console.warn(`rate limit binding ${name} is not configured — requests are ungated`);
    return;
  }
  const { success } = await binding.limit({ key });
  if (!success) throw tooMany();
}

/* Which ceiling applies to what. Everything under /api and /auth passes the
   address wall; most also pass the burst wall; the last depends on what the
   endpoint would go on to do. */
type Cost = 'read' | 'write' | 'auth' | 'fileRead' | 'fileWrite' | 'lookup';

function costOf(method: string, path: string): Cost | null {
  if (path.startsWith('/api/files/')) {
    return method === 'GET' ? 'fileRead' : 'fileWrite';
  }

  /* Catalogue lookups. The odd one out: everything else here rations our
     own database, and this rations Open Library's, Google's and
     Wikipedia's. A cache miss makes four outbound requests to services that
     are free and run on donations, so the ceiling is not about protecting
     this Worker — it is about not being the reason somebody else's service
     starts refusing us. Tight, because a whole shelf is a few dozen
     lookups once and nothing after that. */
  /* Method-independent on purpose: it is a POST, and it must stay counted
     as a lookup rather than falling through to the generic write ceiling
     below, which is sized for /api/push. */
  if (path === '/api/lookup') return 'lookup';
  /* Serving a stored cover is an R2 read like any other. */
  if (path.startsWith('/api/editions/')) return 'fileRead';

  /* The whole signed-out surface, including the two endpoints that are
     cheapest to call and most expensive to serve: /auth/request sweeps
     three tables before it does anything else, and /auth/callback spends a
     token and mints a session. */
  if (
    path === '/auth/request' ||
    path === '/auth/callback' ||
    path.startsWith('/auth/passkey/')
  ) {
    return 'auth';
  }

  if (path === '/api/push') return 'write';
  if (path === '/api/pull' || path === '/auth/me' || path === '/auth/passkeys') return 'read';

  /* Signing out is one delete by primary key, and passkey removal is
     another; both need a session first, so the walls already cover them.
     Counting them as reads keeps anything that reaches D1 accounted for. */
  if (method !== 'GET') return 'read';
  return null;
}

/**
 * Turn away anything asking too often, before it reaches the database.
 * Throws a 429; call it at the top of the router.
 */
export async function gate(env: Env, req: Request, path: string): Promise<void> {
  const actor = actorKey(req);
  const cost = costOf(req.method, path);

  /* Order matters: the broadest and cheapest ceiling first, so a flood is
     rejected at the first check rather than walking the whole ladder.

     Files are the exception to the burst wall. The client walks entire
     libraries in sequential loops — downloadAll(), and the upload and cover
     passes in syncFiles() — with nothing pacing them, so the honest length
     of a legitimate burst is however many books somebody owns. Ten seconds
     is the wrong window to judge that in, and a false 429 there does not
     look like a rate limit to the reader; it looks like sync is broken. So
     file traffic answers to its own per-minute ceilings and to RL_ADDRESS,
     which is still above it. */
  if (cost !== 'fileRead' && cost !== 'fileWrite') {
    await check(env.RL_BURST, 'RL_BURST', actor);
  }
  await check(env.RL_ADDRESS, 'RL_ADDRESS', clientIp(req));

  if (!cost) return;

  if (cost === 'lookup') return check(env.RL_LOOKUP, 'RL_LOOKUP', actor);
  if (cost === 'fileRead') return check(env.RL_FILES_READ, 'RL_FILES_READ', actor);
  if (cost === 'fileWrite') return check(env.RL_FILES_WRITE, 'RL_FILES_WRITE', actor);
  if (cost === 'write') return check(env.RL_WRITE, 'RL_WRITE', actor);
  /* Keyed by address rather than session: the point of this one is the
     caller who does not have a session yet and is trying to acquire one. */
  if (cost === 'auth') return check(env.RL_AUTH, 'RL_AUTH', clientIp(req));
  return check(env.RL_READ, 'RL_READ', actor);
}
