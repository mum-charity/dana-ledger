#!/usr/bin/env node
/*
 * 善款簿 backup server: keeps a copy of the records off the phone.
 * It runs on the home Raspberry Pi behind a Cloudflare Tunnel. Node 18+, no packages.
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
 * are limited in size and in how often one internet address may send them, and once the disk
 * quota is reached new uploads are refused, so old backups are never removed to make room.
 *
 * Settings come from the environment (see server/dana-backup.env.example):
 *   BACKUP_TOKEN     required, 32+ characters: the key for reading backups ("Authorization: Bearer <key>")
 *   BACKUP_DIR       where backups are kept (default: ./data)
 *   ALLOWED_ORIGINS  comma-separated sites the app runs on (default: https://mum.franklee.asia)
 *   PORT, HOST       default 8787 on 127.0.0.1, so only the tunnel on the same Pi can reach it
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('../model.js');

const DEVICE = /^[0-9a-f]{32}$/;
const HOUR = 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/** A fingerprint of the records themselves, ignoring the backup-reminder counters. */
function contentHash(state) {
  const { lastBackupAt, changesSinceBackup, ...settings } = state.settings;
  return sha256(JSON.stringify({ ...state, settings })).toString('hex');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Read the request body, refusing anything over maxBytes. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > maxBytes) return reject(httpError(413, 'backup too large'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
    });
    req.on('end', () => (size > maxBytes ? reject(httpError(413, 'backup too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** Write a file so a crash or power cut leaves either the old file or the whole new one. */
async function writeFileDurably(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, file);
}

const fileSize = (file) => fs.promises.stat(file).then((s) => s.size, () => 0);

function createBackupServer({
  token,
  dir,
  origins = ['https://mum.franklee.asia'],
  maxBytes = 2 * 1024 * 1024, // one upload; a year of mum's book is about 100 KB
  quotaBytes = 1024 * 1024 * 1024, // all backups together
  uploadsPerHour = 120, // from one internet address
  now = Date.now,
}) {
  if (!token || token.length < 32) throw new Error('BACKUP_TOKEN must be at least 32 characters');
  const tokenHash = sha256(token);
  const allowed = new Set(origins);
  const devicesDir = path.join(dir, 'devices');
  fs.mkdirSync(devicesDir, { recursive: true });

  // Bytes already stored, so the quota holds across restarts.
  let usedBytes = 0;
  for (const d of fs.readdirSync(devicesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(devicesDir, d.name))) usedBytes += fs.statSync(path.join(devicesDir, d.name, f)).size;
  }

  const latestHashes = new Map(); // device -> hash of its latest backup, read from disk when first needed
  async function latestHashOf(device) {
    if (!latestHashes.has(device)) {
      let hash = null;
      try {
        hash = contentHash(L.normalizeState(JSON.parse(await fs.promises.readFile(path.join(devicesDir, device, 'latest.json'), 'utf8'))).state);
      } catch (_) { /* no backup yet */ }
      latestHashes.set(device, hash);
    }
    return latestHashes.get(device);
  }

  // Uploads per internet address in the current hour. cloudflared passes the phone's address in
  // CF-Connecting-IP; only cloudflared can reach this server, so the header can be trusted.
  const uploadCounts = new Map(); // ip -> { start, count }
  function allowUpload(ip) {
    const t = now();
    if (uploadCounts.size > 10000) for (const [k, v] of uploadCounts) if (t - v.start >= HOUR) uploadCounts.delete(k);
    let c = uploadCounts.get(ip);
    if (!c || t - c.start >= HOUR) uploadCounts.set(ip, (c = { start: t, count: 0 }));
    return ++c.count <= uploadsPerHour;
  }

  // Saves run one at a time, so two uploads can't interleave their writes or the quota count.
  let queue = Promise.resolve();

  function authorized(header) {
    const m = /^Bearer (.+)$/.exec(header || '');
    return !!m && crypto.timingSafeEqual(sha256(m[1]), tokenHash);
  }

  async function putBackup(req, res, device) {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    if (!allowUpload(ip)) throw httpError(429, 'too many uploads; try again later');
    const text = await readBody(req, maxBytes);
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
      if (hash === (await latestHashOf(device))) return { status: 200, body: { unchanged: true } };
      const deviceDir = path.join(devicesDir, device);
      const latestFile = path.join(deviceDir, 'latest.json');
      const size = Buffer.byteLength(text);
      const growth = size + size - (await fileSize(latestFile)); // a new version, and latest.json replaced
      if (usedBytes + growth > quotaBytes) {
        console.error(`storage full: refused a backup from ${device.slice(0, 8)}… (${usedBytes} of ${quotaBytes} bytes used)`);
        return { status: 507, body: { error: 'backup storage is full' } };
      }
      await fs.promises.mkdir(deviceDir, { recursive: true });
      const name = `${new Date(now()).toISOString().replace(/:/g, '-')}-${hash.slice(0, 8)}.json`;
      await writeFileDurably(path.join(deviceDir, name), text);
      await writeFileDurably(latestFile, text);
      usedBytes += growth;
      latestHashes.set(device, hash);
      console.log(`saved ${device.slice(0, 8)}…/${name}: ${state.funds.length} funds, ${state.members.length} people, ${state.receipts.length} receipts`);
      return { status: 201, body: { saved: name, dropped: parsed.dropped } };
    }).catch((e) => ({ error: e })));
    if (result.error) throw result.error;
    send(res, result.status, result.body);
  }

  async function listDevices(res) {
    const devices = [];
    for (const d of await fs.promises.readdir(devicesDir)) {
      if (!DEVICE.test(d)) continue;
      const deviceDir = path.join(devicesDir, d);
      let state;
      let stat;
      try {
        stat = await fs.promises.stat(path.join(deviceDir, 'latest.json'));
        state = L.normalizeState(JSON.parse(await fs.promises.readFile(path.join(deviceDir, 'latest.json'), 'utf8'))).state;
      } catch (_) {
        continue;
      }
      const versions = (await fs.promises.readdir(deviceDir)).filter((f) => f.endsWith('.json') && f !== 'latest.json').length;
      devices.push({
        device: d,
        lastBackup: stat.mtime.toISOString(),
        versions,
        funds: state.funds.map((f) => f.name),
        people: state.members.length,
        receipts: state.receipts.length,
        payouts: state.payouts.length,
      });
    }
    devices.sort((a, b) => b.lastBackup.localeCompare(a.lastBackup));
    send(res, 200, { devices, usedBytes, quotaBytes });
  }

  async function getLatest(res, device) {
    let text;
    try {
      text = await fs.promises.readFile(path.join(devicesDir, device, 'latest.json'), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return send(res, 404, { error: 'no backup from this device' });
      throw e;
    }
    send(res, 200, text);
  }

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      if (origin !== undefined) {
        // Browsers say which site is calling. Only the app's own site may; scripts send no Origin.
        if (!allowed.has(origin)) return send(res, 403, { error: 'origin not allowed' });
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      let pathname;
      try {
        ({ pathname } = new URL(req.url, 'http://localhost'));
      } catch (_) {
        // A request line like "GET //[" must not crash the server.
        return send(res, 400, { error: 'bad request' });
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, PUT',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        return res.end();
      }
      if (pathname === '/health') return req.method === 'GET' ? send(res, 200, { ok: true }) : send(res, 405, { error: 'method not allowed' });

      const upload = /^\/backup\/([^/]*)$/.exec(pathname);
      if (upload) {
        if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
        if (!DEVICE.test(upload[1])) return send(res, 400, { error: 'bad device id' });
        return await putBackup(req, res, upload[1]);
      }

      const one = /^\/backups\/([^/]*)\/latest$/.exec(pathname);
      if (pathname === '/backups' || one) {
        if (!authorized(req.headers.authorization)) return send(res, 401, { error: 'wrong or missing key' });
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        if (!one) return await listDevices(res);
        if (!DEVICE.test(one[1])) return send(res, 400, { error: 'bad device id' });
        return await getLatest(res, one[1]);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'server error' });
    }
  });
}

module.exports = { createBackupServer };

if (require.main === module) {
  const env = process.env;
  const server = createBackupServer({
    token: env.BACKUP_TOKEN,
    dir: path.resolve(env.BACKUP_DIR || path.join(__dirname, '..', 'data')),
    origins: (env.ALLOWED_ORIGINS || 'https://mum.franklee.asia').split(',').map((s) => s.trim()).filter(Boolean),
  });
  const port = Number(env.PORT) || 8787;
  const host = env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`善款簿 backup server on http://${host}:${port}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
