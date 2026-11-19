/*
 * 善款簿 backup server: the rules, shared by every place it runs.
 *
 *   server/backup-server.js   on a computer of your own (the Raspberry Pi), keeping files on disk
 *   server/aws/lambda.js      on AWS Lambda, keeping files in an S3 bucket
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
 * Every distinct version is kept and nothing is ever deleted. Because uploads need no key, they
 * are limited in size, and once the storage quota is reached new uploads are refused, so old
 * backups are never removed to make room.
 *
 * Where the files go is the `store` (store-disk.js or aws/store-s3.js):
 *   getLatest(device)             -> the newest backup's text, or null
 *   latestSize(device)            -> its size in bytes, or 0
 *   usedBytes()                   -> bytes stored by all phones together
 *   save(device, name, text)      -> keep `text` as version `name`, and as the newest
 *   list()                        -> [{ device, lastBackup, versions }]
 */
'use strict';
const crypto = require('crypto');
const L = require('../lib/model.js');

const DEVICE = /^[0-9a-f]{32}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** A fingerprint of the records themselves, ignoring the backup-reminder counters. */
function contentHash(state) {
  const { lastBackupAt, changesSinceBackup, ...settings } = state.settings;
  return sha256(JSON.stringify({ ...state, settings })).toString('hex');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createBackupService({
  token,
  store,
  origins = ['https://mum.franklee.asia'],
  maxBytes = 2 * 1024 * 1024, // one upload; a year of mum's book is about 100 KB
  quotaBytes = 1024 * 1024 * 1024, // all backups together
  allowUpload = () => true, // (ip) => false to refuse an address that sends too often
  now = Date.now,
  log = console,
}) {
  if (!token || token.length < 32) throw new Error('BACKUP_TOKEN must be at least 32 characters');
  const tokenHash = sha256(token);
  const allowed = new Set(origins);

  const latestHashes = new Map(); // device -> hash of its latest backup, read from the store when first needed
  async function latestHashOf(device) {
    if (!latestHashes.has(device)) {
      let hash = null;
      const text = await store.getLatest(device);
      if (text != null) {
        try {
          hash = contentHash(L.normalizeState(JSON.parse(text)).state);
        } catch (_) { /* unreadable: treat as no backup yet */ }
      }
      latestHashes.set(device, hash);
    }
    return latestHashes.get(device);
  }

  // Saves run one at a time, so two uploads can't interleave their writes or the quota count.
  let queue = Promise.resolve();

  function authorized(header) {
    const m = /^Bearer (.+)$/.exec(header || '');
    return !!m && crypto.timingSafeEqual(sha256(m[1]), tokenHash);
  }

  const json = (status, body) => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

  async function putBackup(device, ip, readBody) {
    if (!allowUpload(ip)) throw httpError(429, 'too many uploads; try again later');
    const text = await readBody(maxBytes);
    if (Buffer.byteLength(text) > maxBytes) throw httpError(413, 'backup too large');
    let parsed;
    try {
      parsed = L.normalizeState(JSON.parse(text));
    } catch (e) {
      throw httpError(400, 'not a 善款簿 backup');
    }
    const { state } = parsed;
    if (!state.funds.length) throw httpError(422, 'an empty book is not stored');
    const result = await (queue = queue.then(async () => {
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
      return json(201, { saved: name, dropped: parsed.dropped });
    }).catch((e) => ({ error: e })));
    if (result.error) throw result.error;
    return result;
  }

  async function listDevices() {
    const devices = [];
    for (const d of await store.list()) {
      if (!DEVICE.test(d.device)) continue;
      let state;
      try {
        state = L.normalizeState(JSON.parse(await store.getLatest(d.device))).state;
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

  async function route({ method, url, headers, ip, readBody }) {
    let pathname;
    try {
      ({ pathname } = new URL(url, 'http://localhost'));
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
   * Answer one request. `headers` has lower-case names; `readBody(maxBytes)` gives the body text.
   * Returns { status, headers, body }. This is the only place that adds the CORS headers.
   */
  async function handle(req) {
    const origin = req.headers.origin;
    const cors = {};
    let out;
    try {
      if (origin !== undefined) {
        // Browsers say which site is calling. Only the app's own site may; scripts send no Origin.
        if (!allowed.has(origin)) out = json(403, { error: 'origin not allowed' });
        else Object.assign(cors, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      }
      if (!out) out = await route(req);
    } catch (e) {
      if (e.status) out = json(e.status, { error: e.message });
      else {
        log.error(e);
        out = json(500, { error: 'server error' });
      }
    }
    const base = out.status === 204 ? {} : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    return { status: out.status, headers: { ...base, ...cors, ...(out.headers || {}) }, body: out.body };
  }

  return { handle };
}

module.exports = { createBackupService, httpError, DEVICE };
