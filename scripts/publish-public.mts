/*
 * For the family: publish the public accounts (公开账目) at https://mum.franklee.asia/#/public.
 *
 *   node scripts/publish-public.mts private/book.json private/public-funds.json          # shows what the public would see; sends nothing
 *   BACKUP_TOKEN=... node scripts/publish-public.mts private/book.json private/public-funds.json --send
 *
 * The second file says which funds to show and whom each one's money goes to:
 *
 *   { "year": 2026, "notice": "账目从旧簿抄入，正在核对中",
 *     "funds": [ { "name": "护法", "recipient": "Bao Guo Vihara" }, ... ] }
 *
 * Only money totals are published (see server/public-summary.ts): no names, notes or references.
 * The summary is made here first with the same code the server runs, so what is printed is what
 * the public will see. The server makes it again from the book and keeps only the summary.
 * Other settings: BACKUP_SERVER (default https://mum-backup.franklee.asia).
 */
import fs from 'node:fs';
import L from '../lib/model.js';
import { publicSummary, type PublicRequest } from '../server/public-summary.ts';

const args = process.argv.slice(2);
const send = args.includes('--send');
const [bookFile, choiceFile] = args.filter((a) => !a.startsWith('--'));
const stop = (message: string): never => {
  console.error('Stopped: ' + message);
  process.exit(1);
};
if (!bookFile || !choiceFile) stop('usage: node scripts/publish-public.mts <book.json> <public-funds.json> [--send]');

const choice = JSON.parse(fs.readFileSync(choiceFile, 'utf8'));
const request: PublicRequest = { book: JSON.parse(fs.readFileSync(bookFile, 'utf8')), funds: choice.funds, year: choice.year, notice: choice.notice };
let summary: ReturnType<typeof publicSummary>;
try {
  summary = publicSummary(request, Date.now());
} catch (e) {
  summary = stop(e instanceof Error ? e.message : String(e));
}

const rm = (c: number) => L.fmtMoney(c, summary.currency).padStart(12);
console.log(`公开账目 ${summary.year}${summary.notice ? ' · ' + summary.notice : ''}\n`);
console.log(`${'项目'.padEnd(24)}${'名字'.padStart(6)}${'上年留下'.padStart(10)}${'收到'.padStart(10)}${'交出'.padStart(10)}${'手上应有'.padStart(10)}  交给`);
for (const f of summary.funds) {
  console.log(`${f.name.padEnd(24)}${String(f.people).padStart(6)}${rm(f.carriedIn)}${rm(f.received)}${rm(f.paidOut)}${rm(f.onHand)}  ${f.recipient || '—'}`);
}
const text = JSON.stringify(summary);
for (const bad of [/\d{9,}/, /Ref|R\/N|备注/i]) if (bad.test(text)) stop(`the summary contains something that looks like a reference (${bad}); not publishing`);

if (!send) {
  console.log('\nNothing was sent. Add --send to publish it for everyone.');
  process.exit(0);
}
const token = process.env.BACKUP_TOKEN || stop('set BACKUP_TOKEN to the family key for reading backups');
const server = (process.env.BACKUP_SERVER || 'https://mum-backup.franklee.asia').replace(/\/+$/, '');
const res = await fetch(`${server}/public`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(request) });
if (!res.ok) stop(`the server answered ${res.status}: ${await res.text()}`);
await res.text();
// Read it back the way a visitor's browser will. The reply is read to the end so Node can exit.
const back = await fetch(`${server}/public`);
const backText = await back.text();
let fundsBack = -1;
try {
  fundsBack = JSON.parse(backText).funds.length;
} catch (_) { /* reported below */ }
if (!back.ok || fundsBack !== summary.funds.length) stop(`published, but reading it back gave ${back.status} with ${fundsBack} funds`);
console.log(`\nPublished. Anyone can now see it at https://mum.franklee.asia/#/public`);
process.exit(0);
