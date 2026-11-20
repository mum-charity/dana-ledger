/*
 * Who may open the family's book: signing in with Google, and the session that follows.
 *
 * The app sends the browser to Google, and Google sends it back with an ID token: a signed note
 * saying which Google account signed in. This file checks that note properly (Google's
 * signature, that it was made for this app, that it is not stale, that the email is verified),
 * and nothing is believed about the caller until every check has passed.
 *
 * A Google ID token lasts an hour, and mum should not have to sign in every hour, so after one
 * good token the server hands out its own session: the email and an expiry, signed with a key
 * only the server has. A session says who the caller is. Whether that person may open the book
 * is decided each time from the family list, so taking an email off the list locks it out at once.
 */
import crypto from 'node:crypto';

/** One of Google's public signing keys (a JSON Web Key). */
export interface GoogleKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}
/** Gives Google's current signing keys. `fresh` skips any copy kept from earlier. */
export type KeySource = (fresh?: boolean) => Promise<GoogleKey[]>;

export class SignInRefused extends Error {}
const refuse = (why: string): never => {
  throw new SignInRefused(why);
};

const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const HOUR = 60 * 60 * 1000;

/** Google's keys from Google, kept for an hour. Google changes them every few days. */
export function googleKeys(now: () => number = Date.now): KeySource {
  let kept: { keys: GoogleKey[]; at: number } | null = null;
  return async (fresh = false) => {
    if (kept && !fresh && now() - kept.at < HOUR) return kept.keys;
    const res = await fetch(GOOGLE_KEYS_URL);
    if (!res.ok) throw new Error(`Google's keys could not be fetched (${res.status})`);
    const body = (await res.json()) as { keys?: GoogleKey[] };
    kept = { keys: Array.isArray(body.keys) ? body.keys : [], at: now() };
    return kept.keys;
  };
}

const fromJson = (part: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : refuse('token is not readable');
  } catch (_) {
    return refuse('token is not readable');
  }
};

/**
 * Check a Google ID token and give the email it is for, in lower case.
 * Throws SignInRefused, with the reason, if any check fails.
 */
export async function verifyGoogleToken(token: unknown, nonce: unknown, { clientId, keys, now = Date.now }: { clientId: string; keys: KeySource; now?: () => number }): Promise<string> {
  if (typeof token !== 'string' || token.length > 8192) refuse('no token');
  const parts = (token as string).split('.');
  if (parts.length !== 3) refuse('token is not in three parts');
  const [head, body, signature] = parts;

  const header = fromJson(head);
  // Only the way Google signs is accepted. A token naming another way ("none", or a shared-secret
  // one) is refused before any key is looked at.
  if (header.alg !== 'RS256') refuse('token is not signed the way Google signs');
  const kid = typeof header.kid === 'string' ? header.kid : refuse('token names no key');
  let key = (await keys()).find((k) => k.kid === kid);
  if (!key) key = (await keys(true)).find((k) => k.kid === kid); // Google may have just changed keys
  if (!key || key.kty !== 'RSA') refuse('token is signed with a key Google does not have');

  let good = false;
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: 'RSA', n: key!.n, e: key!.e }, format: 'jwk' });
    good = crypto.verify('RSA-SHA256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url'));
  } catch (_) {
    good = false;
  }
  if (!good) refuse('signature is wrong');

  const claims = fromJson(body);
  const t = now();
  if (claims.aud !== clientId) refuse('token was made for another app');
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) refuse('token is not from Google');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= t) refuse('token has expired');
  if (typeof claims.iat === 'number' && claims.iat * 1000 > t + 5 * 60 * 1000) refuse('token is dated in the future');
  // The app made up `nonce` before sending the browser to Google, so a token from some other
  // sign-in, even a real one, does not fit.
  if (typeof nonce !== 'string' || nonce.length < 16 || claims.nonce !== nonce) refuse('token does not belong to this sign-in');
  if (claims.email_verified !== true) refuse('email is not verified');
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) refuse('token has no email');
  return (claims.email as string).trim().toLowerCase();
}

export interface Session {
  session: string;
  email: string;
  expiresAt: number;
}

/** Hands out and reads the server's own sessions. `secret` never leaves the server. */
export function createSessions({ secret, now = Date.now, days = 180 }: { secret: string; now?: () => number; days?: number }) {
  // A key of its own, so a session can never be mistaken for anything else signed with the secret.
  const key = crypto.createHmac('sha256', secret).update('善款簿 family session v1').digest();
  const sign = (payload: string) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  return {
    issue(email: string): Session {
      const expiresAt = now() + days * 24 * HOUR;
      const payload = Buffer.from(JSON.stringify({ e: email, x: expiresAt })).toString('base64url');
      return { session: `s1.${payload}.${sign(payload)}`, email, expiresAt };
    },
    /** The email a session is for, or null if it is forged, damaged or expired. */
    read(token: string): string | null {
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 's1') return null;
      const expected = Buffer.from(sign(parts[1]));
      const given = Buffer.from(parts[2]);
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
      try {
        const { e, x } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { e?: unknown; x?: unknown };
        return typeof e === 'string' && typeof x === 'number' && x > now() ? e : null;
      } catch (_) {
        return null;
      }
    },
  };
}
