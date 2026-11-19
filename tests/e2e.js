// End-to-end check of 善款簿 on a phone-sized viewport using an installed browser.
// Usage: npm install && npm run test:e2e   (Edge by default; E2E_CHANNEL=chrome uses Chrome)
// The clock is fixed to 6 Nov 2026 so the month/balance assertions are stable.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

// Serves the built app in out/ (npm run build), or another folder given as the first argument.
const appDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'out'));
const shotDir = path.resolve(process.argv[3] || path.join(__dirname, '..', '.e2e-out'));
fs.mkdirSync(shotDir, { recursive: true });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Redirect /index.html to / as Cloudflare does, so a service worker that caches the redirect fails here too.
  if (p.endsWith('/index.html')) { res.writeHead(307, { Location: p.slice(0, -'index.html'.length) }); return res.end(); }
  // Stands in for the backup server, and keeps what the app sent.
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

const backups = []; // every PUT /backup/<id> the app made
let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN', acceptDownloads: true });
  await context.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
  // Keep the test's made-up records away from the real backup server.
  await context.addInitScript(() => { window.LEDGER_BACKUP_SERVER = location.origin; });
  const page = await context.newPage();
  const outside = []; // requests to anywhere but the test server
  context.on('request', (r) => { if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) outside.push(r.url()); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // While offline the browser logs each backup attempt that can't connect. That one is expected;
  // the offline section checks separately that nothing else was fetched.
  let offline = false;
  page.on('console', (m) => { if (m.type() === 'error' && !(offline && m.text().includes('ERR_INTERNET_DISCONNECTED'))) errors.push(m.text()); });
  const shot = (name) => page.screenshot({ path: path.join(shotDir, name + '.png'), fullPage: true, animations: 'disabled' });
  const text = (sel) => page.locator(sel).first().innerText();

  await page.goto(base);
  await page.waitForSelector('.empty');
  await shot('01-home-empty');
  check(await page.locator('text=欢迎使用善款簿').isVisible(), 'empty home shows welcome');

  // --- create fund
  await page.click('text=＋ 新增项目');
  await page.fill('input[name=name]', 'Bhante 医疗费用');
  await page.fill('input[name=opening]', '50');
  await shot('02-fund-sheet');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.tab[aria-current=page]:has-text("名单")');
  check(page.url().includes('/p'), 'after creating fund, lands on 名单');

  // --- bulk add three people from January
  await page.click('text=一次添加多人');
  await page.fill('textarea[name=text]', '1 陈美玲 10\n2 林志明、黄淑芬 20\n王小华');
  await page.selectOption('select[name=startMonth]', '2026-01');
  check((await text('[data-role=bulk-submit]')) === '添加 3 人', 'bulk preview counts 3 people');
  await shot('03-bulk-sheet');
  await page.click('[data-role=bulk-submit]');
  await page.waitForSelector('.sheet', { state: 'detached' });

  // --- add one person Apr–Aug
  await page.click('text=＋ 添加一人');
  await page.fill('input[name=name]', 'Tan Ah Kow 合家');
  await page.fill('input[name=pledge]', '10');
  await page.selectOption('select[name=startMonth]', '2026-04');
  await page.selectOption('select[name=endMonth]', '2026-08');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.sheet', { state: 'detached' });
  check((await page.locator('.roster-item').count()) === 4, 'roster has 4 people');
  await shot('04-people');

  // --- month page (current month = Nov 2026 in this test run)
  await page.click('.tab:has-text("每月")');
  await page.waitForSelector('.people');
  const month = await text('.period-title');
  console.log('  month page:', month);
  check((await page.locator('.person').count()) === 3, 'Tan Ah Kow (Apr–Aug) not listed in Nov');

  // quick pay + undo
  const row1 = page.locator('.person', { hasText: '陈美玲' });
  await row1.locator('.tick').click();
  await page.waitForSelector('#toast.show');
  check(await row1.locator('.tick.is-paid').isVisible(), 'one tap marks 陈美玲 paid');
  await page.click('.toast-btn');
  check(!(await page.locator('.person', { hasText: '陈美玲' }).locator('.tick.is-paid').count()), 'undo removes the tick');
  await page.locator('.person', { hasText: '陈美玲' }).locator('.tick').click();

  // variable amount person opens sheet
  await page.locator('.person', { hasText: '王小华' }).locator('.tick').click();
  await page.waitForSelector('.sheet input[name=amount]');
  await page.fill('.sheet input[name=amount]', '29');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.sheet', { state: 'detached' });

  // payout
  await page.click('text=＋ 记录交钱 / 支出');
  await page.waitForSelector('.sheet [data-role=month-hint]');
  check((await text('.sheet [data-role=month-hint]')).includes('RM 39'), 'payout sheet shows month received RM 39');
  await page.fill('.sheet input[name=amount]', '30');
  await page.fill('.sheet input[name=note]', '交给 Bhante');
  await shot('05-payout-sheet');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.sheet', { state: 'detached' });

  // back button closes a sheet without leaving the page
  await page.locator('.person', { hasText: '陈美玲' }).locator('.person-main').click();
  await page.waitForSelector('.sheet');
  await shot('06-receipt-edit-sheet');
  await page.goBack();
  await page.waitForSelector('.sheet', { state: 'detached' });
  check(page.url().includes('/m/'), 'phone back button closes the sheet and stays on month page');

  // prepay a full year for 林志明 starting January
  await page.click('.period-btn[aria-label=上个月]');
  for (let i = 0; i < 9; i++) await page.click('.period-btn[aria-label=上个月]');
  check((await text('.period-title')) === '2026年1月', 'navigated to Jan 2026');
  await page.locator('.person', { hasText: '林志明' }).locator('.person-main').click();
  await page.waitForSelector('.sheet .stepper');
  for (let i = 0; i < 11; i++) await page.click('.sheet .step[data-d="1"]');
  const hint = await text('.sheet [data-role=count-hint]');
  console.log('  prepay hint:', hint);
  check(hint.includes('共 12 个月') && hint.includes('RM 240'), 'prepay hint shows 12 months, RM 240');
  await page.fill('.sheet input[name=note]', '已付全年');
  await shot('07-prepay-sheet');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.click('text=回到本月');

  const summary = await text('.summary');
  console.log('  Nov summary:', summary.replace(/\s+/g, ' '));
  check(summary.includes('RM 59') && summary.includes('3 / 3 人'), 'Nov received RM 59 from 3/3');
  check(summary.includes('RM 250') && summary.includes('RM 279'), 'Nov opening RM 250, closing RM 279');
  check(summary.includes('RM 20 是预先付了'), 'prepaid Dec RM 20 noted');
  await shot('08-month');

  // --- year grid
  await page.click('.tab:has-text("全年表")');
  await page.waitForSelector('.grid');
  const balRow = await page.locator('.bal-row td').allInnerTexts();
  console.log('  balance row:', balRow.join(' | '));
  check(JSON.stringify(balRow.slice(0, 12)) === JSON.stringify(['70', '90', '110', '130', '150', '170', '190', '210', '230', '250', '279', '']), 'year 结余 row matches hand calculation');
  const sumRow = await page.locator('.sum-row td').allInnerTexts();
  check(sumRow[10] === '59' && sumRow[12] === '279', 'Nov total 59, year total 279');
  const chinRow = await page.locator('tbody tr', { hasText: 'Tan Ah Kow' }).locator('td').allInnerTexts();
  check(chinRow[0] === '–' && chinRow[3] === '' && chinRow[8] === '–', 'Tan Ah Kow: – before Apr and after Aug');
  const yt = await text('.year-totals');
  check(yt.includes('RM 299'), 'year-end balance RM 299');
  await shot('09-year');

  // CSV export downloads. Desktop Edge can "share" CSV files, which hangs headless,
  // so force the download fallback that phones without file sharing use.
  await page.evaluate(() => { navigator.canShare = () => false; });
  const [csvDl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.click('text=导出 Excel 表格')]);
  if (csvDl) {
    const csvPath = path.join(shotDir, 'export.csv');
    await csvDl.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    check(csv.charCodeAt(0) === 0xfeff && csv.includes('陈美玲'), 'CSV download has BOM and names');
  } else check(false, 'CSV download happened');

  // --- home
  await page.click('text=返回');
  await page.waitForSelector('.fund-card');
  const card = await text('.fund-card');
  check(card.includes('RM 299'), 'home card shows cash on hand RM 299');
  check(card.includes('3') && card.includes('/ 3 人'), 'home card shows 3/3 paid');
  await shot('10-home');

  // --- reload: data persists, service worker controls the page
  await page.reload();
  await page.waitForSelector('.fund-card');
  check((await text('.fund-card')).includes('RM 299'), 'data persists after reload');
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 10000 }).catch(() => {});
  check(await page.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)), 'service worker controls the page');

  // offline
  await context.setOffline(true);
  offline = true;
  await page.reload();
  await page.waitForSelector('.fund-card', { timeout: 5000 }).catch(() => {});
  check(await page.locator('.fund-card').isVisible(), 'app opens offline');
  // Offline, every screen still works and nothing is fetched except the backup attempts.
  const failed = [];
  const onFailed = (r) => { if (!new URL(r.url()).pathname.startsWith('/backup/')) failed.push(r.url()); };
  page.on('requestfailed', onFailed);
  await page.click('.fund-card');
  await page.waitForSelector('.people');
  await page.locator('.person', { hasText: '陈美玲' }).locator('.person-main').click();
  await page.waitForSelector('.sheet');
  await page.goBack();
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.click('text=＋ 记录交钱 / 支出');
  await page.fill('.sheet input[name=amount]', '1');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.click('.prow:has-text("交钱")');
  await page.waitForSelector('[data-action=payout-delete]');
  await page.click('[data-action=payout-delete]');
  await page.click('[data-action=confirm-yes]');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.click('.tab:has-text("全年表")');
  await page.waitForSelector('.grid');
  await page.click('.tab:has-text("名单")');
  await page.waitForSelector('.roster');
  await page.click('text=返回');
  await page.waitForSelector('.fund-card');
  check((await text('.fund-card')).includes('RM 299'), 'offline: fund pages, sheets, saving and 返回 all work');
  check(failed.length === 0, 'offline: the app fetched nothing' + (failed.length ? ': ' + failed.join(' | ') : ''));
  page.off('requestfailed', onFailed);
  offline = false;
  await context.setOffline(false);

  // --- automatic backup: the records reach the backup server by themselves
  await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem('dana-ledger:backup-status')).ok === true; } catch (_) { return false; } }, null, { timeout: 15000 }).catch(() => {});
  const sent = backups[backups.length - 1];
  const deviceId = await page.evaluate(() => localStorage.getItem('dana-ledger:device-id'));
  check(!!sent && sent.path === '/backup/' + deviceId && /^[0-9a-f]{32}$/.test(deviceId), "records were sent to this phone's folder on the backup server");
  if (sent) {
    const bkPath = path.join(shotDir, 'backup.json');
    fs.writeFileSync(bkPath, sent.body);
    const data = JSON.parse(sent.body);
    check(data.app === 'dana-ledger' && data.data.receipts.length === 14, 'the backup has 14 receipts');

    // --- restore: wipe the phone, open the hidden 恢复记录 screen, load the backup, everything comes back
    await page.evaluate(() => localStorage.clear());
    await page.goto(base);
    await page.waitForSelector('text=欢迎使用善款簿');
    check(!(await page.locator('.fund-card').count()), 'wiped storage shows empty app');
    await page.click('text=设置');
    await page.waitForSelector('.about');
    for (let i = 0; i < 5; i++) await page.click('.about');
    await page.waitForSelector('text=从备份文件恢复');
    check(page.url().includes('#/restore'), 'five taps on the version line open 恢复记录');
    await shot('11-restore');
    await page.setInputFiles('#restore-file', bkPath);
    await page.waitForSelector('.confirm');
    check((await text('.confirm')).includes('14 笔收款'), 'restore confirm shows what is in the backup');
    await page.click('[data-action=confirm-yes]');
    await page.waitForSelector('.fund-card');
    check((await text('.fund-card')).includes('RM 299'), 'restore brings back cash on hand RM 299');
    await page.reload();
    await page.waitForSelector('.fund-card');
    check((await text('.fund-card')).includes('RM 299'), 'restored data survives reload');
  }
  await page.click('text=设置');
  await page.waitForSelector('[data-size=xlarge]');

  // --- font size: xlarge month page
  await page.click('[data-size=xlarge]');
  await page.click('text=返回');
  await page.click('.fund-card');
  await page.waitForSelector('.people');
  await shot('12-month-xlarge');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no horizontal page scroll at extra-large text');

  // --- dark mode
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('[data-size=large]').catch(() => {});
  await shot('13-month-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // --- desktop: the same app on a wide screen gets the funds down the side and two columns
  check(!(await page.locator('.sidebar').isVisible()), 'phone width: no side list');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForSelector('.sidebar', { state: 'visible' });
  check(!(await page.locator('.topbar-settings').isVisible()), 'desktop: 设置 is in the side list, not the top bar');
  await page.locator('.sidebar .side-link', { hasText: 'Bhante 医疗费用' }).click();
  await page.waitForSelector('.people');
  const list = await page.locator('.month-list').boundingBox();
  const aside = await page.locator('.month-aside').boundingBox();
  check(!!list && !!aside && aside.x >= list.x + list.width, 'desktop: month page has the people on the left and 交钱 on the right');
  await page.locator('.person .person-main').first().click();
  await page.waitForSelector('#sheet.open .sheet');
  const dlg = await page.locator('.sheet').boundingBox();
  check(dlg.y > 0 && dlg.y + dlg.height < 800 && Math.abs(dlg.x + dlg.width / 2 - 640) < 2, 'desktop: the sheet is a dialog in the middle');
  await shot('30-desktop-month-sheet');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sheet', { state: 'detached' });
  await shot('31-desktop-month');
  await page.click('.tab:has-text("全年表")');
  await page.waitForSelector('.grid');
  await shot('32-desktop-year');
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'desktop: no horizontal page scroll');
  await page.setViewportSize({ width: 390, height: 844 });

  check(outside.length === 0, 'nothing was sent outside the test server' + (outside.length ? ': ' + outside.join(' | ') : ''));
  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
