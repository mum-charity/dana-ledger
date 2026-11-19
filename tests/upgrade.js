// Checks that a phone already using the plain-JavaScript app (1.6.0) moves to this build safely:
// same records, same folder on the backup server, and it still opens offline afterwards.
// Usage: npm run build && node tests/upgrade.js     (E2E_CHANNEL=chrome uses Chrome instead of Edge)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const OLD_COMMIT = '16eb683'; // 1.6.0, the last version before Next.js
const repo = path.join(__dirname, '..');
const newDir = path.join(repo, 'out');
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dana-ledger-old-'));
execFileSync('sh', ['-c', `git -C "${repo}" archive ${OLD_COMMIT} | tar -x -C "${oldDir}"`]);

let appDir = oldDir;
const backups = [];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/index.html')) { res.writeHead(307, { Location: p.slice(0, -'index.html'.length) }); return res.end(); }
  if (p.startsWith('/backup/')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { if (req.method === 'PUT') backups.push({ path: p, body }); res.writeHead(200); res.end('{}'); });
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(appDir, p);
  if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
  await context.addInitScript(() => { window.LEDGER_BACKUP_SERVER = location.origin; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const text = (sel) => page.locator(sel).first().innerText();
  const backedUp = () => page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('dana-ledger:backup-status')).ok === true && !localStorage.getItem('dana-ledger:backup-pending'); } catch (_) { return false; } }, null, { timeout: 15000 });
  const version = async () => {
    await page.click('text=设置');
    const v = await text('.about');
    await page.click('text=返回');
    await page.waitForSelector('.fund-card');
    return v;
  };

  // --- the old app: make some records
  await page.goto(base);
  await page.click('text=＋ 新增项目');
  await page.fill('input[name=name]', 'Bhante 医疗费用');
  await page.fill('input[name=opening]', '50');
  await page.click('.sheet button[type=submit]');
  await page.click('text=一次添加多人');
  await page.fill('textarea[name=text]', '陈美玲 10\n林志明 20');
  await page.click('[data-role=bulk-submit]');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.click('.tab:has-text("每月")');
  await page.locator('.person', { hasText: '陈美玲' }).locator('.tick').click();
  await page.click('text=返回');
  await page.waitForSelector('.fund-card');
  check((await version()).includes('1.6.0'), 'starts on the old app, 1.6.0');
  const cardBefore = await text('.fund-card');
  check(cardBefore.includes('RM 60'), 'old app shows RM 60 on hand');
  await backedUp();
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
  await page.reload();
  await page.waitForSelector('.fund-card');
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'old service worker controls the page');
  const before = await page.evaluate(() => ({ records: localStorage.getItem('dana-ledger:v1'), device: localStorage.getItem('dana-ledger:device-id') }));
  const sentBefore = backups.length;

  // --- the new build goes up: the open app notices, and one tap moves to it
  appDir = newDir;
  await page.reload();
  await page.waitForSelector('text=善款簿已更新', { timeout: 15000 });
  check(true, 'old app says 善款簿已更新');
  await page.click('.toast-btn');
  await page.waitForSelector('.fund-card');
  const pkgVersion = require(path.join(repo, 'package.json')).version;
  check((await version()).includes(pkgVersion), `now on the new app, ${pkgVersion}`);
  check((await text('.fund-card')) === cardBefore, 'home card is the same as before');
  const after = await page.evaluate(() => ({ records: localStorage.getItem('dana-ledger:v1'), device: localStorage.getItem('dana-ledger:device-id') }));
  check(after.records === before.records, 'saved records are untouched, byte for byte');
  check(after.device === before.device, 'same folder on the backup server');
  const caches_ = await page.evaluate(() => caches.keys());
  check(caches_.length === 1 && caches_[0].startsWith('dana-ledger-' + pkgVersion), 'the old offline cache is gone: ' + caches_.join(', '));

  // --- a new tick in the new app is backed up to the same folder
  await page.click('.fund-card');
  await page.locator('.person', { hasText: '林志明' }).locator('.tick').click();
  await backedUp();
  const last = backups[backups.length - 1];
  check(backups.length > sentBefore && last.path === '/backup/' + before.device, 'new changes go to the same backup folder');
  check(JSON.parse(last.body).data.receipts.length === 2, 'that backup has both receipts');

  // --- and it opens offline
  await context.setOffline(true);
  await page.goto(base);
  await page.waitForSelector('.fund-card', { timeout: 5000 }).catch(() => {});
  check((await page.locator('.fund-card').count()) === 1 && (await text('.fund-card')).includes('RM 80'), 'new app opens offline with RM 80 on hand');
  await context.setOffline(false);

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  server.close();
  fs.rmSync(oldDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
