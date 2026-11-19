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
 *   PUT /backup/<device>          store a backup from one phone (no key; checked with model.js)
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
 * Every distinct version is kept and nothing is ever deleted. Because uploads need no key, they
 * are limited in size, and once the storage quota is reached new uploads are refused, so old
 * backups are never removed to make room.
 *
 * Where the files go is the `Store` below (store-disk.ts or aws/store-s3.ts).
 */
import crypto from 'node:crypto';
import L from '../lib/model.js';

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
function contentHash(state: L.State): string {
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
  now = Date.now,
  log = console,
}: BackupServiceOptions) {
  if (!token || token.length < 32) throw new Error('BACKUP_TOKEN must be at least 32 characters');
  const tokenHash = sha256(token);
  const allowed = new Set(origins);

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
  async function readBook(readBody: BackupRequest['readBody'], what: string) {
    const text = await readBody(maxBytes);
    if (Buffer.byteLength(text) > maxBytes) throw httpError(413, `${what} too large`);
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

  async function listDevices(): Promise<Answer> {
    const devices = [];
    for (const d of await store.list()) {
      if (!DEVICE.test(d.device)) continue;
      let state: L.State;
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
        headers: { 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' },
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
