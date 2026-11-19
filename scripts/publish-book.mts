/*
 * For the family: put mum's book on the backup server as the shared book, so a new phone can
 * load it with a setup link. See "Putting mum's book on a new phone" in the README.
 *
 *   node scripts/publish-book.mts private/book-2026.json           # check the file; sends nothing
 *   BACKUP_TOKEN=... node scripts/publish-book.mts private/book-2026.json --send
 *
 * The file is a 善款簿 backup. It is checked with the app's own rules first, and is not sent if
 * any record in it would be dropped. Sending needs the family's key for reading backups, in
 * BACKUP_TOKEN. Other settings, also from the environment:
 *
 *   SETUP_CODE     the code to publish under (32 hex digits). Leave it out for a new one. Give
 *                  the same one again to replace the book that phones already have a link for.
 *   BACKUP_SERVER  default https://mum-backup.franklee.asia
 *   APP_URL        default https://mum.franklee.asia
 *
 * The setup link it prints opens the whole book. Send it only to the phone that should have it,
 * and keep the book file itself in private/, which git ignores.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import L from '../lib/model.js';

const args = process.argv.slice(2);
const send = args.includes('--send');
const file = args.find((a) => !a.startsWith('--'));
const stop = (message: string): never => {
  console.error('Stopped: ' + message);
  process.exit(1);
};
if (!file) stop('name the book file, for example: node scripts/publish-book.mts private/book-2026.json');

const text = fs.readFileSync(file!, 'utf8');
let parsed: ReturnType<typeof L.normalizeState>;
try {
  parsed = L.normalizeState(JSON.parse(text));
} catch (e) {
  parsed = stop(`${file} is not a 善款簿 backup (${e instanceof Error ? e.message : e})`);
}
const { state, dropped } = parsed;
if (!state.funds.length) stop('the book has no funds');
if (dropped) stop(`${dropped} records in the book are not valid and would be lost. Fix the file first.`);

console.log(`${file}: ${state.funds.length} funds, ${state.members.length} people, ${state.receipts.length} receipts, ${state.payouts.length} payouts, ${state.offerings.length} offerings`);
for (const fund of state.funds) {
  const people = state.members.filter((m) => m.fundId === fund.id).length;
  console.log(`  ${fund.name}: ${people} people, ${L.fmtMoney(L.cashOnHand(state, fund.id), state.settings.currency)} on hand`);
}

if (!send) {
  console.log('\nNothing was sent. Add --send to publish it.');
  process.exit(0);
}

const token = process.env.BACKUP_TOKEN || stop('set BACKUP_TOKEN to the family key for reading backups');
const code = process.env.SETUP_CODE || crypto.randomBytes(16).toString('hex');
if (!/^[0-9a-f]{32}$/.test(code)) stop('SETUP_CODE must be 32 hex digits');
const server = (process.env.BACKUP_SERVER || 'https://mum-backup.franklee.asia').replace(/\/+$/, '');
const app = (process.env.APP_URL || 'https://mum.franklee.asia').replace(/\/+$/, '');

const res = await fetch(`${server}/book/${code}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: text });
if (!res.ok) stop(`the server answered ${res.status}: ${await res.text()}`);
// Read it back the way a phone will, with the code alone.
const back = await fetch(`${server}/book/${code}`);
if (!back.ok || (await back.text()) !== text) stop(`published, but reading it back with the code gave ${back.status}. Do not hand out the link yet.`);

console.log(`\nPublished on ${server}. The setup link, which opens the whole book:\n\n  ${app}/#/setup/${code}\n`);
console.log('On Android, tap the link on the new phone. On iPhone, open 善款簿 from the home screen, tap the');
console.log('version line in 设置 five times, and paste the link there. A phone that already has records is not changed by the link.');
