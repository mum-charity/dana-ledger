// Tests for the backup server (server/). The same checks run against both places it can keep
// backups: files on disk (the Raspberry Pi) and an S3 bucket (AWS), using a stand-in for S3.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import L from '../lib/model.js';
import { createBackupService, type BackupResponse, type BackupService, type BackupServiceOptions } from '../server/backup-core.ts';
import { createDiskStore } from '../server/store-disk.ts';
import { createS3Store, type S3Commands } from '../server/aws/store-s3.ts';
import { createHandler, type ApiEvent } from '../server/aws/lambda.ts';
import { createBackupServer } from '../server/backup-server.ts';

const TOKEN = 'k'.repeat(40);
const ORIGIN = 'https://mum.franklee.asia';
const DEVICE = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);

/** A backup of a small book. `receipts` changes the records, so each count is a new version. */
const books = new Map<number, string>(); // made once each, because every new book gets new random ids
function book(receipts = 0): string {
  let text = books.get(receipts);
  if (text === undefined) books.set(receipts, (text = makeBook(receipts)));
  return text;
}
function makeBook(receipts: number): string {
  const s = L.emptyState();
  const fund = L.addFund(s, { name: 'Bhante 医疗费用', opening: 5000 });
  const m = L.addMember(s, { fundId: fund.id, name: '陈美玲', pledge: 1000, startMonth: '2026-01' });
  for (let i = 0; i < receipts; i++) L.setReceipt(s, { memberId: m.id, month: `2026-0${i + 1}`, amount: 1000, date: `2026-0${i + 1}-05` });
  return L.backupJSON(s);
}

/** Enough of S3 for store-s3.ts: objects in memory, and the same errors S3 gives. */
function fakeS3() {
  interface Command { kind: string; input: { Key: string; Body: string; Prefix: string; IfNoneMatch?: string; ContinuationToken?: string } }
  const objects = new Map<string, { body: string; lastModified: Date }>();
  const calls: string[] = [];
  const named = (kind: string) => class { kind = kind; input: unknown; constructor(input: unknown) { this.input = input; } };
  const cmd: S3Commands = { GetObjectCommand: named('get'), PutObjectCommand: named('put'), ListObjectsV2Command: named('list') };
  const fail = (name: string) => Object.assign(new Error(name), { name });
  const stored = (key: string) => objects.get(key)!;
  const s3 = {
    async send(command: unknown) {
      const c = command as Command;
      calls.push(c.kind);
      const { Key } = c.input;
      if (c.kind === 'get') {
        if (!objects.has(Key)) throw fail('NoSuchKey');
        return { Body: { transformToString: async () => stored(Key).body } };
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
        return { Contents: page.map((k) => ({ Key: k, Size: Buffer.byteLength(stored(k).body), LastModified: stored(k).lastModified })), IsTruncated: more, NextContinuationToken: more ? String(start + 2) : undefined };
      }
      throw new Error('unexpected S3 call: ' + c.kind);
    },
  };
  return { s3, cmd, objects, calls };
}

const quiet = { log() {}, error() {} };

interface CallOptions { body?: string; headers?: Record<string, string> }

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
  const setup = (opts: Partial<BackupServiceOptions> = {}) => {
    const st = make();
    let t = Date.parse('2026-11-19T04:00:00Z');
    const service = (more: Partial<BackupServiceOptions> = {}) => createBackupService({ token: TOKEN, store: st.open(), log: quiet, now: () => (t += 1000), ...opts, ...more });
    const call = (svc: BackupService, method: string, url: string, { body = '', headers = {} }: CallOptions = {}): Promise<BackupResponse> =>
      svc.handle({ method, url, headers, ip: '203.0.113.9', readBody: async () => body });
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

  test(`${kind}: a change to the offerings alone is a new version`, async () => {
    const { st, service, call } = setup();
    const svc = service();
    const withLunch = JSON.parse(book(1));
    L.addOffering(withLunch.data, { date: '2026-11-14', recipient: '僧团午餐', lines: [{ name: '吴晶晶', amount: 100 }] });
    const text = JSON.stringify(withLunch);
    assert.equal((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: book(1) })).status, 201);
    assert.equal((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: text })).status, 201, 'not mistaken for the same backup');
    assert.deepEqual(JSON.parse((await call(svc, 'PUT', `/backup/${DEVICE}`, { body: text })).body), { unchanged: true });
    assert.equal((await call(svc, 'GET', `/backups/${DEVICE}/latest`, { headers: key })).body, text);
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
    const status = async (method: string, url: string, o?: CallOptions) => (await call(svc, method, url, o)).status;
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

  test(`${kind}: a shared book is published with the key and read with its setup code alone`, async () => {
    const { st, service, call } = setup();
    const svc = service();
    const CODE = 'c'.repeat(32);
    // Publishing is the family's: no key, no book.
    assert.equal((await call(svc, 'PUT', `/book/${CODE}`, { body: book(1) })).status, 401);
    assert.equal((await call(svc, 'GET', `/book/${CODE}`)).status, 404);
    const put = await call(svc, 'PUT', `/book/${CODE}`, { body: book(1), headers: key });
    assert.equal(put.status, 201);
    assert.deepEqual(JSON.parse(put.body), { published: true, funds: 1, people: 1, receipts: 1, payouts: 0, offerings: 0 });

    // A phone has only the code, and calls from the app's own site.
    const got = await call(svc, 'GET', `/book/${CODE}`, { headers: { origin: ORIGIN } });
    assert.equal(got.status, 200);
    assert.equal(got.body, book(1));
    assert.equal(got.headers['Access-Control-Allow-Origin'], ORIGIN);
    assert.equal(got.headers['Cache-Control'], 'no-store');
    // Any other code opens nothing, and a code is not a way into the phones' backups.
    assert.equal((await call(svc, 'GET', `/book/${'d'.repeat(32)}`)).status, 404);
    assert.equal((await call(svc, 'GET', '/book/short')).status, 400);
    assert.equal((await call(svc, 'GET', `/backups/${CODE}/latest`)).status, 401);
    assert.deepEqual(JSON.parse((await call(svc, 'GET', '/backups', { headers: key })).body).devices, []);

    // Publishing again replaces it; a fresh copy of the server over the same storage still has it.
    assert.equal((await call(svc, 'PUT', `/book/${CODE}`, { body: book(2), headers: key })).status, 201);
    assert.equal((await call(service(), 'GET', `/book/${CODE}`)).body, book(2));
    st.cleanup();
  });

  test(`${kind}: a shared book that is empty, broken or would lose records is not published`, async () => {
    const { st, service, call } = setup({ maxBytes: 5000 });
    const svc = service();
    const CODE = 'c'.repeat(32);
    const status = async (body: string) => (await call(svc, 'PUT', `/book/${CODE}`, { body, headers: key })).status;
    assert.equal(await status('not json'), 400);
    assert.equal(await status(L.backupJSON(L.emptyState())), 422);
    const broken = JSON.parse(book(1));
    broken.data.receipts[0].date = 'yesterday';
    assert.equal(await status(JSON.stringify(broken)), 422);
    assert.equal(await status(book() + ' '.repeat(6000)), 413);
    assert.equal((await call(svc, 'PUT', '/book/not-a-code', { body: book(), headers: key })).status, 400);
    assert.equal((await call(svc, 'POST', `/book/${CODE}`, { body: book(), headers: key })).status, 405);
    assert.equal((await call(svc, 'GET', `/book/${CODE}`)).status, 404, 'nothing was stored');
    st.cleanup();
  });
}

/**
 * A book with a secret marker in every field a person writes by hand: names, notes, month notes,
 * offerings. None of it may ever reach the public accounts.
 */
const SECRET = 'SECRET-陈美玲';
function bookWithSecrets() {
  const s = L.emptyState();
  const fund = L.addFund(s, { name: 'Bhante 医疗费用', opening: 5000, note: SECRET + ' note' });
  L.setMonthNote(s, fund.id, '2026-02', SECRET + ' month');
  const a = L.addMember(s, { fundId: fund.id, name: SECRET + ' 一', pledge: 1000, startMonth: '2026-01', note: SECRET + ' member' });
  const b = L.addMember(s, { fundId: fund.id, name: SECRET + ' 二', pledge: 500, startMonth: '2026-01' });
  L.setReceipt(s, { memberId: a.id, month: '2025-12', amount: 1000, date: '2025-12-20', note: SECRET + ' early' });
  L.setReceipt(s, { memberId: a.id, month: '2026-01', amount: 1000, date: '2026-01-05', note: SECRET + ' receipt' });
  L.setReceipt(s, { memberId: b.id, month: '2026-01', amount: 500, date: '2026-01-06' });
  L.setReceipt(s, { memberId: a.id, month: '2027-01', amount: 1000, date: '2026-03-01' }); // paid a year ahead
  L.addPayout(s, { fundId: fund.id, month: '2026-01', date: '2026-01-31', amount: 1200, note: SECRET + ' Ref 123456789 Tan Chai Lee' });
  const hidden = L.addFund(s, { name: SECRET + ' hidden fund' });
  L.addMember(s, { fundId: hidden.id, name: '张三', startMonth: '2026-01' });
  L.addOffering(s, { date: '2026-01-10', recipient: SECRET + ' temple', lines: [{ name: SECRET + ' giver', amount: 2500 }], dedication: SECRET + ' dedication' });
  return JSON.parse(L.backupJSON(s));
}

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind}: the public accounts carry money totals and nothing written by hand`, async () => {
    const st = make();
    const svc = createBackupService({ token: TOKEN, store: st.open(), log: quiet, now: () => Date.parse('2026-11-19T04:00:00Z') });
    const key = { authorization: `Bearer ${TOKEN}` };
    const call = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
      svc.handle({ method, url: '/public', headers, readBody: async () => (body === undefined ? '' : JSON.stringify(body)) });
    const request = { book: bookWithSecrets(), funds: [{ name: 'Bhante 医疗费用', recipient: '医疗费 · Bhante' }], notice: '账目从旧簿抄入，正在核对中' };

    assert.equal((await call('GET')).status, 404, 'nothing before it is published');
    assert.equal((await call('PUT', request)).status, 401, 'publishing needs the key');
    assert.equal((await call('PUT', { ...request, funds: [{ name: 'no such fund' }] }, key)).status, 422);
    assert.equal((await call('PUT', { ...request, funds: [] }, key)).status, 422);
    assert.equal((await call('PUT', { ...request, funds: [request.funds[0], request.funds[0]] }, key)).status, 422);
    assert.equal((await call('PUT', { ...request, book: { x: 1 } }, key)).status, 400);
    assert.equal((await call('PUT', request, key)).status, 201);

    const got = await call('GET', undefined, { origin: ORIGIN });
    assert.equal(got.status, 200);
    assert.ok(!got.body.includes('SECRET'), 'no name, note, ref or offering reaches the public: ' + got.body.slice(0, 300));
    assert.ok(!got.body.includes('123456789') && !got.body.includes('张三'));
    const pub = JSON.parse(got.body);
    assert.equal(pub.app, 'dana-ledger-public');
    assert.equal(pub.year, 2026);
    assert.equal(pub.notice, '账目从旧簿抄入，正在核对中');
    assert.equal(pub.funds.length, 1, 'only the fund the family chose');
    const f = pub.funds[0];
    assert.deepEqual(
      { name: f.name, recipient: f.recipient, people: f.people, carriedIn: f.carriedIn, received: f.received, paidOut: f.paidOut, onHand: f.onHand, payouts: f.payouts },
      { name: 'Bhante 医疗费用', recipient: '医疗费 · Bhante', people: 2, carriedIn: 6000, received: 1500, paidOut: 1200, onHand: 7300, payouts: [{ date: '2026-01-31', amount: 1200 }] }
    );
    assert.deepEqual(f.months[0], { month: '2026-01', received: 1500, paidOut: 1200, balance: 6300 });
    assert.equal(f.months[11].balance, 6300);
    assert.deepEqual(Object.keys(f).sort(), ['carriedIn', 'months', 'name', 'onHand', 'paidOut', 'payouts', 'people', 'received', 'recipient']);
    st.cleanup();
  });
}

test('s3: a shared book is kept apart from the phones, under a name that is not its code', async () => {
  const fake = fakeS3();
  const svc = createBackupService({ token: TOKEN, store: createS3Store({ s3: fake.s3, cmd: fake.cmd, bucket: 'test' }), log: quiet });
  const CODE = 'c'.repeat(32);
  await svc.handle({ method: 'PUT', url: `/book/${CODE}`, headers: { authorization: `Bearer ${TOKEN}` }, readBody: async () => book(1) });
  const keys = [...fake.objects.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^books\/[0-9a-f]{64}\.json$/);
  assert.ok(!keys[0].includes(CODE));
});

test('s3: objects are laid out like the files on the Pi, and nothing is ever deleted or replaced', async () => {
  const fake = fakeS3();
  let t = Date.parse('2026-11-19T04:00:00Z');
  const svc = createBackupService({ token: TOKEN, store: createS3Store({ s3: fake.s3, cmd: fake.cmd, bucket: 'test' }), log: quiet, now: () => t });
  const put = (body: string) => svc.handle({ method: 'PUT', url: `/backup/${DEVICE}`, headers: {}, readBody: async () => body });
  await put(book(0));
  t += 1000;
  await put(book(1));
  const keys = [...fake.objects.keys()].sort();
  assert.equal(keys.length, 3);
  assert.match(keys[0], new RegExp(`^devices/${DEVICE}/2026-11-19T04-00-00\\.000Z-[0-9a-f]{8}\\.json$`));
  assert.equal(keys[2], `devices/${DEVICE}/latest.json`);
  assert.equal(fake.objects.get(keys[0])?.body, book(0)); // the first version is still there, untouched
  assert.equal(fake.objects.get(keys[2])?.body, book(1));
  assert.ok(!fake.calls.includes('delete'));
});

test('lambda: an API Gateway request goes in and an API Gateway answer comes out', async () => {
  const fake = fakeS3();
  const handler = createHandler(createBackupService({ token: TOKEN, store: createS3Store({ s3: fake.s3, cmd: fake.cmd, bucket: 'test' }), log: quiet }));
  const event = (method: string, rawPath: string, extra: Partial<ApiEvent> = {}): ApiEvent => ({ rawPath, headers: {}, requestContext: { http: { method, sourceIp: '203.0.113.9' } }, ...extra });

  const put = await handler(event('PUT', `/backup/${DEVICE}`, { body: book(1), headers: { Origin: ORIGIN, 'content-type': 'application/json' } }));
  assert.equal(put.statusCode, 201);
  assert.equal(put.headers['Access-Control-Allow-Origin'], ORIGIN);
  assert.equal(typeof put.body, 'string');

  // API Gateway may hand the body over base64-encoded.
  const b64 = await handler(event('PUT', `/backup/${OTHER}`, { body: Buffer.from(book(2)).toString('base64'), isBase64Encoded: true }));
  assert.equal(b64.statusCode, 201);
  assert.equal(fake.objects.get(`devices/${OTHER}/latest.json`)?.body, book(2));

  assert.equal((await handler(event('OPTIONS', `/backup/${DEVICE}`, { headers: { origin: ORIGIN } }))).statusCode, 204);
  assert.equal((await handler(event('GET', '/backups'))).statusCode, 401);
  const list = await handler(event('GET', '/backups', { headers: { Authorization: `Bearer ${TOKEN}` } }));
  assert.equal(JSON.parse(list.body).devices.length, 2);
  assert.deepEqual(JSON.parse((await handler(event('GET', '/health'))).body), { ok: true });
});

test('pi: the server on a real port, with its limit on uploads from one address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dana-backup-test-'));
  const server = createBackupServer({ token: TOKEN, dir, uploadsPerHour: 2, maxBytes: 5000 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const ask = (method: string, url: string, { body, headers = {} }: CallOptions = {}) =>
    new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
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
