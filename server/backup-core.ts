/*
 * 善款簿 backup server: the rules, shared by every place it runs.
 *
 *   server/backup-server.ts   on a computer of your own (the Raspberry Pi), keeping files on disk
 *   server/aws/lambda.ts      on AWS Lambda, keeping files in an S3 bucket
 *
 * Phones back up by themselves, with nothing to set up. The app makes a random device id the
 * first time it runs, and sends its records whenever they change. Anyone can send a backup, but
 * nobody can read one back without the key, so the records stay private.
 *
 *   PUT /backup/<device>          store a backup from one phone (no key; checked with model.ts)
 *   GET /backups                  the phones that have backed up, with counts      (key needed)
 *   GET /backups/<device>/latest  that phone's newest backup, to restore a phone   (key needed)
 *   GET /health                   {"ok":true}
 *
 * One more thing can be kept: a shared book, which is how a new phone gets mum's records without
 * the family's key ever reaching it. The family publishes a book under a setup code (32 random
 * hex digits) using the key. A phone that is given the code, in a link or typed in, can read that
 * one book and nothing else. The code is the only thing that opens it, so treat it like a
 * password. The stored copy is named by a hash of the code, never the code itself.
 *
 *   PUT /book/<code>              publish a book for phones to load                (key needed)
 *   GET /book/<code>              read it                (no key: the code is what opens it)
 *
 * And the public accounts: money totals of the funds the family chose to show, with no names
 * (see public-summary.ts). Only the summary is stored; the book sent to make it is not kept.
 *
 *   PUT /public                   { book, funds, year?, notice? } -> make and keep the summary (key needed)
 *   GET /public                   the summary, for anyone
 *
 * And the family's shared book: one book that the family's phones and computers all show and
 * change. A family member signs in with Google (auth.ts); only emails on the family list get in.
 * The book is kept as numbered versions, every one of them for good. A phone sends its changed
 * book saying which version it started from, and the write goes through only if that is still
 * the newest, so two phones writing at once can never lose each other's work: the second is
 * told to fetch the newer book, combine, and try again.
 *
 *   POST /session                 { credential, nonce } from Google sign-in -> a family session
 *   GET  /family                  the newest version: { version, book }      (session or key)
 *   GET  /family/after/<n>        the same, or { version, unchanged } if <n> is still the newest
 *   PUT  /family/after/<n>        write version <n>+1, if <n> is still the newest; else 409
 *
 * Every distinct version is kept and nothing is ever deleted. Because uploads need no key, they
 * are limited in size, and once the storage quota is reached new uploads are refused, so old
 * backups are never removed to make room.
 *
 * Where the files go is the `Store` below (store-disk.ts or aws/store-s3.ts).
 */
import crypto from 'node:crypto';
import L, { type State } from '../lib/model.ts';
import { publicSummary } from './public-summary.ts';
import { createSessions, googleKeys, SignInRefused, verifyGoogleToken, type KeySource } from './auth.ts';

/** Where the public summary is kept among the shared books. Book ids are 64 hex digits, so it can't clash. */
const PUBLIC_ID = 'public-summary';

/** Where backups are kept. */
export interface Store {
  /** The newest backup's text, or null. */
  getLatest(device: string): Promise<string | null>;
  /** Its size in bytes, or 0. */
  latestSize(device: string): Promise<number>;
  /** Bytes stored by all phones together. */
  usedBytes(): Promise<number>;
  /** Keep `text` as version `name`, and as the newest. */
  save(device: string, name: string, text: string): Promise<void>;
  list(): Promise<DeviceEntry[]>;
  /** The shared book kept under `id`, or null. */
  getBook(id: string): Promise<string | null>;
  /** Keep `text` as the shared book `id`, replacing the one before. */
  saveBook(id: string, text: string): Promise<void>;
  /** The number of the family book's newest version, or 0 if there is none yet. */
  familyHead(): Promise<number>;
  /** Version `n` of the family book, or null. */
  getFamily(n: number): Promise<string | null>;
  /** Keep `text` as version `n`, only if there is no version `n` yet. Says whether it was written. */
  putFamily(n: number, text: string): Promise<boolean>;
}

export interface DeviceEntry {
  device: string;
  lastBackup: string;
  versions: number;
}

/** One request, however it arrived. `headers` has lower-case names. */
export interface BackupRequest {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  /** Gives the body text; may refuse one over `maxBytes` by throwing httpError(413). */
  readBody(maxBytes: number): Promise<string>;
}

export interface BackupResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface BackupServiceOptions {
  /** The key for reading backups, 32+ characters. */
  token: string | undefined;
  store: Store;
  /** Sites the app runs on. */
  origins?: string[];
  /** One upload; a year of mum's book is about 100 KB. */
  maxBytes?: number;
  /** All backups together. */
  quotaBytes?: number;
  /** Return false to refuse an address that sends too often. */
  allowUpload?: (ip: string | undefined) => boolean;
  /** The Google sign-in client the app uses. Without it, and familyEmails, nobody can sign in. */
  googleClientId?: string;
  /** The Google accounts that may open and change the family's book. */
  familyEmails?: string[];
  /** Google's signing keys; the tests give their own. */
  googleKeySource?: KeySource;
  /** The family book in one piece. It is bigger than a phone's upload limit may allow. */
  maxFamilyBytes?: number;
  now?: () => number;
  log?: Logger;
}

export type HttpError = Error & { status: number };

/** What a route answers before the CORS and content-type headers are added. */
interface Answer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export const DEVICE = /^[0-9a-f]{32}$/;

const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s).digest();

/** A fingerprint of the records themselves, ignoring the backup-reminder counters. */
function contentHash(state: State): string {
  const { lastBackupAt, changesSinceBackup, ...settings } = state.settings;
  return sha256(JSON.stringify({ ...state, settings })).toString('hex');
}

export function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

const isHttpError = (e: unknown): e is HttpError => e instanceof Error && typeof (e as Partial<HttpError>).status === 'number';

export function createBackupService({
  token,
  store,
  origins = ['https://mum.franklee.asia'],
  maxBytes = 2 * 1024 * 1024,
  quotaBytes = 1024 * 1024 * 1024,
  allowUpload = () => true,
  googleClientId = '',
  familyEmails = [],
  googleKeySource,
  maxFamilyBytes = 5 * 1024 * 1024, // Lambda takes at most 6 MB in one request or answer
  now = Date.now,
  log = console,
}: BackupServiceOptions) {
  if (!token || token.length < 32) throw new Error('BACKUP_TOKEN must be at least 32 characters');
  const tokenHash = sha256(token);
  const allowed = new Set(origins);
  const family = new Set(familyEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const sessions = createSessions({ secret: token, now });
  const keys = googleKeySource || googleKeys(now);

  const latestHashes = new Map<string, string | null>(); // device -> hash of its latest backup, read from the store when first needed
  async function latestHashOf(device: string): Promise<string | null> {
    if (!latestHashes.has(device)) {
      let hash: string | null = null;
      const text = await store.getLatest(device);
      if (text != null) {
        try {
          hash = contentHash(L.normalizeState(JSON.parse(text)).state);
        } catch (_) { /* unreadable: treat as no backup yet */ }
      }
      latestHashes.set(device, hash);
    }
    return latestHashes.get(device) ?? null;
  }

  // Saves run one at a time, so two uploads can't interleave their writes or the quota count.
  let queue: Promise<unknown> = Promise.resolve();

  function authorized(header: string | string[] | undefined): boolean {
    const m = /^Bearer (.+)$/.exec(typeof header === 'string' ? header : '');
    return !!m && crypto.timingSafeEqual(sha256(m[1]), tokenHash);
  }

  const json = (status: number, body: unknown): Answer => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

  /** Read a body and check it is a 善款簿 backup with something in it. */
  async function readBook(readBody: BackupRequest['readBody'], what: string, limit = maxBytes) {
    const text = await readBody(limit);
    if (Buffer.byteLength(text) > limit) throw httpError(413, `${what} too large`);
    let parsed: ReturnType<typeof L.normalizeState>;
    try {
      parsed = L.normalizeState(JSON.parse(text));
    } catch (e) {
      throw httpError(400, 'not a 善款簿 backup');
    }
    if (!parsed.state.funds.length) throw httpError(422, 'an empty book is not stored');
    return { text, state: parsed.state, dropped: parsed.dropped };
  }

  async function putBackup(device: string, ip: string | undefined, readBody: BackupRequest['readBody']): Promise<Answer> {
    if (!allowUpload(ip)) throw httpError(429, 'too many uploads; try again later');
    const { text, state, dropped } = await readBook(readBody, 'backup');
    const saved = queue.then(async (): Promise<Answer> => {
      const hash = contentHash(state);
      if (hash === (await latestHashOf(device))) return json(200, { unchanged: true });
      const size = Buffer.byteLength(text);
      const growth = size + size - (await store.latestSize(device)); // a new version, and the newest copy replaced
      const usedBytes = await store.usedBytes();
      if (usedBytes + growth > quotaBytes) {
        log.error(`storage full: refused a backup from ${device.slice(0, 8)}… (${usedBytes} of ${quotaBytes} bytes used)`);
        return json(507, { error: 'backup storage is full' });
      }
      const name = `${new Date(now()).toISOString().replace(/:/g, '-')}-${hash.slice(0, 8)}.json`;
      await store.save(device, name, text);
      latestHashes.set(device, hash);
      log.log(`saved ${device.slice(0, 8)}…/${name}: ${state.funds.length} funds, ${state.members.length} people, ${state.receipts.length} receipts`);
      return json(201, { saved: name, dropped });
    });
    queue = saved.catch(() => {}); // a failed save must not stop the ones after it
    return saved;
  }

  /** Where a shared book is kept: never under the code itself, so a listing of the store opens nothing. */
  const bookId = (code: string): string => sha256('book:' + code).toString('hex');

  async function putBook(code: string, readBody: BackupRequest['readBody']): Promise<Answer> {
    const { text, state, dropped } = await readBook(readBody, 'book');
    // A book that would lose records on the way in is a mistake to fix, not something to publish.
    if (dropped) throw httpError(422, `${dropped} records in this book are not valid`);
    await store.saveBook(bookId(code), text);
    log.log(`published a shared book: ${state.funds.length} funds, ${state.members.length} people, ${state.receipts.length} receipts`);
    return json(201, { published: true, funds: state.funds.length, people: state.members.length, receipts: state.receipts.length, payouts: state.payouts.length, offerings: state.offerings.length });
  }

  /** Whether the caller may open the family book: the family key, or a session of someone still on the list. */
  function isFamily(header: string | string[] | undefined): boolean {
    if (authorized(header)) return true;
    const m = /^Bearer (.+)$/.exec(typeof header === 'string' ? header : '');
    const email = m ? sessions.read(m[1]) : null;
    return !!email && family.has(email);
  }

  async function signIn(readBody: BackupRequest['readBody']): Promise<Answer> {
    if (!googleClientId || !family.size) return json(503, { error: 'sign-in is not set up on this server' });
    let sent: { credential?: unknown; nonce?: unknown };
    try {
      sent = JSON.parse(await readBody(16 * 1024));
    } catch (_) {
      throw httpError(400, 'not JSON');
    }
    let email: string;
    try {
      email = await verifyGoogleToken(sent && sent.credential, sent && sent.nonce, { clientId: googleClientId, keys, now });
    } catch (e) {
      if (!(e instanceof SignInRefused)) throw e;
      log.log(`sign-in refused: ${e.message}`);
      return json(401, { error: 'sign-in not accepted', reason: e.message });
    }
    // A real Google account that is not family: it signed in fine, and still gets nothing.
    if (!family.has(email)) return json(403, { error: 'this Google account is not on the family list' });
    return json(200, sessions.issue(email));
  }

  /** The newest version of the family book as { version, book }, the book's text put in as it is. */
  async function getFamily(after: number | null): Promise<Answer> {
    const head = await store.familyHead();
    if (!head) return json(404, { error: 'no family book yet' });
    if (after === head) return json(200, { version: head, unchanged: true });
    const text = await store.getFamily(head);
    if (text == null) throw new Error(`family book version ${head} is listed but cannot be read`);
    return json(200, `{"version":${head},"book":${text}}`);
  }

  async function putFamily(base: number, readBody: BackupRequest['readBody']): Promise<Answer> {
    const { text, state, dropped } = await readBook(readBody, 'book', maxFamilyBytes);
    if (dropped) throw httpError(422, `${dropped} records in this book are not valid`);
    const written = queue.then(async (): Promise<Answer> => {
      const head = await store.familyHead();
      // Someone else wrote since this caller last looked: they must fetch that, combine, and send again.
      if (base !== head) return json(409, { error: 'the family book has a newer version', version: head });
      // The store writes version head+1 only if it does not exist, so a write from another copy of
      // this server at the same moment makes this one fail here and not overwrite it.
      if (!(await store.putFamily(head + 1, text))) return json(409, { error: 'the family book has a newer version', version: await store.familyHead() });
      log.log(`family book version ${head + 1}: ${state.funds.length} funds, ${state.members.length} people, ${state.receipts.length} receipts`);
      return json(201, { version: head + 1 });
    });
    queue = written.catch(() => {});
    return written;
  }

  async function listDevices(): Promise<Answer> {
    const devices = [];
    for (const d of await store.list()) {
      if (!DEVICE.test(d.device)) continue;
      let state: State;
      try {
        state = L.normalizeState(JSON.parse((await store.getLatest(d.device)) ?? '')).state;
      } catch (_) {
        continue;
      }
      devices.push({
        device: d.device,
        lastBackup: d.lastBackup,
        versions: d.versions,
        funds: state.funds.map((f) => f.name),
        people: state.members.length,
        receipts: state.receipts.length,
        payouts: state.payouts.length,
      });
    }
    devices.sort((a, b) => b.lastBackup.localeCompare(a.lastBackup));
    return json(200, { devices, usedBytes: await store.usedBytes(), quotaBytes });
  }

  async function route({ method, url, headers, ip, readBody }: BackupRequest): Promise<Answer> {
    let pathname: string;
    try {
      ({ pathname } = new URL(url ?? '/', 'http://localhost'));
    } catch (_) {
      // A request line like "GET //[" must not crash the server.
      return json(400, { error: 'bad request' });
    }
    if (method === 'OPTIONS') {
      return {
        status: 204,
        headers: { 'Access-Control-Allow-Methods': 'GET, PUT, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' },
        body: '',
      };
    }
    if (pathname === '/health') return method === 'GET' ? json(200, { ok: true }) : json(405, { error: 'method not allowed' });

    const upload = /^\/backup\/([^/]*)$/.exec(pathname);
    if (upload) {
      if (method !== 'PUT') return json(405, { error: 'method not allowed' });
      if (!DEVICE.test(upload[1])) return json(400, { error: 'bad device id' });
      return putBackup(upload[1], ip, readBody);
    }

    const shared = /^\/book\/([^/]*)$/.exec(pathname);
    if (shared) {
      if (method !== 'GET' && method !== 'PUT') return json(405, { error: 'method not allowed' });
      // Publishing needs the key. Checked before the code, so a caller without it learns nothing.
      if (method === 'PUT' && !authorized(headers.authorization)) return json(401, { error: 'wrong or missing key' });
      if (!DEVICE.test(shared[1])) return json(400, { error: 'bad setup code' });
      if (method === 'PUT') return putBook(shared[1], readBody);
      const text = await store.getBook(bookId(shared[1]));
      return text == null ? json(404, { error: 'no book under this code' }) : json(200, text);
    }

    if (pathname === '/session') return method === 'POST' ? signIn(readBody) : json(405, { error: 'method not allowed' });

    const familyPath = /^\/family(?:\/after\/(\d{1,9}))?$/.exec(pathname);
    if (familyPath) {
      if (method !== 'GET' && method !== 'PUT') return json(405, { error: 'method not allowed' });
      if (!isFamily(headers.authorization)) return json(401, { error: 'sign in with a family Google account' });
      const after = familyPath[1] === undefined ? null : Number(familyPath[1]);
      if (method === 'GET') return getFamily(after);
      if (after === null) return json(400, { error: 'say which version this book started from: PUT /family/after/<n>' });
      return putFamily(after, readBody);
    }

    if (pathname === '/public') {
      if (method === 'GET') {
        const text = await store.getBook(PUBLIC_ID);
        return text == null ? json(404, { error: 'nothing published yet' }) : json(200, text);
      }
      if (method !== 'PUT') return json(405, { error: 'method not allowed' });
      if (!authorized(headers.authorization)) return json(401, { error: 'wrong or missing key' });
      const body = await readBody(maxBytes);
      if (Buffer.byteLength(body) > maxBytes) throw httpError(413, 'too large');
      let request: unknown;
      try {
        request = JSON.parse(body);
      } catch (_) {
        throw httpError(400, 'not JSON');
      }
      const summary = publicSummary(request as Parameters<typeof publicSummary>[0], now());
      await store.saveBook(PUBLIC_ID, JSON.stringify(summary));
      log.log(`published the public accounts: ${summary.funds.length} funds`);
      return json(201, summary);
    }

    const one = /^\/backups\/([^/]*)\/latest$/.exec(pathname);
    if (pathname === '/backups' || one) {
      if (!authorized(headers.authorization)) return json(401, { error: 'wrong or missing key' });
      if (method !== 'GET') return json(405, { error: 'method not allowed' });
      if (!one) return listDevices();
      if (!DEVICE.test(one[1])) return json(400, { error: 'bad device id' });
      const text = await store.getLatest(one[1]);
      return text == null ? json(404, { error: 'no backup from this device' }) : json(200, text);
    }
    return json(404, { error: 'not found' });
  }

  /**
   * Answer one request. This is the only place that adds the CORS headers.
   */
  async function handle(req: BackupRequest): Promise<BackupResponse> {
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    let out: Answer | undefined;
    try {
      if (origin !== undefined) {
        // Browsers say which site is calling. Only the app's own site may; scripts send no Origin.
        if (typeof origin !== 'string' || !allowed.has(origin)) out = json(403, { error: 'origin not allowed' });
        else Object.assign(cors, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      }
      if (!out) out = await route(req);
    } catch (e) {
      if (isHttpError(e)) out = json(e.status, { error: e.message });
      else {
        log.error(e);
        out = json(500, { error: 'server error' });
      }
    }
    const base: Record<string, string> = out.status === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    return { status: out.status, headers: { ...base, ...cors, ...(out.headers || {}) }, body: out.body };
  }

  return { handle };
}

export type BackupService = ReturnType<typeof createBackupService>;
