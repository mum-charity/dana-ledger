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
  if (p === '/session' || p.startsWith('/family')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
      if (p === '/session') {
        const { credential, nonce } = JSON.parse(body);
        const claims = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString());
        if (claims.nonce !== nonce) return send(401, { error: 'sign-in not accepted' });
        if (!FAMILY.includes(claims.email)) return send(403, { error: 'not on the family list' });
        return send(200, { session: 'session-of-' + claims.email, email: claims.email, expiresAt: Date.parse('2027-06-01') });
      }
      // The family's book: numbered versions, and a write only from whoever has seen the newest.
      const who = /^Bearer session-of-(.+)$/.exec(req.headers.authorization || '');
      if (!who || !FAMILY.includes(who[1])) return send(401, { error: 'sign in' });
      const after = /^\/family\/after\/(\d+)$/.exec(p);
      const head = familyVersions.length;
      if (req.method === 'GET') {
        if (!head) return send(404, { error: 'no family book yet' });
        if (after && +after[1] === head) return send(200, { version: head, unchanged: true });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(`{"version":${head},"book":${familyVersions[head - 1]}}`);
      }
      if (!after || +after[1] !== head) return send(409, { version: head });
      familyVersions.push(body);
      return send(201, { version: head + 1 });
    });
    return;
  }
  // The public accounts: totals only, as the backup server makes them.
  if (p === '/public') {
    res.writeHead(publicAccounts ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(publicAccounts ? JSON.stringify(publicAccounts) : '{"error":"nothing published yet"}');
  }
  // The family's book, published under a setup code: only that code opens it.
  if (p.startsWith('/book/')) {
    const found = req.method === 'GET' && p === '/book/' + SETUP_CODE && sharedBook;
    res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(found ? sharedBook : '{"error":"no book under this code"}');
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(appDir, p);
  if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

// A stand-in for Google's sign-in page, at an address of its own as the real one is (the app's
// offline cache answers every page at the app's own address). It sends the browser straight back
// with a token for whichever account the test "chose"; the stand-in server above takes it on trust.
const fakeGoogle = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const claims = Buffer.from(JSON.stringify({ email: googleAccount, nonce: q.get('nonce'), aud: q.get('client_id') })).toString('base64url');
  res.writeHead(302, { Location: `${q.get('redirect_uri')}#id_token=h.${claims}.s&authuser=0&prompt=none` });
  res.end();
});

const backups = []; // every PUT /backup/<id> the app made
const SETUP_CODE = '5e7'.padEnd(32, 'c'); // a setup code, as the family would make
let sharedBook = null; // the book the family published under it
let publicAccounts = null; // what GET /public answers
const FAMILY = ['mum@example.com', 'son@example.com']; // the Google accounts on the family list
let googleAccount = 'mum@example.com'; // the account "chosen" at the stand-in for Google
const familyVersions = []; // every version of the family's shared book, oldest first
const months2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
const PUBLIC_FIXTURE = {
  app: 'dana-ledger-public', version: 1, updatedAt: '2026-11-19T04:00:00.000Z', currency: 'RM', year: 2026, notice: '账目从旧簿抄入，正在核对中',
  funds: [{
    name: '公开测试项目', recipient: 'Bao Guo Vihara', people: 12, carriedIn: 0, received: 36000, paidOut: 30000, onHand: 6000,
    months: months2026.map((month, i) => ({ month, received: i < 3 ? 12000 : 0, paidOut: i === 1 ? 30000 : 0, balance: i === 0 ? 12000 : 6000 })),
    payouts: [{ date: '2026-02-28', amount: 30000 }],
  }],
};
let failures = 0;
function check(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/`;
  await new Promise((r) => fakeGoogle.listen(0, r));
  const googleUrl = `http://localhost:${fakeGoogle.address().port}/auth`;
  const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'msedge' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN', acceptDownloads: true });
  await context.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
  // Keep the test's made-up records away from the real backup server.
  const pointAtTestServer = (google) => { window.LEDGER_BACKUP_SERVER = location.origin; window.LEDGER_GOOGLE_AUTH = google; };
  await context.addInitScript(pointAtTestServer, googleUrl);
  const page = await context.newPage();
  const outside = []; // requests to anywhere but the test server
  const isOutside = (url) => /^https?:/.test(url) && !url.startsWith(base) && !url.startsWith(googleUrl);
  context.on('request', (r) => { if (isOutside(r.url())) outside.push(r.url()); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // While offline the browser logs each backup attempt that can't connect. That one is expected;
  // the offline section checks separately that nothing else was fetched.
  let offline = false;
  // The browser reports a 404 as an error; the one the wrong setup code is meant to get is not a fault.
  // So is the public page's, before anything has been published.
  const wrongCode404 = (m) => (m.location().url || '').endsWith('/book/' + 'd'.repeat(32)) || (!publicAccounts && (m.location().url || '').endsWith('/public'));
  page.on('console', (m) => { if (m.type() === 'error' && !(offline && m.text().includes('ERR_INTERNET_DISCONNECTED')) && !wrongCode404(m)) errors.push(m.text()); });
  const shot = (name) => page.screenshot({ path: path.join(shotDir, name + '.png'), fullPage: true, animations: 'disabled' });
  const text = (sel) => page.locator(sel).first().innerText();

  // A visitor with no records, not signed in, gets the public accounts and the family's sign-in.
  await page.goto(base);
  await page.waitForSelector('[data-role=family-sign-in]');
  check(await page.locator('[data-page=public]').isVisible() && !(await page.locator('text=欢迎使用善款簿').count()), 'an empty browser that is not signed in shows the public accounts, with the family sign-in');
  // Starting a book on this device without signing in is still possible.
  await page.click('[data-action=start-new]');
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
    await page.goto('about:blank');
    await page.goto(base + '#/new');
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

    // --- setup link: the family publishes her book under a code; an empty phone opened with the link loads it
    sharedBook = sent.body;
    const receiptsOnPhone = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('dana-ledger:v1')).receipts.length; } catch (_) { return 0; } });
    const freshPhone = async (hash) => {
      await page.evaluate(() => localStorage.clear());
      await page.goto('about:blank'); // so the app starts again, as when a link is tapped in WhatsApp
      await page.goto(base + hash);
    };
    await freshPhone('#/setup/' + 'd'.repeat(32));
    await page.waitForSelector('#toast:has-text("没能载入记录")');
    check(!(await page.locator('.fund-card').count()) && (await text('#toast')).includes('设置码不对'), 'a setup link with the wrong code loads nothing and says so');
    check(!page.url().includes('d'.repeat(32)), 'the code is taken out of the address');

    await freshPhone('#/setup/' + SETUP_CODE);
    await page.waitForSelector('.fund-card');
    check((await text('.fund-card')).includes('RM 299') && (await receiptsOnPhone()) === 14, 'an empty phone opened with the setup link loads the book: RM 299, 14 receipts');
    check(!page.url().includes(SETUP_CODE) && !(await page.evaluate(() => JSON.stringify(localStorage))).includes('5e7ccc'), 'the setup code is not left in the address or kept on the phone');
    await shot('11b-setup-link');
    const uploadsBefore = backups.length;
    for (let i = 0; i < 100 && backups.length === uploadsBefore; i++) await page.waitForTimeout(100);
    const newId = await page.evaluate(() => localStorage.getItem('dana-ledger:device-id'));
    check(backups.length > uploadsBefore && backups[backups.length - 1].path === '/backup/' + newId && newId !== deviceId, 'the phone then backs the book up as its own, under a new id');
    await page.reload();
    await page.waitForSelector('.fund-card');
    check((await receiptsOnPhone()) === 14, 'the loaded book survives reload');

    // A phone that already has records is left alone by the link.
    await page.click('.fund-card');
    await page.waitForSelector('.people');
    await page.evaluate((code) => { location.hash = '#/setup/' + code; }, SETUP_CODE);
    await page.waitForSelector('#toast:has-text("已经有记录")');
    check((await receiptsOnPhone()) === 14 && !page.url().includes(SETUP_CODE), 'the setup link changes nothing on a phone that already has records');

    // From 恢复记录 the family can paste the whole link; a phone with records is asked first.
    await page.goto(base + '#/restore');
    await page.waitForSelector('[data-action=load-book]');
    await page.fill('input[name=code]', 'not a code');
    await page.click('[data-action=load-book]');
    await page.waitForSelector('#toast:has-text("请贴上")');
    await page.fill('input[name=code]', '妈妈的记录： ' + base + '#/setup/' + SETUP_CODE.toUpperCase());
    await page.click('[data-action=load-book]');
    await page.waitForSelector('.confirm');
    check((await text('.confirm')).includes('14 笔收款'), 'pasting the setup link in 恢复记录 asks before replacing the records');
    await page.click('[data-action=confirm-yes]');
    await page.waitForSelector('.fund-card');
    check((await text('.fund-card')).includes('RM 299'), 'and then loads the book');
  }
  await page.click('text=设置');
  await page.waitForSelector('[data-size=xlarge]');

  // --- 公开账目: a visitor with an empty browser sees the published totals, and none of this phone's funds
  {
    const pub = await context.newPage();
    await pub.goto(base + '#/public');
    await pub.waitForSelector('[data-role=public-error]');
    check((await pub.textContent('[data-role=public-error]')).includes('还没有公开的账目'), 'public page says when nothing is published yet');
    publicAccounts = PUBLIC_FIXTURE;
    await pub.reload();
    await pub.waitForSelector('[data-role=public-fund]');
    const shown = await pub.textContent('main');
    check(shown.includes('公开测试项目') && shown.includes('RM 360') && shown.includes('RM 300') && shown.includes('RM 60') && shown.includes('Bao Guo Vihara') && shown.includes('12 个名字'), 'public page shows a fund with money in, handed over, on hand and to whom');
    check(shown.includes('正在核对中'), "public page shows the family's notice");
    check(!(await pub.locator('.sidebar').count()) && !shown.includes('RM 299'), "public page shows no sidebar and none of this browser's own funds");
    await pub.click('summary');
    check((await pub.textContent('details')).includes('28/2/2026'), 'public page lists the date of each hand-over');
    await pub.setViewportSize({ width: 360, height: 740 });
    check(!(await pub.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'public page has no sideways scroll on a phone');
    await pub.screenshot({ path: path.join(shotDir, '11c-public.png'), fullPage: true });
    await pub.close();
  }

  // --- the family signs in with Google: two devices, one book
  if (sent) {
    familyVersions.push(sent.body); // the family's book as seeded: 14 receipts, RM 299 on hand
    const device = async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
      await ctx.clock.setFixedTime(new Date('2026-11-06T10:00:00'));
      await ctx.addInitScript(pointAtTestServer, googleUrl);
      ctx.on('request', (r) => { if (isOutside(r.url())) outside.push(r.url()); });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push(e.message));
      pg.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|403/.test(m.text())) errors.push(m.text()); });
      return pg;
    };
    const onHand = (pg) => pg.locator('.fund-card').first().innerText();
    const stored = (pg, key) => pg.evaluate((k) => localStorage.getItem(k), key);
    const signIn = async (pg, email) => {
      googleAccount = email;
      await pg.click('[data-action=google-sign-in]');
    };
    /** Record money handed over, from the fund's month page. */
    const handOver = async (pg, amount) => {
      await pg.click('.fund-card');
      await pg.click('text=＋ 记录交钱 / 支出');
      await pg.fill('.sheet input[name=amount]', String(amount));
      await pg.click('.sheet button[type=submit]');
      await pg.waitForSelector('.sheet', { state: 'detached' });
      await pg.click('text=返回');
      await pg.waitForSelector('.fund-card');
    };
    /** What the app does when it comes back into view: look for the family's changes. */
    const comeBack = (pg) => pg.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const until = async (cond, what) => {
      for (let i = 0; i < 150 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 100));
      check(await cond(), what);
    };

    const phone = await device();
    await phone.goto(base);
    await phone.waitForSelector('[data-role=family-sign-in]');

    // A Google account that is not family signs in at Google fine, and gets nothing here.
    await signIn(phone, 'stranger@example.com');
    await phone.waitForSelector('#toast:has-text("不在家人名单")');
    check(!(await phone.locator('.fund-card').count()) && !(await stored(phone, 'dana-ledger:session')), 'a Google account that is not on the family list gets no records and no session');
    check(!phone.url().includes('id_token') && (await phone.locator('[data-page=public]').isVisible()), 'and is left on the public accounts, with the token gone from the address');

    // Mum signs in on her phone: the family's book loads, with nothing to paste or tap.
    await signIn(phone, 'mum@example.com');
    await phone.waitForSelector('.fund-card');
    check((await onHand(phone)).includes('RM 299'), 'a family member who signs in on an empty phone gets the family book: RM 299');
    check(!phone.url().includes('id_token') && !(await phone.evaluate(() => JSON.stringify(history.state) + document.referrer)).includes('id_token'), "Google's token is not left in the address");
    await phone.waitForSelector('[data-role=sync-line][data-sync=ok]');
    await phone.screenshot({ path: path.join(shotDir, '11d-signed-in.png'), fullPage: true });
    await phone.reload();
    await phone.waitForSelector('.fund-card');
    check(JSON.parse(await stored(phone, 'dana-ledger:session')).email === 'mum@example.com' && (await onHand(phone)).includes('RM 299'), 'she stays signed in after closing and opening the app');

    // Her son signs in on his computer and sees the same book.
    const laptop = await device();
    await laptop.goto(base);
    await laptop.waitForSelector('[data-role=family-sign-in]');
    await signIn(laptop, 'son@example.com');
    await laptop.waitForSelector('.fund-card');
    check((await onHand(laptop)).includes('RM 299') && familyVersions.length === 1, 'a second device signs in and shows the same book; nothing was written by just looking');

    // She hands over RM 9 on the phone. It reaches the server, then the laptop.
    await handOver(phone, 9);
    await until(() => familyVersions.length === 2, "a change on the phone becomes version 2 of the family's book");
    await comeBack(laptop);
    await until(async () => (await onHand(laptop)).includes('RM 290'), 'the laptop shows the change when it next looks: RM 290');
    // And the other way.
    await handOver(laptop, 5);
    await until(() => familyVersions.length === 3, 'a change on the laptop becomes version 3');
    await comeBack(phone);
    await until(async () => (await onHand(phone)).includes('RM 285'), 'the phone shows it: RM 285');

    // Both change things with no signal. When it comes back, both changes are in the book.
    await phone.context().setOffline(true);
    await laptop.context().setOffline(true);
    await handOver(phone, 1);
    await handOver(laptop, 2);
    check((await onHand(phone)).includes('RM 284') && (await onHand(laptop)).includes('RM 283'), 'with no signal each device keeps working on its own records');
    await phone.waitForSelector('[data-role=sync-line][data-sync=error], [data-role=sync-line][data-sync=pending]');
    await phone.context().setOffline(false);
    await laptop.context().setOffline(false);
    await comeBack(phone);
    await until(() => familyVersions.length === 4, "the phone's offline change goes up first");
    await comeBack(laptop);
    await until(() => familyVersions.length === 5, "the laptop combines it with its own and sends both: version 5");
    await comeBack(phone);
    await until(async () => (await onHand(phone)).includes('RM 282') && (await onHand(laptop)).includes('RM 282'), "both devices end with both changes: RM 282");
    const newest = JSON.parse(familyVersions[familyVersions.length - 1]).data;
    check(newest.payouts.length === JSON.parse(sent.body).data.payouts.length + 4 && newest.receipts.length === 14, "the family's book has all four hand-overs and still 14 receipts");

    // The phone that already has records of its own (this test's first phone) is asked before they are set aside.
    await page.goto('about:blank');
    await page.goto(base);
    await page.waitForSelector('[data-role=sign-in-card]');
    await signIn(page, 'mum@example.com');
    await page.waitForSelector('.confirm');
    check((await text('.confirm')).includes('14 笔收款') && (await text('.confirm')).includes('收起来'), 'a device with its own records is asked before they are replaced by the family book');
    await page.click('.confirm [data-action=confirm-no]');
    await page.waitForSelector('#toast:has-text("保留自己的记录")');
    check((await text('.fund-card')).includes('RM 299') && !(await stored(page, 'dana-ledger:session')) && familyVersions.length === 5, 'saying no keeps its records, signs it out, and sends nothing');

    // Restoring an old backup on a signed-in device must not become the family's book: the
    // device leaves the shared book, and nothing is sent.
    const before = familyVersions.length;
    await phone.goto(base + '#/restore');
    await phone.waitForSelector('[data-action=restore]');
    await phone.setInputFiles('#restore-file', path.join(shotDir, 'backup.json'));
    await phone.waitForSelector('.confirm');
    check((await phone.locator('.confirm').innerText()).includes('登出'), 'restoring on a signed-in device says it will leave the shared book');
    await phone.click('.confirm [data-action=confirm-yes]');
    await phone.waitForSelector('.fund-card');
    await comeBack(phone);
    await phone.waitForTimeout(2500);
    check((await onHand(phone)).includes('RM 299') && !(await stored(phone, 'dana-ledger:session')) && !(await stored(phone, 'dana-ledger:sync')), 'the restored device is signed out and has forgotten its last sync');
    check(familyVersions.length === before && JSON.parse(familyVersions[before - 1]).data.payouts.length === newest.payouts.length, "and the family's book is untouched by the restore");
    // Signing in again asks before putting the family's book back.
    await signIn(phone, 'mum@example.com');
    await phone.waitForSelector('.confirm');
    await phone.click('.confirm [data-action=confirm-yes]');
    await until(async () => (await onHand(phone)).includes('RM 282'), 'signing in again asks, then brings back the family book: RM 282');
    check(familyVersions.length === before, 'still nothing written');

    // Signing out: the records stay on the device and stop following the family's.
    await laptop.click('text=设置');
    await laptop.click('[data-action=sign-out]');
    await laptop.click('.confirm [data-action=confirm-yes]');
    await laptop.waitForSelector('[data-role=account-card] [data-action=google-sign-in]');
    await laptop.click('text=返回');
    check((await onHand(laptop)).includes('RM 282') && !(await stored(laptop, 'dana-ledger:session')), 'after signing out the records are still on the device');
    await phone.context().close();
    await laptop.context().close();
    // Back to where the first phone was, for the checks that follow.
    await page.click('text=设置');
    await page.waitForSelector('[data-size=xlarge]');
  }

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

  // --- 供养记录: a day's offering with who gave what; the next one starts with the same names
  await page.goto(base + '#/');
  await page.waitForSelector('.fund-card');
  const cashBefore = await text('.fund-card');
  await page.click('[data-action=offerings-open]');
  await page.waitForSelector('[data-action=offering-new]');
  check((await text('.page-offerings')).includes('不会影响'), 'empty 供养记录 explains itself');
  await page.click('[data-action=offering-new]');
  await page.waitForSelector('.sheet [name=recipient]');
  await page.fill('.sheet [name=date]', '2026-11-05');
  await page.fill('.sheet [name=recipient]', '法悦林僧团午餐');
  const fillRow = async (i, name, amount) => {
    await page.locator('[data-role=oline-name]').nth(i).fill(name);
    await page.locator('[data-role=oline-amount]').nth(i).fill(amount);
  };
  await fillRow(0, '吴晶晶', '1');
  await fillRow(1, '吴美璇', '7.90');
  await page.locator('[data-role=oline-name]').nth(2).fill('今天没出的人');
  await page.click('[data-action=oline-add]');
  await fillRow(3, '李伟铨', '10');
  check((await text('[data-role=offering-total]')).includes('18.90'), 'the form adds the amounts up as she types');
  await page.fill('.sheet [name=dedication]', '吴门历代祖先\n十方法界一切众生');
  await shot('40-offering-form');
  await page.click('.sheet button[type=submit]');
  await page.waitForSelector('.offering-row');
  check((await text('.offering-row')).includes('法悦林僧团午餐') && (await text('.offering-row')).includes('RM 18.90') && (await text('.offering-row')).includes('3 人'), 'the offering is listed with its total and 3 people');
  await shot('41-offerings');
  await page.click('[data-action=offering-new]');
  await page.waitForSelector('.sheet [name=recipient]');
  const prefilled = await page.locator('[data-role=oline-name]').evaluateAll((els) => els.map((e) => e.value));
  const emptyAmounts = await page.locator('[data-role=oline-amount]').evaluateAll((els) => els.every((e) => e.value === ''));
  check(prefilled.join() === '吴晶晶,吴美璇,李伟铨' && emptyAmounts, 'a new offering starts with last time\'s names and no amounts');
  check((await page.inputValue('.sheet [name=dedication]')).includes('十方法界一切众生'), 'and with last time\'s dedication');
  await page.fill('.sheet [name=recipient]', 'Wat');
  await page.click('.sheet button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.form-error').innerText.includes('至少'), null, { timeout: 5000 }).catch(() => {});
  check((await text('.form-error')).includes('至少'), 'saving with no amounts is refused');
  await page.keyboard.press('Escape'); // the form is scrolled to the bottom here, so close it from the keyboard
  await page.waitForSelector('.sheet', { state: 'detached' });
  await page.locator('.offering-row').first().click();
  await page.waitForSelector('[data-action=offering-delete]');
  await page.locator('[data-role=oline-amount]').nth(0).fill('2');
  await page.click('.sheet button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.offering-row') && document.querySelector('.offering-row').innerText.includes('19.90'));
  check(true, 'changing an amount changes the total to RM 19.90');
  await page.goto(base + '#/');
  await page.waitForSelector('.offerings-card');
  check((await text('.offerings-card')).includes('RM 19.90'), 'home shows this month\'s offerings');
  check((await text('.fund-card')) === cashBefore, 'the fund\'s money is untouched by an offering');
  const lastSent = () => (JSON.parse(backups[backups.length - 1].body).data.offerings || []);
  for (let i = 0; i < 60 && !(lastSent()[0] && lastSent()[0].lines[0].amount === 200); i++) await new Promise((r) => setTimeout(r, 250));
  check(lastSent().length === 1 && lastSent()[0].lines.length === 3 && lastSent()[0].lines[0].amount === 200, 'the offering reaches the backup server' + (lastSent().length ? '' : ': ' + await page.evaluate(() => localStorage.getItem('dana-ledger:backup-status') + ' pending=' + localStorage.getItem('dana-ledger:backup-pending'))));
  await page.reload();
  await page.waitForSelector('.offerings-card');
  check((await text('.offerings-card')).includes('RM 19.90'), 'the offering survives a reload');

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
  fakeGoogle.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
