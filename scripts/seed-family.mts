/*
 * For the family: start the family's shared book on the backup server from a book file, so that
 * the first person to sign in with Google finds mum's records there.
 *
 *   node scripts/seed-family.mts private/book.json           # checks the file; sends nothing
 *   BACKUP_TOKEN=... node scripts/seed-family.mts private/book.json --send
 *
 * It only ever writes the first version. If the family already has a book, it stops and changes
 * nothing: from then on the book is changed by signing in to the app, not from here.
 * Other settings: BACKUP_SERVER (default https://mum-backup.franklee.asia).
 */
import fs from 'node:fs';
import L from '../lib/model.ts';

const args = process.argv.slice(2);
const send = args.includes('--send');
const file = args.find((a) => !a.startsWith('--'));
const stop = (message: string): never => {
  console.error('Stopped: ' + message);
  process.exit(1);
};
if (!file) stop('name the book file, for example: node scripts/seed-family.mts private/book.json');

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
console.log(`${file}: ${state.funds.length} funds, ${state.members.length} people, ${state.receipts.length} receipts, ${state.payouts.length} payouts, ${state.offerings.length} offerings, ${Buffer.byteLength(text)} bytes`);

if (!send) {
  console.log("\nNothing was sent. Add --send to make this the first version of the family's book.");
  process.exit(0);
}
const token = process.env.BACKUP_TOKEN || stop('set BACKUP_TOKEN to the family key for reading backups');
const server = (process.env.BACKUP_SERVER || 'https://mum-backup.franklee.asia').replace(/\/+$/, '');
const auth = { Authorization: `Bearer ${token}` };

const now = await fetch(`${server}/family`, { headers: auth });
const nowText = await now.text();
if (now.status === 200) stop(`the family already has a book, at version ${JSON.parse(nowText).version}. Nothing was changed.`);
if (now.status !== 404) stop(`the server answered ${now.status}: ${nowText}`);

const res = await fetch(`${server}/family/after/0`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: text });
const resText = await res.text();
if (res.status !== 201) stop(`the server answered ${res.status}: ${resText}`);
console.log(`\nThe family's book is started: version ${JSON.parse(resText).version}. Sign in with a family Google account at https://mum.franklee.asia to open it.`);
process.exit(0);
