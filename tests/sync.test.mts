// Tests for the family's shared book (shared/sync.ts): combining two devices' records, and the
// back-and-forth with the server. The devices here are made-up; the server is the real one
// (server/backup-core.ts) keeping its files in memory.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import L from '../lib/model.ts';
import { hashesOf, merge, sameHashes, syncOnce, type SyncDeps, type SyncMeta, type SyncResult } from '../shared/sync.ts';
import { createBackupService, type Store } from '../server/backup-core.ts';

type State = ReturnType<typeof L.emptyState>;
const copy = (s: State): State => L.normalizeState(JSON.parse(JSON.stringify(s))).state;
const names = (s: State) => s.members.map((m) => m.name);
const paid = (s: State) => s.receipts.map((r) => `${s.members.find((m) => m.id === r.memberId)?.name} ${r.month} ${r.amount}`).sort();

/** A small book: one fund, two people, one of them paid for January. */
function smallBook() {
  const s = L.emptyState();
  const fund = L.addFund(s, { name: 'Bhante 医疗费用', opening: 5000 });
  const a = L.addMember(s, { fundId: fund.id, name: '陈美玲', pledge: 1000, startMonth: '2026-01' });
  const b = L.addMember(s, { fundId: fund.id, name: '林志明', pledge: 2000, startMonth: '2026-01' });
  L.setReceipt(s, { memberId: a.id, month: '2026-01', amount: 1000, date: '2026-01-05' });
  L.addPayout(s, { fundId: fund.id, month: '2026-01', date: '2026-01-31', amount: 500, note: '交给 Bhante' });
  L.addOffering(s, { date: '2026-01-10', recipient: '僧团午餐', lines: [{ name: '陈美玲', amount: 2000 }] });
  return { state: copy(s), fund, a, b };
}

// ---------------------------------------------------------------- combining
test('merge: a book combined with itself is unchanged', () => {
  const { state } = smallBook();
  const m = merge(state, copy(state), hashesOf(state));
  assert.deepEqual(m.state, state);
  assert.ok(!m.changedHere && !m.changedThere);
  assert.ok(sameHashes(m.hashes, hashesOf(state)));
});

test('merge: records that only differ in how they are held in memory count as the same', () => {
  const { state, a } = smallBook();
  const mine = copy(state);
  // The app adds `updatedAt` when a record is edited and drops it when it saves.
  Object.assign(mine.receipts[0], { updatedAt: 123 });
  const m = merge(mine, copy(state), hashesOf(state));
  assert.ok(!m.changedHere && !m.changedThere);
  assert.equal(m.state.receipts[0].memberId, a.id);
});

test('merge: what each side added is kept, in the family\'s order first', () => {
  const { state, fund } = smallBook();
  const base = hashesOf(state);
  const mine = copy(state);
  const theirs = copy(state);
  L.addMember(mine, { fundId: fund.id, name: '我加的', pledge: 0, startMonth: '2026-02' });
  L.addMember(theirs, { fundId: fund.id, name: '他们加的', pledge: 0, startMonth: '2026-02' });
  L.addFund(theirs, { name: 'Dana Parami' });
  const m = merge(mine, theirs, base);
  assert.deepEqual(names(m.state), ['陈美玲', '林志明', '他们加的', '我加的']);
  assert.deepEqual(m.state.funds.map((f) => f.name), ['Bhante 医疗费用', 'Dana Parami']);
  assert.ok(m.changedHere && m.changedThere);
});

test('merge: a change on one side wins over no change; on both sides, this device\'s is kept', () => {
  const { state, a, b } = smallBook();
  const base = hashesOf(state);
  const mine = copy(state);
  const theirs = copy(state);
  L.updateMember(theirs, a.id, { name: '陈美玲（改）' });
  L.updateMember(mine, b.id, { pledge: 3000 });
  let m = merge(mine, theirs, base);
  assert.deepEqual(names(m.state), ['陈美玲（改）', '林志明']);
  assert.equal(m.state.members[1].pledge, 3000);

  L.updateMember(mine, a.id, { name: '陈美玲（我改的）' });
  m = merge(mine, theirs, base);
  assert.equal(m.state.members[0].name, '陈美玲（我改的）');
  assert.ok(m.changedThere, 'and it is sent to the family');
});

test('merge: a deletion carries over, unless the other side changed the record meanwhile', () => {
  const { state, a, b, fund } = smallBook();
  const base = hashesOf(state);

  // Deleted here, untouched there: stays deleted (and is deleted there when this is sent).
  let mine = copy(state);
  L.removeReceipt(mine, a.id, '2026-01');
  let m = merge(mine, copy(state), base);
  assert.deepEqual(paid(m.state), []);
  assert.ok(!m.changedHere && m.changedThere);

  // Deleted there, untouched here: goes from here too.
  let theirs = copy(state);
  L.removePayout(theirs, theirs.payouts[0].id);
  m = merge(copy(state), theirs, base);
  assert.equal(m.state.payouts.length, 0);
  assert.ok(m.changedHere && !m.changedThere);

  // Deleted there, but changed here since the last sync: the change is kept.
  mine = copy(state);
  L.setReceipt(mine, { memberId: a.id, month: '2026-01', amount: 1500, date: '2026-01-06' });
  theirs = copy(state);
  L.removeReceipt(theirs, a.id, '2026-01');
  m = merge(mine, theirs, base);
  assert.deepEqual(paid(m.state), ['陈美玲 2026-01 1500']);

  // Deleted here, but changed there: also kept.
  mine = copy(state);
  L.deleteMember(mine, b.id);
  theirs = copy(state);
  L.updateMember(theirs, b.id, { pledge: 2500 });
  m = merge(mine, theirs, base);
  assert.equal(m.state.members.find((x) => x.id === b.id)?.pledge, 2500);

  // With no record of the last sync, nothing is taken to be deleted.
  mine = copy(state);
  L.deleteFund(mine, fund.id);
  m = merge(mine, copy(state), {});
  assert.deepEqual(m.state.funds.map((f) => f.name), ['Bhante 医疗费用']);
  assert.deepEqual(names(m.state), ['陈美玲', '林志明']);
});

test('merge: nothing is left pointing at a fund or person that is gone', () => {
  const { state, fund, b } = smallBook();
  const base = hashesOf(state);
  // The family deleted the whole fund. Meanwhile this device added a person and a payment to it.
  const theirs = copy(state);
  L.deleteFund(theirs, fund.id);
  const mine = copy(state);
  const extra = L.addMember(mine, { fundId: fund.id, name: '新来的', pledge: 0, startMonth: '2026-02' });
  L.setReceipt(mine, { memberId: extra.id, month: '2026-02', amount: 700, date: '2026-02-01' });
  L.setReceipt(mine, { memberId: b.id, month: '2026-02', amount: 2000, date: '2026-02-01' });
  const m = merge(mine, theirs, base);
  assert.deepEqual([m.state.funds.length, m.state.members.length, m.state.receipts.length, m.state.payouts.length], [0, 0, 0, 0]);
  assert.equal(m.state.offerings.length, 1, 'offerings belong to no fund and stay');
  assert.equal(L.normalizeState(m.state).dropped, 0);
});

test('merge: two devices ticking the same person for the same month leave one payment, the same on both', () => {
  const { state, b } = smallBook();
  const base = hashesOf(state);
  const phone = copy(state);
  const laptop = copy(state);
  L.setReceipt(phone, { memberId: b.id, month: '2026-02', amount: 2000, date: '2026-02-03' });
  L.setReceipt(laptop, { memberId: b.id, month: '2026-02', amount: 2500, date: '2026-02-04' });
  laptop.receipts[laptop.receipts.length - 1].createdAt += 5000; // ticked later
  const onPhone = merge(phone, laptop, base);
  const onLaptop = merge(laptop, phone, base);
  assert.deepEqual(paid(onPhone.state), ['林志明 2026-02 2500', '陈美玲 2026-01 1000']);
  assert.deepEqual(paid(onLaptop.state), paid(onPhone.state));
  assert.ok(sameHashes(onPhone.hashes, onLaptop.hashes));
});

test('merge: settings are each device\'s own and are never sent', () => {
  const { state } = smallBook();
  const mine = copy(state);
  mine.settings.fontSize = 'xlarge';
  const theirs = copy(state);
  theirs.settings.currency = 'SGD';
  theirs.settings.fontSize = 'normal';
  const m = merge(mine, theirs, hashesOf(state));
  assert.equal(m.state.settings.currency, 'RM');
  assert.equal(m.state.settings.fontSize, 'xlarge');
  assert.ok(!m.changedThere, 'a change of settings alone is not sent');
});

const realBook = new URL('../private/book-2026.json', import.meta.url);
test('merge: mum\'s real book combined with itself changes nothing', { skip: !fs.existsSync(realBook) && 'private/book-2026.json is not on this computer' }, () => {
  const state = L.normalizeState(JSON.parse(fs.readFileSync(realBook, 'utf8'))).state;
  const base = hashesOf(state);
  const m = merge(copy(state), copy(state), base);
  assert.ok(!m.changedHere && !m.changedThere);
  assert.deepEqual(m.state, state);
  assert.equal(Object.keys(base).length, state.funds.length + state.members.length + state.receipts.length + state.payouts.length + state.offerings.length, 'no two records share a fingerprint key');
  // And with no memory of a last sync, against an empty device.
  const fresh = merge(L.emptyState(), copy(state), {});
  assert.deepEqual(fresh.state.receipts.length, state.receipts.length);
  assert.ok(fresh.changedHere && !fresh.changedThere);
});

// ---------------------------------------------------------------- devices and the server
const TOKEN = 'k'.repeat(40);

/** The real server, keeping the family book's versions in memory. */
function familyServer() {
  const versions: string[] = [];
  const none = async () => null;
  const store: Store = {
    getLatest: none, latestSize: async () => 0, usedBytes: async () => 0, save: async () => {}, list: async () => [], getBook: none, saveBook: async () => {},
    familyHead: async () => versions.length,
    getFamily: async (n) => versions[n - 1] ?? null,
    putFamily: async (n, text) => (n === versions.length + 1 ? (versions.push(text), true) : false),
  };
  const svc = createBackupService({ token: TOKEN, store, log: { log() {}, error() {} } });
  let down = false;
  let calls = 0;
  /** Runs just before the next PUT reaches the server: a moment for another device to get in first. */
  let beforePut: (() => Promise<void>) | null = null;
  const fetchIt = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls++;
    if (down) throw new TypeError('network down');
    const method = init.method || 'GET';
    if (method === 'PUT' && beforePut) {
      const run = beforePut;
      beforePut = null;
      await run();
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers || {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const out = await svc.handle({ method, url: new URL(String(url)).pathname, headers, readBody: async () => String(init.body ?? '') });
    return new Response(out.status === 204 ? null : out.body, { status: out.status, headers: out.headers });
  }) as typeof fetch;
  return { fetch: fetchIt, versions, book: (n = versions.length) => L.normalizeState(JSON.parse(versions[n - 1])).state, setDown: (d: boolean) => { down = d; }, calls: () => calls, raceBeforeNextPut: (fn: () => Promise<void>) => { beforePut = fn; } };
}

/** A phone or computer: its records, its "last synced" note, and how it answers when asked to replace. */
function device(server: ReturnType<typeof familyServer>, start: State = L.emptyState(), { signedIn = true, sayYes = true } = {}) {
  const d = {
    state: copy(start),
    meta: null as SyncMeta | null,
    asked: 0,
    replaced: 0,
    signedIn,
    sync: (): Promise<SyncResult> => syncOnce(deps),
  };
  const deps: SyncDeps = {
    server: 'https://backup.test',
    session: () => (d.signedIn ? TOKEN : null), // the family key is accepted like a session
    local: () => d.state,
    apply: (state, replacing) => { d.state = state; if (replacing) d.replaced++; },
    meta: () => d.meta,
    setMeta: (m) => { d.meta = m; },
    confirmReplace: async () => { d.asked++; return sayYes; },
    fetch: server.fetch,
  };
  return d;
}
const same = (a: State, b: State) => sameHashes(hashesOf(a), hashesOf(b));

test('sync: an empty device loads the family book; a device with nothing to give starts nothing', async () => {
  const server = familyServer();
  const empty = device(server);
  assert.deepEqual(await empty.sync(), { ok: false, why: 'no-book', message: 'the family has no book yet' });
  assert.equal(server.versions.length, 0, 'an empty book is never written');

  const { state } = smallBook();
  const first = device(server, state);
  assert.deepEqual(await first.sync(), { ok: true, version: 1, pulled: false, pushed: true });
  assert.equal(first.asked, 0);

  assert.deepEqual(await empty.sync(), { ok: true, version: 1, pulled: true, pushed: false });
  assert.ok(same(empty.state, state));
  assert.equal(empty.asked, 0, 'an empty device is not asked anything');
  // Nothing changed anywhere: nothing is written, and the book is not sent again.
  const before = server.calls();
  assert.deepEqual(await empty.sync(), { ok: true, version: 1, pulled: false, pushed: false });
  assert.equal(server.calls() - before, 1);
  assert.equal(server.versions.length, 1);
});

test('sync: a change on one device reaches the other, both ways, and deletions too', async () => {
  const server = familyServer();
  const { state, a, b } = smallBook();
  const phone = device(server, state);
  await phone.sync();
  const laptop = device(server);
  await laptop.sync();

  L.setReceipt(phone.state, { memberId: b.id, month: '2026-01', amount: 2000, date: '2026-01-07' });
  assert.deepEqual(await phone.sync(), { ok: true, version: 2, pulled: false, pushed: true });
  assert.deepEqual(await laptop.sync(), { ok: true, version: 2, pulled: true, pushed: false });
  assert.deepEqual(paid(laptop.state), ['林志明 2026-01 2000', '陈美玲 2026-01 1000']);

  L.removeReceipt(laptop.state, a.id, '2026-01');
  L.addMember(laptop.state, { fundId: laptop.state.funds[0].id, name: '新来的', pledge: 0, startMonth: '2026-02' });
  await laptop.sync();
  await phone.sync();
  assert.deepEqual(paid(phone.state), ['林志明 2026-01 2000']);
  assert.deepEqual(names(phone.state), ['陈美玲', '林志明', '新来的']);
  assert.ok(same(phone.state, laptop.state) && same(phone.state, server.book()));
  assert.equal(server.versions.length, 3, 'every version is still on the server');
  assert.deepEqual(paid(server.book(1)), ['陈美玲 2026-01 1000']);
});

test('sync: two devices changing things with no signal both keep their work, whoever syncs first', async () => {
  for (const order of ['phone first', 'laptop first']) {
    const server = familyServer();
    const { state, a, b } = smallBook();
    const phone = device(server, state);
    await phone.sync();
    const laptop = device(server);
    await laptop.sync();

    server.setDown(true);
    L.setReceipt(phone.state, { memberId: b.id, month: '2026-02', amount: 2000, date: '2026-02-03' });
    L.updateMember(phone.state, a.id, { name: '陈美玲 合家' });
    L.addPayout(laptop.state, { fundId: laptop.state.funds[0].id, month: '2026-02', date: '2026-02-28', amount: 900 });
    L.setReceipt(laptop.state, { memberId: a.id, month: '2026-02', amount: 1000, date: '2026-02-05' });
    assert.equal((await phone.sync()).ok, false, 'no signal: nothing is lost, it just waits');
    assert.equal(paid(phone.state).length, 2);
    server.setDown(false);

    const [one, two] = order === 'phone first' ? [phone, laptop] : [laptop, phone];
    await one.sync();
    await two.sync();
    await one.sync();
    assert.ok(same(phone.state, laptop.state) && same(phone.state, server.book()), order);
    assert.deepEqual(paid(phone.state), ['林志明 2026-02 2000', '陈美玲 合家 2026-01 1000', '陈美玲 合家 2026-02 1000'], order);
    assert.deepEqual(phone.state.payouts.map((p) => p.amount).sort(), [500, 900], order);
  }
});

test('sync: a device that writes just after another is not allowed to overwrite it', async () => {
  const server = familyServer();
  const { state, a, b } = smallBook();
  const phone = device(server, state);
  await phone.sync();
  const laptop = device(server);
  await laptop.sync();

  L.setReceipt(phone.state, { memberId: b.id, month: '2026-03', amount: 2000, date: '2026-03-03' });
  L.setReceipt(laptop.state, { memberId: a.id, month: '2026-03', amount: 1000, date: '2026-03-04' });
  // The laptop's write lands in the gap between the phone fetching and the phone writing.
  server.raceBeforeNextPut(async () => { await laptop.sync(); });
  const res = await phone.sync();
  assert.deepEqual(res, { ok: true, version: 3, pulled: true, pushed: true });
  assert.deepEqual(paid(server.book()), ['林志明 2026-03 2000', '陈美玲 2026-01 1000', '陈美玲 2026-03 1000'], "both devices' payments are in the family book");
  await laptop.sync();
  assert.ok(same(phone.state, laptop.state));
});

test('sync: a change made while the book is on its way up is not forgotten', async () => {
  const server = familyServer();
  const { state, a, b } = smallBook();
  const phone = device(server, state);
  await phone.sync();
  L.setReceipt(phone.state, { memberId: b.id, month: '2026-04', amount: 2000, date: '2026-04-03' });
  // While the upload is in the air she ticks another one.
  server.raceBeforeNextPut(async () => { L.setReceipt(phone.state, { memberId: a.id, month: '2026-04', amount: 1000, date: '2026-04-03' }); });
  await phone.sync();
  assert.equal(paid(server.book()).length, 2, 'the first tick went up');
  assert.equal(paid(phone.state).length, 3, 'the second is still on the phone');
  assert.deepEqual(await phone.sync(), { ok: true, version: 3, pulled: false, pushed: true });
  assert.equal(paid(server.book()).length, 3);
});

test('sync: a device with its own unrelated records is asked before they are set aside, never mixed in', async () => {
  const server = familyServer();
  const { state } = smallBook();
  await device(server, state).sync();

  const other = L.emptyState();
  const f = L.addFund(other, { name: '我自己的簿子' });
  L.addMember(other, { fundId: f.id, name: '张三', pledge: 0, startMonth: '2026-01' });

  const refuses = device(server, other, { sayYes: false });
  assert.deepEqual(await refuses.sync(), { ok: false, why: 'declined', message: 'kept the records already on this device' });
  assert.deepEqual(names(refuses.state), ['张三']);
  assert.equal(refuses.meta, null);
  assert.equal(server.versions.length, 1, 'and nothing of it reached the family book');

  const agrees = device(server, other);
  assert.deepEqual(await agrees.sync(), { ok: true, version: 1, pulled: true, pushed: false });
  assert.equal(agrees.asked, 1);
  assert.equal(agrees.replaced, 1, 'the app keeps a copy of what was set aside');
  assert.ok(same(agrees.state, state));

  // A device that already holds the very same book (loaded by the setup link) is not asked.
  const sameBook = device(server, state);
  assert.deepEqual(await sameBook.sync(), { ok: true, version: 1, pulled: false, pushed: false });
  assert.equal(sameBook.asked, 0);
});

test('sync: if the device cannot save what it fetched, it does not note the sync as done', async () => {
  const server = familyServer();
  const { state, b } = smallBook();
  const phone = device(server, state);
  await phone.sync();
  const laptop = device(server);
  await laptop.sync();
  L.setReceipt(phone.state, { memberId: b.id, month: '2026-05', amount: 2000, date: '2026-05-03' });
  await phone.sync();

  // The laptop's storage is full: saving the fetched records fails.
  const noteBefore = JSON.stringify(laptop.meta);
  const full: SyncDeps = {
    server: 'https://backup.test', session: () => TOKEN, local: () => laptop.state,
    apply: () => { throw new Error('storage is full'); },
    meta: () => laptop.meta, setMeta: (m) => { laptop.meta = m; },
    confirmReplace: async () => true, fetch: server.fetch,
  };
  await assert.rejects(syncOnce(full), /storage is full/);
  assert.equal(JSON.stringify(laptop.meta), noteBefore, 'the note of the last sync is untouched');
  assert.equal(server.versions.length, 2, 'and nothing was sent');
  // With room again, the same sync simply works, and nothing the phone added is taken as deleted.
  assert.deepEqual(await laptop.sync(), { ok: true, version: 2, pulled: true, pushed: false });
  assert.equal(paid(laptop.state).length, 2);
  assert.equal(paid(server.book()).length, 2);
});

test('sync: without a session nothing is fetched or sent', async () => {
  const server = familyServer();
  const { state } = smallBook();
  const d = device(server, state, { signedIn: false });
  assert.equal((await d.sync()).ok, false);
  assert.equal(server.calls(), 0);
  // A session the server no longer accepts.
  const stale: SyncDeps = { server: 'https://backup.test', session: () => 'not-a-session', local: () => state, apply() {}, meta: () => null, setMeta() {}, confirmReplace: async () => true, fetch: server.fetch };
  assert.deepEqual(await syncOnce(stale), { ok: false, why: 'signed-out', message: 'the session is no longer accepted' });
  assert.equal(server.versions.length, 0);
});
