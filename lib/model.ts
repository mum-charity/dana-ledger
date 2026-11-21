/*
 * 善款簿 — data model.
 * Pure functions over a plain JSON state. No DOM access, so the same file runs in the browser
 * (the app), in Node (the backup server and its scripts) and in the tests.
 *
 * Money is always stored as integer cents. Months are 'YYYY-MM' strings and
 * dates are 'YYYY-MM-DD' strings; both compare correctly as plain strings.
 */
export interface Settings {
  currency: string;
  fontSize: 'normal' | 'large' | 'xlarge';
  lastBackupAt: number | null;
  changesSinceBackup: number;
}
export interface Fund {
  id: string;
  name: string;
  opening: number;
  note: string;
  monthNotes: Record<string, string>;
  createdAt: number;
}
export interface Member {
  id: string;
  fundId: string;
  name: string;
  pledge: number;
  startMonth: string;
  endMonth: string | null;
  note: string;
  order: number;
  createdAt: number;
}
export interface Receipt {
  id: string;
  fundId: string;
  memberId: string;
  month: string;
  amount: number;
  date: string;
  note: string;
  createdAt: number;
  updatedAt?: number;
}
export interface Payout {
  id: string;
  fundId: string;
  month: string;
  date: string;
  amount: number;
  note: string;
  createdAt: number;
  updatedAt?: number;
}
export interface OfferingLine {
  name: string;
  amount: number;
}
export interface Offering {
  id: string;
  date: string;
  recipient: string;
  lines: OfferingLine[];
  dedication: string;
  note: string;
  createdAt: number;
  updatedAt?: number;
}
export interface State {
  schema: number;
  settings: Settings;
  funds: Fund[];
  members: Member[];
  receipts: Receipt[];
  payouts: Payout[];
  offerings: Offering[];
}
/** A backup file: the records wrapped with the app's name and when it was made. */
export interface Backup {
  app: string;
  schema: number;
  exportedAt: string;
  data: State;
}
/** One line of a pasted list of people: a name and a monthly amount (0 when it is not fixed). */
export interface BulkRow {
  name: string;
  pledge: number;
}
/** What a 供养 form sends: lines with no amount are people who did not give that day. */
export interface OfferingInput {
  date: string;
  recipient: string;
  lines: { name?: string; amount?: number | null }[];
  dedication?: string;
  note?: string;
}

const SCHEMA = 1;
const APP_ID = 'dana-ledger';

// ---------------------------------------------------------------- dates
const pad2 = (n: number) => String(n).padStart(2, '0');

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function currentMonth(d = new Date()) {
  return todayISO(d).slice(0, 7);
}
function isMonth(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}
function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s);
}
function addMonths(month: string, n: number): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${pad2(mm + 1)}`;
}
function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`);
}
function monthLabel(month: string): string {
  return `${+month.slice(0, 4)}年${+month.slice(5, 7)}月`;
}
function monthShort(month: string): string {
  return `${+month.slice(5, 7)}月`;
}
/** '2026-02-05' -> '5/2' (day/month, the way the paper book writes it). */
function shortDate(date: string): string {
  return `${+date.slice(8, 10)}/${+date.slice(5, 7)}`;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------- money
/**
 * Parse what a person typed into integer cents.
 * Accepts '10', '10.5', '1,000.00', 'RM 20', full-width digits, and the
 * Chinese full stop as a decimal point. Returns null if it is not a amount.
 */
function parseAmount(input: unknown): number | null {
  if (input == null) return null;
  const s = String(input)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/^\s*RM/i, '')
    .replace(/[,，\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = parseInt(whole, 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
  return Number.isSafeInteger(cents) ? cents : null;
}
/** 1234500 -> '12,345'; 1050 -> '10.50' */
function fmtNum(cents: number): string {
  const neg = cents < 0;
  const c = Math.abs(cents);
  const whole = Math.floor(c / 100);
  const frac = c % 100;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + w + (frac ? '.' + pad2(frac) : '');
}
/** Plain number for spreadsheets and inputs: 1234500 -> '12345', 1050 -> '10.50' */
function fmtPlain(cents: number): string {
  const neg = cents < 0;
  const c = Math.abs(cents);
  const frac = c % 100;
  return (neg ? '-' : '') + Math.floor(c / 100) + (frac ? '.' + pad2(frac) : '');
}
function fmtMoney(cents: number, currency = 'RM'): string {
  return (cents < 0 ? '-' : '') + (currency ? currency + ' ' : '') + fmtNum(Math.abs(cents));
}

const sum = (list: { amount: number }[]) => list.reduce((s, x) => s + x.amount, 0);
const byOrder = (a: Member, b: Member) => a.order - b.order || a.createdAt - b.createdAt;
const byDate = (a: Payout, b: Payout) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt);

// ---------------------------------------------------------------- state
function emptyState(): State {
  return {
    schema: SCHEMA,
    settings: { currency: 'RM', fontSize: 'large', lastBackupAt: null, changesSinceBackup: 0 },
    funds: [],
    members: [],
    receipts: [],
    payouts: [],
    offerings: [],
  };
}

function fail(msg: string): never {
  throw new Error(msg);
}
function cleanText(s: unknown, max = 200): string {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
}
function checkAmount(amount: number, { allowZero = false } = {}): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || (!allowZero && amount === 0)) fail('请输入正确的金额');
}

// ---------------------------------------------------------------- lookups
const getFund = (s: State, id: string): Fund | null => s.funds.find((f) => f.id === id) || null;
const getMember = (s: State, id: string): Member | null => s.members.find((m) => m.id === id) || null;
const getPayout = (s: State, id: string): Payout | null => s.payouts.find((p) => p.id === id) || null;

function fundMembers(s: State, fundId: string): Member[] {
  return s.members.filter((m) => m.fundId === fundId).sort(byOrder);
}
function activeIn(member: Member, month: string): boolean {
  return member.startMonth <= month && (!member.endMonth || month <= member.endMonth);
}
function receiptOf(s: State, memberId: string, month: string): Receipt | null {
  return s.receipts.find((r) => r.memberId === memberId && r.month === month) || null;
}
function memberHasReceipts(s: State, memberId: string): boolean {
  return s.receipts.some((r) => r.memberId === memberId);
}
/** Members shown on a month page: everyone active that month, plus anyone who paid for it. */
function membersForMonth(s: State, fundId: string, month: string): Member[] {
  const paid = new Set(s.receipts.filter((r) => r.fundId === fundId && r.month === month).map((r) => r.memberId));
  return fundMembers(s, fundId).filter((m) => activeIn(m, month) || paid.has(m.id));
}
function payoutsFor(s: State, fundId: string, month: string): Payout[] {
  return s.payouts.filter((p) => p.fundId === fundId && p.month === month).sort(byDate);
}

/** Balance after everything that belongs to `month` and earlier. */
function balanceThrough(s: State, fundId: string, month: string): number {
  const fund = getFund(s, fundId);
  const opening = fund ? fund.opening : 0;
  const inSum = sum(s.receipts.filter((r) => r.fundId === fundId && r.month <= month));
  const outSum = sum(s.payouts.filter((p) => p.fundId === fundId && p.month <= month));
  return opening + inSum - outSum;
}
/** Money she should be holding now: opening + everything received - everything paid out. */
function cashOnHand(s: State, fundId: string): number {
  const fund = getFund(s, fundId);
  return (
    (fund ? fund.opening : 0) +
    sum(s.receipts.filter((r) => r.fundId === fundId)) -
    sum(s.payouts.filter((p) => p.fundId === fundId))
  );
}
/** Money already received for months after `month` (prepayments). */
function prepaidAfter(s: State, fundId: string, month: string): number {
  return sum(s.receipts.filter((r) => r.fundId === fundId && r.month > month));
}

function monthSummary(s: State, fundId: string, month: string) {
  const members = membersForMonth(s, fundId, month);
  let expected = 0;
  let received = 0;
  let receivedCount = 0;
  const unpaid: Member[] = [];
  for (const m of members) {
    const r = receiptOf(s, m.id, month);
    if (activeIn(m, month)) expected += m.pledge;
    if (r) {
      received += r.amount;
      receivedCount += 1;
    } else {
      unpaid.push(m);
    }
  }
  const payouts = payoutsFor(s, fundId, month);
  const paidOut = sum(payouts);
  const opening = balanceThrough(s, fundId, addMonths(month, -1));
  return {
    members,
    unpaid,
    expected,
    received,
    receivedCount,
    payouts,
    paidOut,
    opening,
    closing: opening + received - paidOut,
  };
}

function yearGrid(s: State, fundId: string, year: number) {
  const months = monthsOfYear(year);
  const first = months[0];
  const last = months[11];
  const all = fundMembers(s, fundId);
  const numberOf = new Map(all.map((m, i) => [m.id, i + 1]));
  const members = all.filter(
    (m) =>
      (m.startMonth <= last && (!m.endMonth || m.endMonth >= first)) ||
      s.receipts.some((r) => r.memberId === m.id && r.month >= first && r.month <= last)
  );
  const rows = members.map((m) => {
    const cells = months.map((month) => ({ month, receipt: receiptOf(s, m.id, month), active: activeIn(m, month) }));
    return { member: m, no: numberOf.get(m.id)!, cells, total: cells.reduce((t, c) => t + (c.receipt ? c.receipt.amount : 0), 0) };
  });
  const received = months.map((mo) => sum(s.receipts.filter((r) => r.fundId === fundId && r.month === mo)));
  const payouts = months.map((mo) => payoutsFor(s, fundId, mo));
  const paidOut = payouts.map(sum);
  const opening = balanceThrough(s, fundId, addMonths(first, -1));
  let running = opening;
  const balance = months.map((_, i) => (running += received[i] - paidOut[i]));
  const fund = getFund(s, fundId);
  const notes = months.map((mo) => (fund && fund.monthNotes && fund.monthNotes[mo]) || '');
  return {
    year,
    months,
    rows,
    received,
    payouts,
    paidOut,
    opening,
    balance,
    notes,
    totalReceived: received.reduce((a, b) => a + b, 0),
    totalPaidOut: paidOut.reduce((a, b) => a + b, 0),
  };
}

// ---------------------------------------------------------------- funds
function addFund(s: State, { name, opening = 0, note = '' }: { name: string; opening?: number; note?: string }): Fund {
  name = cleanText(name, 60);
  if (!name) fail('请填写项目名称');
  checkAmount(opening, { allowZero: true });
  const fund: Fund = { id: uid(), name, opening, note: cleanText(note, 500), monthNotes: {}, createdAt: Date.now() };
  s.funds.push(fund);
  return fund;
}
function updateFund(s: State, id: string, patch: { name?: string; opening?: number; note?: string }): Fund {
  const fund = getFund(s, id) || fail('找不到这个项目');
  if ('name' in patch) {
    const name = cleanText(patch.name, 60);
    if (!name) fail('请填写项目名称');
    fund.name = name;
  }
  if ('opening' in patch) {
    checkAmount(patch.opening as number, { allowZero: true });
    fund.opening = patch.opening as number;
  }
  if ('note' in patch) fund.note = cleanText(patch.note, 500);
  return fund;
}
function deleteFund(s: State, id: string): void {
  s.funds = s.funds.filter((f) => f.id !== id);
  s.members = s.members.filter((m) => m.fundId !== id);
  s.receipts = s.receipts.filter((r) => r.fundId !== id);
  s.payouts = s.payouts.filter((p) => p.fundId !== id);
}
function setMonthNote(s: State, fundId: string, month: string, text: unknown): void {
  const fund = getFund(s, fundId) || fail('找不到这个项目');
  if (!isMonth(month)) fail('月份不对');
  const t = String(text == null ? '' : text).trim().slice(0, 500);
  fund.monthNotes = fund.monthNotes || {};
  if (t) fund.monthNotes[month] = t;
  else delete fund.monthNotes[month];
}

// ---------------------------------------------------------------- members
function checkRange(startMonth: unknown, endMonth: string | null): void {
  if (!isMonth(startMonth)) fail('请选择开始月份');
  if (endMonth != null && !isMonth(endMonth)) fail('结束月份不对');
  if (endMonth && endMonth < startMonth) fail('结束月份不能早于开始月份');
}
function addMember(s: State, { fundId, name, pledge = 0, startMonth, endMonth = null, note = '' }: { fundId: string; name: string; pledge?: number; startMonth: string; endMonth?: string | null; note?: string }): Member {
  if (!getFund(s, fundId)) fail('找不到这个项目');
  name = cleanText(name, 80);
  if (!name) fail('请填写名字');
  checkAmount(pledge, { allowZero: true });
  endMonth = endMonth || null;
  checkRange(startMonth, endMonth);
  const siblings = s.members.filter((m) => m.fundId === fundId);
  const order = siblings.reduce((mx, m) => Math.max(mx, m.order), 0) + 1;
  const member: Member = { id: uid(), fundId, name, pledge, startMonth, endMonth, note: cleanText(note, 300), order, createdAt: Date.now() };
  s.members.push(member);
  return member;
}
function updateMember(s: State, id: string, patch: { name?: string; pledge?: number; startMonth?: string; endMonth?: string | null; note?: string }): Member {
  const m = getMember(s, id) || fail('找不到这个人');
  const next = { ...m, ...patch };
  next.name = cleanText(next.name, 80);
  if (!next.name) fail('请填写名字');
  checkAmount(next.pledge, { allowZero: true });
  next.endMonth = next.endMonth || null;
  checkRange(next.startMonth, next.endMonth);
  next.note = cleanText(next.note, 300);
  Object.assign(m, { name: next.name, pledge: next.pledge, startMonth: next.startMonth, endMonth: next.endMonth, note: next.note });
  return m;
}
function deleteMember(s: State, id: string): void {
  if (memberHasReceipts(s, id)) fail('这个人已有收款记录，不能删除。如果不再捐，请设定“结束月份”。');
  s.members = s.members.filter((m) => m.id !== id);
}
/** Move a member up (-1) or down (+1) in the fund's list. Returns true if it moved. */
function moveMember(s: State, id: string, dir: number): boolean {
  const m = getMember(s, id);
  if (!m) return false;
  const list = fundMembers(s, m.fundId);
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (j < 0 || j >= list.length) return false;
  list.forEach((x, k) => (x.order = k + 1));
  [list[i].order, list[j].order] = [list[j].order, list[i].order];
  return true;
}

/**
 * Parse pasted lines like "陈美玲 10", "3. 林志明、黄淑芬 20", "Wong Mei Ling RM3".
 * Leading list numbers are dropped; a trailing number is the monthly amount.
 */
function parseBulkMembers(text: unknown): BulkRow[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let rest = line.replace(/^\d{1,3}\s*[.、)）:：]\s*/, '').replace(/^\d{1,3}\s+(?=\D)/, '');
      let pledge = 0;
      const m = rest.match(/^(.*?)[\s,，、:：]*(?:RM\s*)?([0-9０-９]+(?:[.．。][0-9０-９]{1,2})?)\s*(?:令吉|元)?$/i);
      if (m && m[1].trim()) {
        pledge = parseAmount(m[2]) || 0;
        rest = m[1];
      }
      return { name: cleanText(rest.replace(/[\s,，、:：]+$/, ''), 80), pledge };
    })
    .filter((x) => x.name);
}
function addMembersBulk(s: State, fundId: string, rows: BulkRow[], startMonth: string): Member[] {
  return rows.map((r) => addMember(s, { fundId, name: r.name, pledge: r.pledge, startMonth }));
}

// ---------------------------------------------------------------- receipts
function setReceipt(s: State, { memberId, month, amount, date, note = '' }: { memberId: string; month: string; amount: number; date: string; note?: string }): Receipt {
  const m = getMember(s, memberId) || fail('找不到这个人');
  if (!isMonth(month)) fail('月份不对');
  checkAmount(amount);
  if (!isDate(date)) fail('请选择日期');
  const existing = receiptOf(s, memberId, month);
  if (existing) {
    Object.assign(existing, { amount, date, note: cleanText(note, 300), updatedAt: Date.now() });
    return existing;
  }
  const r: Receipt = { id: uid(), fundId: m.fundId, memberId, month, amount, date, note: cleanText(note, 300), createdAt: Date.now() };
  s.receipts.push(r);
  return r;
}
function removeReceipt(s: State, memberId: string, month: string): Receipt | null {
  const r = receiptOf(s, memberId, month);
  if (r) s.receipts = s.receipts.filter((x) => x !== r);
  return r;
}
function restoreReceipt(s: State, r: Receipt | null): void {
  if (r && getMember(s, r.memberId) && !receiptOf(s, r.memberId, r.month)) s.receipts.push(r);
}
/** The next `count` months from `fromMonth` that this person has not paid yet. */
function nextUnpaidMonths(s: State, memberId: string, fromMonth: string, count: number): string[] {
  const out: string[] = [];
  let mo = fromMonth;
  for (let guard = 0; out.length < count && guard < 600; guard++) {
    if (!receiptOf(s, memberId, mo)) out.push(mo);
    mo = addMonths(mo, 1);
  }
  return out;
}
/** Record one payment that covers several months (e.g. 已付全年). Already-paid months are skipped. */
function prepay(s: State, { memberId, fromMonth, count, amountEach, date, note = '' }: { memberId: string; fromMonth: string; count: number; amountEach: number; date: string; note?: string }): Receipt[] {
  if (!Number.isInteger(count) || count < 1 || count > 60) fail('月数不对');
  checkAmount(amountEach);
  const months = nextUnpaidMonths(s, memberId, fromMonth, count);
  return months.map((month) => setReceipt(s, { memberId, month, amount: amountEach, date, note }));
}

// ---------------------------------------------------------------- payouts
function addPayout(s: State, { fundId, month, date, amount, note = '' }: { fundId: string; month: string; date: string; amount: number; note?: string }): Payout {
  if (!getFund(s, fundId)) fail('找不到这个项目');
  if (!isMonth(month)) fail('请选择月份');
  if (!isDate(date)) fail('请选择日期');
  checkAmount(amount);
  const p: Payout = { id: uid(), fundId, month, date, amount, note: cleanText(note, 300), createdAt: Date.now() };
  s.payouts.push(p);
  return p;
}
function updatePayout(s: State, id: string, { month, date, amount, note = '' }: { month: string; date: string; amount: number; note?: string }): Payout {
  const p = getPayout(s, id) || fail('找不到这笔记录');
  if (!isMonth(month)) fail('请选择月份');
  if (!isDate(date)) fail('请选择日期');
  checkAmount(amount);
  Object.assign(p, { month, date, amount, note: cleanText(note, 300), updatedAt: Date.now() });
  return p;
}
function removePayout(s: State, id: string): Payout | null {
  const p = getPayout(s, id);
  if (p) s.payouts = s.payouts.filter((x) => x !== p);
  return p;
}
function restorePayout(s: State, p: Payout | null): void {
  if (p && getFund(s, p.fundId) && !getPayout(s, p.id)) s.payouts.push(p);
}

// ---------------------------------------------------------------- offerings
// A 供养 (for example a monks' lunch) is one day's giving: who it was offered to, what each
// person put in, and who the merit is shared with. It is its own record. It belongs to no fund,
// so it never changes a fund's months or the money she should be holding.
const MAX_OFFERING_LINES = 60;
const getOffering = (s: State, id: string): Offering | null => (s.offerings || []).find((o) => o.id === id) || null;
const offeringTotal = (o: { lines: OfferingLine[] }): number => o.lines.reduce((t, l) => t + l.amount, 0);
/** Newest first; on the same day, the one written down later comes first. */
function offeringsSorted(s: State): Offering[] {
  return [...(s.offerings || [])].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
}
/** Keeps the lines that have an amount. A name with no amount is someone who did not give that day. */
function cleanOffering({ date, recipient, lines, dedication = '', note = '' }: OfferingInput) {
  if (!isDate(date)) fail('请选择日期');
  recipient = cleanText(recipient, 80);
  if (!recipient) fail('请填写供养给谁');
  const kept: OfferingLine[] = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const name = cleanText(l && l.name, 80);
    const amount = l ? l.amount : null;
    if (amount == null || amount === 0) continue;
    checkAmount(amount);
    if (!name) fail('有金额的那一行请填写名字');
    kept.push({ name, amount });
  }
  if (!kept.length) fail('请至少填写一个人的金额');
  if (kept.length > MAX_OFFERING_LINES) fail(`一次最多 ${MAX_OFFERING_LINES} 个人`);
  return { date, recipient, lines: kept, dedication: String(dedication == null ? '' : dedication).trim().slice(0, 1000), note: cleanText(note, 300) };
}
function addOffering(s: State, data: OfferingInput): Offering {
  const o: Offering = { id: uid(), ...cleanOffering(data), createdAt: Date.now() };
  s.offerings = s.offerings || [];
  s.offerings.push(o);
  return o;
}
function updateOffering(s: State, id: string, data: OfferingInput): Offering {
  const o = getOffering(s, id) || fail('找不到这笔供养');
  Object.assign(o, cleanOffering(data), { updatedAt: Date.now() });
  return o;
}
function removeOffering(s: State, id: string): Offering | null {
  const o = getOffering(s, id);
  if (o) s.offerings = s.offerings.filter((x) => x !== o);
  return o;
}
function restoreOffering(s: State, o: Offering | null): void {
  if (o && !getOffering(s, o.id)) (s.offerings = s.offerings || []).push(o);
}
/** Short report of one 供养 to paste into WhatsApp. */
function offeringShareText(o: Offering, currency = 'RM'): string {
  const [y, mo, d] = o.date.split('-');
  const out = [`【供养 ${o.recipient}】${+d}/${+mo}/${y}`];
  for (const l of o.lines) out.push(`${l.name}：${fmtNum(l.amount)}`);
  out.push(`合计：${fmtMoney(offeringTotal(o), currency)}`);
  if (o.dedication) out.push('', '回向功德给：', o.dedication);
  if (o.note) out.push('', o.note);
  return out.join('\n');
}

// ---------------------------------------------------------------- backup
function backupJSON(s: State): string {
  return JSON.stringify({ app: APP_ID, schema: SCHEMA, exportedAt: new Date().toISOString(), data: s });
}

/**
 * Validate and clean a state loaded from storage or a backup file.
 * Returns { state, dropped } where dropped counts records that were invalid.
 * Throws if the input is not a ledger at all.
 */
function normalizeState(input: unknown): { state: State; dropped: number } {
  // Anything at all may be in a file or in storage, so it is read untyped and every field is checked.
  const raw = input as any;
  const data: any = raw && raw.app === APP_ID && raw.data ? raw.data : raw;
  if (!data || typeof data !== 'object' || !Array.isArray(data.funds)) fail('这不是善款簿的备份文件');
  const out = emptyState();
  let dropped = 0;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

  const st = data.settings || {};
  if (typeof st.currency === 'string') out.settings.currency = st.currency.slice(0, 8);
  if (['normal', 'large', 'xlarge'].includes(st.fontSize)) out.settings.fontSize = st.fontSize;
  if (int(st.lastBackupAt) != null) out.settings.lastBackupAt = st.lastBackupAt;
  if (int(st.changesSinceBackup) != null) out.settings.changesSinceBackup = st.changesSinceBackup;

  for (const f of data.funds) {
    if (!f || !str(f.id) || !str(f.name)) { dropped++; continue; }
    const monthNotes: Record<string, string> = {};
    if (f.monthNotes && typeof f.monthNotes === 'object') {
      for (const [k, v] of Object.entries(f.monthNotes)) if (isMonth(k) && typeof v === 'string' && v) monthNotes[k] = v;
    }
    out.funds.push({ id: f.id, name: f.name, opening: int(f.opening) != null && f.opening >= 0 ? f.opening : 0, note: str(f.note), monthNotes, createdAt: int(f.createdAt) || 0 });
  }
  const fundIds = new Set(out.funds.map((f) => f.id));
  for (const m of Array.isArray(data.members) ? data.members : []) {
    if (!m || !str(m.id) || !fundIds.has(m.fundId) || !str(m.name) || !isMonth(m.startMonth)) { dropped++; continue; }
    const pledge = int(m.pledge) != null && m.pledge >= 0 ? m.pledge : 0;
    const endMonth = isMonth(m.endMonth) && m.endMonth >= m.startMonth ? m.endMonth : null;
    out.members.push({ id: m.id, fundId: m.fundId, name: m.name, pledge, startMonth: m.startMonth, endMonth, note: str(m.note), order: int(m.order) || 0, createdAt: int(m.createdAt) || 0 });
  }
  const memberById = new Map(out.members.map((m) => [m.id, m]));
  const seen = new Set();
  for (const r of Array.isArray(data.receipts) ? data.receipts : []) {
    const m: Member | undefined = r && memberById.get(r.memberId);
    const key = r && `${r.memberId}|${r.month}`;
    if (!m || !str(r.id) || !isMonth(r.month) || !isDate(r.date) || !((int(r.amount) ?? 0) > 0) || seen.has(key)) { dropped++; continue; }
    seen.add(key);
    out.receipts.push({ id: r.id, fundId: m.fundId, memberId: r.memberId, month: r.month, amount: r.amount, date: r.date, note: str(r.note), createdAt: int(r.createdAt) || 0 });
  }
  for (const p of Array.isArray(data.payouts) ? data.payouts : []) {
    if (!p || !str(p.id) || !fundIds.has(p.fundId) || !isMonth(p.month) || !isDate(p.date) || !((int(p.amount) ?? 0) > 0)) { dropped++; continue; }
    out.payouts.push({ id: p.id, fundId: p.fundId, month: p.month, date: p.date, amount: p.amount, note: str(p.note), createdAt: int(p.createdAt) || 0 });
  }
  // Backups from before 2.1.0 have no offerings at all.
  const offeringIds = new Set();
  for (const o of Array.isArray(data.offerings) ? data.offerings : []) {
    const lines: OfferingLine[] = o && Array.isArray(o.lines) ? o.lines.filter((l: any) => l && str(l.name) && (int(l.amount) ?? 0) > 0).map((l: any) => ({ name: l.name, amount: l.amount })) : [];
    if (!o || !str(o.id) || offeringIds.has(o.id) || !isDate(o.date) || !str(o.recipient) || !lines.length) { dropped++; continue; }
    offeringIds.add(o.id);
    out.offerings.push({ id: o.id, date: o.date, recipient: o.recipient, lines, dedication: str(o.dedication), note: str(o.note), createdAt: int(o.createdAt) || 0 });
  }
  return { state: out, dropped };
}

// ---------------------------------------------------------------- exports
function csvCell(v: unknown): string {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** Year table as CSV (UTF-8 with BOM so Excel shows Chinese correctly). */
function yearCSV(s: State, fundId: string, year: number): string {
  const fund = getFund(s, fundId);
  const g = yearGrid(s, fundId, year);
  const monthHeads = g.months.map(monthShort);
  const rows: unknown[][] = [];
  rows.push([`${fund ? fund.name : ''} ${year}年`]);
  rows.push(['编号', '名字', '每月', ...monthHeads, '合计']);
  for (const r of g.rows) {
    rows.push([
      r.no,
      r.member.name,
      r.member.pledge ? fmtPlain(r.member.pledge) : '',
      ...r.cells.map((c) => (c.receipt ? fmtPlain(c.receipt.amount) : c.active ? '' : '-')),
      fmtPlain(r.total),
    ]);
  }
  rows.push([]);
  rows.push(['', '收到合计', '', ...g.received.map(fmtPlain), fmtPlain(g.totalReceived)]);
  rows.push(['', '交出', '', ...g.paidOut.map(fmtPlain), fmtPlain(g.totalPaidOut)]);
  rows.push(['', '交钱日期', '', ...g.payouts.map((list) => list.map((p) => p.date).join(' ')), '']);
  rows.push(['', '结余', '', ...g.balance.map(fmtPlain), '']);
  if (g.notes.some(Boolean)) rows.push(['', '备注', '', ...g.notes, '']);
  rows.push([]);
  rows.push(['', `上年结余：${fmtPlain(g.opening)}`]);
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Short month report to paste into WhatsApp. */
function monthShareText(s: State, fundId: string, month: string): string {
  const fund = getFund(s, fundId);
  const cur = s.settings.currency;
  const sm = monthSummary(s, fundId, month);
  const lines = [];
  lines.push(`【${fund ? fund.name : ''}】${monthLabel(month)}`);
  lines.push(`已收 ${sm.receivedCount}/${sm.members.length} 人：${fmtMoney(sm.received, cur)}`);
  if (sm.unpaid.length) lines.push(`未收：${sm.unpaid.map((m) => m.name).join('、')}`);
  for (const p of sm.payouts) lines.push(`交出 ${shortDate(p.date)}：${fmtMoney(p.amount, cur)}${p.note ? '（' + p.note + '）' : ''}`);
  lines.push(`上月结余：${fmtMoney(sm.opening, cur)}`);
  lines.push(`本月结余：${fmtMoney(sm.closing, cur)}`);
  const note = fund && fund.monthNotes && fund.monthNotes[month];
  if (note) lines.push(`备注：${note}`);
  return lines.join('\n');
}

const L = {
  SCHEMA, APP_ID,
  // dates
  todayISO, currentMonth, isMonth, isDate, addMonths, monthsOfYear, monthLabel, monthShort, shortDate,
  // money
  parseAmount, fmtNum, fmtPlain, fmtMoney,
  // state + lookups
  emptyState, getFund, getMember, getPayout, fundMembers, activeIn, receiptOf, memberHasReceipts,
  membersForMonth, payoutsFor, balanceThrough, cashOnHand, prepaidAfter, monthSummary, yearGrid,
  // mutations
  addFund, updateFund, deleteFund, setMonthNote,
  addMember, updateMember, deleteMember, moveMember, parseBulkMembers, addMembersBulk,
  setReceipt, removeReceipt, restoreReceipt, nextUnpaidMonths, prepay,
  addPayout, updatePayout, removePayout, restorePayout,
  // offerings
  getOffering, offeringTotal, offeringsSorted, addOffering, updateOffering, removeOffering, restoreOffering, offeringShareText,
  // io
  backupJSON, normalizeState, yearCSV, monthShareText,
};
export default L;
