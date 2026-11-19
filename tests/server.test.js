// Tests for the backup server (server/). The same checks run against both places it can keep
// backups: files on disk (the Raspberry Pi) and an S3 bucket (AWS), using a stand-in for S3.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const L = require('../lib/model.js');
const { createBackupService } = require('../server/backup-core.js');
const { createDiskStore } = require('../server/store-disk.js');
const { createS3Store } = require('../server/aws/store-s3.js');
const { createHandler } = require('../server/aws/lambda.js');
const { createBackupServer } = require('../server/backup-server.js');

const TOKEN = 'k'.repeat(40);
const ORIGIN = 'https://mum.franklee.asia';
const DEVICE = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

/** A backup of a small book. `receipts` changes the records, so each count is a new version. */
const books = new Map(); // made once each, because every new book gets new random ids
function book(receipts = 0) {
  if (!books.has(receipts)) books.set(receipts, makeBook(receipts));
  return books.get(receipts);
}
function makeBook(receipts) {
  const s = L.emptyState();
  const fund = L.addFund(s, { name: 'Bhante 医疗费用', opening: 5000 });
  const m = L.addMember(s, { fundId: fund.id, name: '陈美玲', pledge: 1000, startMonth: '2026-01' });
  for (let i = 0; i < receipts; i++) L.setReceipt(s, { memberId: m.id, month: `2026-0${i + 1}`, amount: 1000, date: `2026-0${i + 1}-05` });
  return L.backupJSON(s);
}

/** Enough of S3 for store-s3.js: objects in memory, and the same errors S3 gives. */
function fakeS3() {
  const objects = new Map(); // key -> { body, lastModified }
  const calls = [];
  const named = (name) => class { constructor(input) { this.input = input; this.kind = name; } };
  const cmd = { GetObjectCommand: named('get'), PutObjectCommand: named('put'), ListObjectsV2Command: named('list'), DeleteObjectCommand: named('delete') };
  const fail = (name) => Object.assign(new Error(name), { name });
  const s3 = {
    async send(c) {
      calls.push(c.kind);
      const { Key } = c.input;
      if (c.kind === 'get') {
        if (!objects.has(Key)) throw fail('NoSuchKey');
        return { Body: { transformToString: async () => objects.get(Key).body } };
      }
      if (c.kind === 'put') {
        if (c.input.IfNoneMatch === '*' && objects.has(Key)) throw fail('PreconditionFailed');
        objects.set(Key, { body: c.input.Body, lastModified: new Date() });
        return {};
      }
      if (c.kind === 'list') {
        // Two objects a page, to exercise paging.
        const keys = [...objects.keys()].filter((k) => k.startsWith(c.input.Prefix)).sort();
        const start = c.input.ContinuationToken ? Number(c.input.ContinuationToken) : 0;
        const page = keys.slice(start, start + 2);
        const more = start + 2 < keys.length;
        return { Contents: page.map((k) => ({ Key: k, Size: Buffer.byteLength(objects.get(k).body), LastModified: objects.get(k).lastModified })), IsTruncated: more, NextContinuationToken: more ? String(start + 2) : undefined };
      }
      throw new Error('unexpected S3 call: ' + c.kind);
    },
  };
  return { s3, cmd, objects, calls };
}

const quiet = { log() {}, error() {} };

const STORES = {
  disk() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dana-backup-test-'));
    return { open: () => createDiskStore(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  },
  s3() {
    const fake = fakeS3();
    return { open: () => createS3Store({ s3: fake.s3, cmd: fake.cmd, bucket: 'test' }), cleanup() {}, fake };
  },
};

for (const [kind, make] of Object.entries(STORES)) {
  const setup = (opts = {}) => {
    const st = make();
    let t = Date.parse('2026-11-19T04:00:00Z');
    const service = (more = {}) => createBackupService({ token: TOKEN, store: st.open(), log: quiet, now: () => (t += 1000), ...opts, ...more });
    const call = (svc, method, url, { body = '', headers = {} } = {}) => svc.handle({ method, url, headers, ip: '203.0.113.9', readBody: async () => body });
    return { st, service, call };
  };
  const key = { authorization: `Bearer ${TOKEN}` };

  test(`${kind}: a backup is saved, the same one again is not, a changed one is a new version`, async () => {
    const { st, service, call } = setup();
    const svc = service();
    const first = await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book(0) });
    assert.equal(first.status, 201);
    assert.match(JSON.parse(first.body).saved, /^2026-11-19T04-00-01\.000Z-[0-9a-f]{8}\.json$/);
    assert.deepEqual(JSON.parse((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book(0) })).body), { unchanged: true });
    assert.equal((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book(1) })).status, 201);

    const list = JSON.parse((await call(svc, 'GET', '/backups', { headers: key })).body);
    assert.equal(list.devices.length, 1);
    assert.deepEqual({ ...list.devices[0], lastBackup: null }, { device: DEVICE, lastBackup: null, versions: 2, funds: ['Bhante 医疗费用'], people: 1, receipts: 1, payouts: 0 });
    assert.equal(list.usedBytes, Buffer.byteLength(book(0)) + 2 * Buffer.byteLength(book(1)));

    const latest = await call(svc, 'GET', `/backups/${DEVICE}/latest`, { headers: key });
    assert.equal(latest.status, 200);
    assert.equal(latest.body, book(1));
    st.cleanup();
  });

  test(`${kind}: after a restart it still knows what it has`, async () => {
    const { st, service, call } = setup();
    await call(service(), 'PUT', `/backup/${DEVICE}`, { body: book(2) });
    const again = service(); // a fresh copy over the same storage
    assert.deepEqual(JSON.parse((await call(again, 'PUT', `/backup/${DEVICE}`, { body: book(2) })).body), { unchanged: true });
    const list = JSON.parse((await call(again, 'GET', '/backups', { headers: key })).body);
    assert.equal(list.usedBytes, 2 * Buffer.byteLength(book(2)));
    assert.equal(list.devices[0].versions, 1);
    st.cleanup();
  });

  test(`${kind}: refuses what is not a backup`, async () => {
    const { st, service, call } = setup({ maxBytes: 5000 });
    const svc = service();
    const status = async (...a) => (await call(svc, ...a)).status;
    assert.equal(await status('PUT', `/backup/${DEVICE}`, { body: '{"x":1}' }), 400);
    assert.equal(await status('PUT', `/backup/${DEVICE}`, { body: 'not json' }), 400);
    assert.equal(await status('PUT', `/backup/${DEVICE}`, { body: L.backupJSON(L.emptyState()) }), 422);
    assert.equal(await status('PUT', '/backup/not-a-device', { body: book() }), 400);
    assert.equal(await status('PUT', `/backup/${DEVICE}`, { body: book() + ' '.repeat(6000) }), 413);
    assert.equal(await status('GET', `/backup/${DEVICE}`), 405);
    assert.equal(await status('GET', '/nothing'), 404);
    assert.equal(await status('GET', '//['), 400);
    assert.deepEqual(JSON.parse((await call(svc, 'GET', '/backups', { headers: key })).body).devices, []);
    st.cleanup();
  });

  test(`${kind}: reading needs the key, uploading does not`, async () => {
    const { st, service, call } = setup();
    const svc = service();
    assert.equal((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book() })).status, 201);
    assert.equal((await call(svc, 'GET', '/backups')).status, 401);
    assert.equal((await call(svc, 'GET', '/backups', { headers: { authorization: 'Bearer ' + 'x'.repeat(40) } })).status, 401);
    assert.equal((await call(svc, 'GET', `/backups/${DEVICE}/latest`)).status, 401);
    assert.equal((await call(svc, 'GET', `/backups/${OTHER}/latest`, { headers: key })).status, 404);
    assert.deepEqual(JSON.parse((await call(svc, 'GET', '/health')).body), { ok: true });
    st.cleanup();
  });

  test(`${kind}: when storage is full it refuses new backups and keeps the old`, async () => {
    const one = Buffer.byteLength(book(0));
    const { st, service, call } = setup({ quotaBytes: one * 2 + 10 });
    const svc = service();
    assert.equal((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book(0) })).status, 201);
    assert.equal((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book(1) })).status, 507);
    assert.equal((await call(svc, 'PUT', `/backup/${OTHER}`, { body: book(0) })).status, 507);
    assert.equal((await call(svc, 'GET', `/backups/${DEVICE}/latest`, { headers: key })).body, book(0));
    st.cleanup();
  });

  test(`${kind}: only the app's own site may call from a browser`, async () => {
    const { st, service, call } = setup();
    const svc = service();
    const ok = await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book(), headers: { origin: ORIGIN } });
    assert.equal(ok.status, 201);
    assert.equal(ok.headers['Access-Control-Allow-Origin'], ORIGIN);
    assert.equal(Object.keys(ok.headers).filter((h) => h.toLowerCase() === 'access-control-allow-origin').length, 1);
    const pre = await call(svc, 'OPTIONS', `/backup/${DEVICE}`, { headers: { origin: ORIGIN } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['Access-Control-Allow-Origin'], ORIGIN);
    assert.equal(pre.headers['Access-Control-Allow-Methods'], 'GET, PUT');
    assert.match(pre.headers['Access-Control-Allow-Headers'], /Content-Type/);
    const bad = await call(svc, 'PUT', `/backup/${OTHER}`, { body: book(), headers: { origin: 'https://example.com' } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['Access-Control-Allow-Origin'], undefined);
    st.cleanup();
  });
}

test('s3: objects are laid out like the files on the Pi, and nothing is ever deleted or replaced', async () => {
  const fake = fakeS3();
  let t = Date.parse('2026-11-19T04:00:00Z');
  const svc = createBackupService({ token: TOKEN, store: createS3Store({ s3: fake.s3, cmd: fake.cmd, bucket: 'test' }), log: quiet, now: () => t });
  const put = (body) => svc.handle({ method: 'PUT', url: `/backup/${DEVICE}`, headers: {}, readBody: async () => body });
  await put(book(0));
  t += 1000;
  await put(book(1));
  const keys = [...fake.objects.keys()].sort();
  assert.equal(keys.length, 3);
  assert.match(keys[0], new RegExp(`^devices/${DEVICE}/2026-11-19T04-00-00\\.000Z-[0-9a-f]{8}\\.json$`));
  assert.equal(keys[2], `devices/${DEVICE}/latest.json`);
  assert.equal(fake.objects.get(keys[0]).body, book(0)); // the first version is still there, untouched
  assert.equal(fake.objects.get(keys[2]).body, book(1));
  assert.ok(!fake.calls.includes('delete'));
});

test('lambda: an API Gateway request goes in and an API Gateway answer comes out', async () => {
  const fake = fakeS3();
  const handler = createHandler(createBackupService({ token: TOKEN, store: createS3Store({ s3: fake.s3, cmd: fake.cmd, bucket: 'test' }), log: quiet }));
  const event = (method, rawPath, extra = {}) => ({ version: '2.0', rawPath, headers: {}, requestContext: { http: { method, sourceIp: '203.0.113.9' } }, ...extra });

  const put = await handler(event('PUT', `/backup/${DEVICE}`, { body: book(1), headers: { Origin: ORIGIN, 'content-type': 'application/json' } }));
  assert.equal(put.statusCode, 201);
  assert.equal(put.headers['Access-Control-Allow-Origin'], ORIGIN);
  assert.equal(typeof put.body, 'string');

  // API Gateway may hand the body over base64-encoded.
  const b64 = await handler(event('PUT', `/backup/${OTHER}`, { body: Buffer.from(book(2)).toString('base64'), isBase64Encoded: true }));
  assert.equal(b64.statusCode, 201);
  assert.equal(fake.objects.get(`devices/${OTHER}/latest.json`).body, book(2));

  assert.equal((await handler(event('OPTIONS', `/backup/${DEVICE}`, { headers: { origin: ORIGIN } }))).statusCode, 204);
  assert.equal((await handler(event('GET', '/backups'))).statusCode, 401);
  const list = await handler(event('GET', '/backups', { headers: { Authorization: `Bearer ${TOKEN}` } }));
  assert.equal(JSON.parse(list.body).devices.length, 2);
  assert.deepEqual(JSON.parse((await handler(event('GET', '/health'))).body), { ok: true });
});

test('pi: the server on a real port, with its limit on uploads from one address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dana-backup-test-'));
  const server = createBackupServer({ token: TOKEN, dir, uploadsPerHour: 2, maxBytes: 5000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const ask = (method, url, { body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', method, path: url, headers }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  const realLog = console.log;
  console.log = () => {};
  try {
    const first = await ask('PUT', `/backup/${DEVICE}`, { body: book(0), headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } });
    assert.equal(first.status, 201);
    assert.equal(first.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(first.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal((await ask('PUT', `/backup/${DEVICE}`, { body: book(0) + ' '.repeat(6000) })).status, 413);
    assert.equal((await ask('PUT', `/backup/${DEVICE}`, { body: book(1) })).status, 429); // the third from this address
    assert.equal((await ask('OPTIONS', `/backup/${DEVICE}`, { headers: { Origin: ORIGIN } })).status, 204);
    const latest = await ask('GET', `/backups/${DEVICE}/latest`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(latest.body, book(0));
    assert.ok(fs.existsSync(path.join(dir, 'devices', DEVICE, 'latest.json')));
  } finally {
    console.log = realLog;
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
