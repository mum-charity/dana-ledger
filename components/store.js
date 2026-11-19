/*
 * 善款簿 — everything behind the screens: the records, saving them on the phone, the automatic
 * backup, the hash routes, and which sheet, confirm box or toast is showing.
 *
 * The records are one plain object that lib/model.js changes in place, so React can't tell from
 * the object when it changed. Instead every change calls emit(), and the screens re-read S.
 *
 * Nothing here runs until init() is called in the browser: Next.js also loads this file while
 * building the static page, where there is no window or localStorage.
 */
import L from '../lib/model.js';

export { L };
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION;
const BACKUP_NAG_DAYS = 14;

/** What the screens read. Changed only by the functions in this file. */
export const S = {
  ready: false,
  state: null,
  storageOK: true,
  sheet: null, // { type, props, key }
  sheetShown: false,
  confirm: null, // { title, message, ok, cancel, danger }
  toast: null, // { msg, actionLabel, action }
  toastShown: false,
};

const STORE_KEY = 'dana-ledger:v1';

// ================================================================ re-rendering
const listeners = new Set();
let version = 0;
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = () => version;
export function emit() {
  version++;
  listeners.forEach((fn) => fn());
}

// ================================================================ storage
function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
  } catch (e) {
    S.storageOK = false;
    return L.emptyState();
  }
  if (!raw) return L.emptyState();
  try {
    return L.normalizeState(JSON.parse(raw)).state;
  } catch (e) {
    console.error('Saved data could not be read', e);
    // Keep the unreadable copy so nothing is lost for good.
    try { localStorage.setItem(STORE_KEY + ':unreadable:' + Date.now(), raw); } catch (_) { /* ignore */ }
    return L.emptyState();
  }
}

let askedPersist = false;

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S.state));
    S.storageOK = true;
  } catch (e) {
    S.storageOK = false;
    showToast('⚠ 保存失败！请检查手机储存空间。', { ms: 10000 });
  }
}
/** Save after a change made by the user (counts toward the backup reminder). */
function save() {
  S.state.settings.changesSinceBackup = (S.state.settings.changesSinceBackup || 0) + 1;
  persist();
  serverChanged();
  if (!askedPersist && navigator.storage && navigator.storage.persist) {
    askedPersist = true;
    navigator.storage.persist().catch(() => {});
  }
}
export function mutate(fn) {
  const out = fn(S.state);
  save();
  emit();
  return out;
}

function applyFontSize() {
  document.documentElement.dataset.font = S.state.settings.fontSize || 'large';
}
export function setFontSize(size) {
  S.state.settings.fontSize = size;
  persist();
  applyFontSize();
  emit();
}
export function setCurrency(value) {
  S.state.settings.currency = value.trim().slice(0, 8);
  persist();
  emit();
  showToast('已保存');
}

// ================================================================ backup server
// Every change is also sent, by itself, to the family's backup server (server/ in this repo)
// whenever there is signal. There is nothing to set up: each phone backs up into its own folder there,
// named by a random id made the first time the app runs. Anyone can send a backup, but reading
// one back needs the family's key, which never comes to the phone.
let SERVER = '';
// True on a developer's own computer (localhost), so trying things there never reaches the real
// server. The tests name their own stand-in server, which turns backup on again.
let backupOff = false;
const KEY_DEVICE = 'dana-ledger:device-id'; // this phone's folder on the server; never in backup files
const KEY_PENDING = 'dana-ledger:backup-pending'; // set while there are changes not yet on the server
const KEY_STATUS = 'dana-ledger:backup-status'; // { ok, at, error, lastOkAt } of the last attempt

function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } }

let device = null;
/** This phone's backup id: 32 random hex digits, made once and kept. */
function deviceId() {
  if (device) return device;
  let id = lsGet(KEY_DEVICE);
  if (!/^[0-9a-f]{32}$/.test(id || '')) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    lsSet(KEY_DEVICE, id);
  }
  return (device = id);
}

export function serverStatus() {
  try { return JSON.parse(lsGet(KEY_STATUS)) || {}; } catch (_) { return {}; }
}

async function sendToServer(body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let res;
  try {
    res = await fetch(`${SERVER}/backup/${deviceId()}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, cache: 'no-store', signal: ctl.signal });
  } catch (e) {
    throw new Error(navigator.onLine === false ? '没有网络' : '连不上服务器');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(res.status === 507 ? '服务器的空间满了' : `服务器出错（${res.status}）`);
}

let uploadTimer = null;
let uploading = false;

/** A fresh marker each time, so an upload can tell whether more changes came in while it ran. */
const markPending = () => lsSet(KEY_PENDING, Math.random().toString(36).slice(2));

/** Note a change to the records, and send it to the server soon. */
function serverChanged() {
  if (backupOff) return;
  markPending();
  scheduleUpload(3000);
}
function scheduleUpload(ms) {
  if (backupOff || !lsGet(KEY_PENDING)) return;
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(uploadNow, ms);
}
/** Send the records to the server. Returns true when the server has them. */
async function uploadNow() {
  clearTimeout(uploadTimer);
  // An empty book is never sent: a new or wiped phone has nothing worth keeping yet.
  if (backupOff || uploading || !S.state.funds.length) return false;
  uploading = true;
  const pending = lsGet(KEY_PENDING);
  const before = serverStatus();
  let ok = false;
  try {
    await sendToServer(L.backupJSON(S.state));
    ok = true;
    if (lsGet(KEY_PENDING) === pending) lsDel(KEY_PENDING);
    lsSet(KEY_STATUS, JSON.stringify({ ok: true, at: Date.now(), lastOkAt: Date.now() }));
    S.state.settings.lastBackupAt = Date.now();
    S.state.settings.changesSinceBackup = 0;
    persist();
  } catch (e) {
    lsSet(KEY_STATUS, JSON.stringify({ ok: false, at: Date.now(), error: e.message, lastOkAt: before.lastOkAt || null }));
  } finally {
    uploading = false;
  }
  scheduleUpload(ok ? 3000 : 120000); // changes made during the upload, or a retry
  emit();
  return ok;
}

function daysSince(ts) {
  return ts ? Math.floor((Date.now() - ts) / 86400000) : Infinity;
}

/** The warning for the home screen, or null. Only when changes have not reached the backup server for a long time, so someone notices. */
export function backupWarning() {
  const st = S.state.settings;
  const ss = serverStatus();
  if (backupOff || !S.state.funds.length || !lsGet(KEY_PENDING) || ss.ok !== false) return null;
  const last = ss.lastOkAt || st.lastBackupAt;
  if (last ? daysSince(last) < BACKUP_NAG_DAYS : (st.changesSinceBackup || 0) < 30) return null;
  return last ? `已经 ${daysSince(last)} 天没能自动备份` : '还没能自动备份';
}

// ================================================================ helpers
export const cur = () => S.state.settings.currency || '';
export const money = (c) => L.fmtMoney(c, cur());
export const thisYear = () => +L.currentMonth().slice(0, 4);

// ================================================================ routing
// #/                    home
// #/f/<id>/m/<YYYY-MM>  month page of a fund
// #/f/<id>/y/<YYYY>     year table
// #/f/<id>/p            people list
// #/settings
// #/restore             for the family: load a backup file (five taps on the version line in 设置)
// #/setup/<code>        the family's setup link: an empty phone loads mum's book (see takeSetupLink)
export function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'f' && parts[1]) {
    const fund = L.getFund(S.state, parts[1]);
    if (!fund) return { name: 'home' };
    if (parts[2] === 'y') return { name: 'year', fund, year: /^\d{4}$/.test(parts[3]) ? +parts[3] : thisYear() };
    if (parts[2] === 'p') return { name: 'people', fund };
    return { name: 'month', fund, month: L.isMonth(parts[3]) ? parts[3] : L.currentMonth() };
  }
  if (parts[0] === 'offerings') return { name: 'offerings' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'restore') return { name: 'restore' };
  return { name: 'home' };
}

// The app keeps its own notes in history.state: `d` counts how deep she is, so 返回 knows whether
// there is a page to go back to, and `sheet` marks the entry a sheet added, so the phone's back
// button closes the sheet instead of leaving the page. Next.js passes these calls through and
// keeps its own keys beside ours.
export function nav(hash, replace = false) {
  if (replace) history.replaceState(history.state, '', hash);
  else history.pushState({ d: ((history.state && history.state.d) || 0) + 1 }, '', hash);
  window.scrollTo(0, 0);
  emit();
}
export function goBack() {
  if (history.state && history.state.d > 0) history.back();
  else nav('#/', true);
}

// ================================================================ sheets
let sheetSeq = 0;
let lastFocus = null;
let sheetClosedWaiters = [];

/** Open a sheet. `type` picks the form in components/sheets.jsx. */
export function openSheet(type, props = {}) {
  lastFocus = document.activeElement;
  const wasOpen = !!S.sheet;
  S.sheet = { type, props, key: ++sheetSeq };
  S.sheetShown = false;
  document.body.classList.add('has-sheet');
  if (!wasOpen) history.pushState({ ...(history.state || {}), sheet: true }, '');
  emit();
  const key = S.sheet.key;
  requestAnimationFrame(() => {
    if (!S.sheet || S.sheet.key !== key) return;
    S.sheetShown = true; // slides the sheet up
    emit();
    const root = document.getElementById('sheet');
    // If she is already in a field by now, leave her there.
    if (!root || root.contains(document.activeElement)) return;
    const first = root.querySelector('[data-autofocus]') || root.querySelector('.sheet-x');
    if (first) first.focus({ preventScroll: true });
  });
}
function hideSheet() {
  S.sheet = null;
  S.sheetShown = false;
  document.body.classList.remove('has-sheet');
  emit();
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  const waiters = sheetClosedWaiters;
  sheetClosedWaiters = [];
  waiters.forEach((w) => w());
}
/** Close the open sheet. Resolves once it is gone and history is back on the page entry. */
export function closeSheet() {
  if (!S.sheet) return Promise.resolve();
  return new Promise((resolve) => {
    sheetClosedWaiters.push(resolve);
    if (history.state && history.state.sheet) history.back(); // popstate hides it
    else hideSheet();
  });
}

// ================================================================ confirm
let confirmResolve = null;
/** Ask a yes/no question. `message` may be JSX. Resolves true for yes. */
export function confirmBox({ title, message = '', ok = '确定', cancel = '不要', danger = false }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    S.confirm = { title, message, ok, cancel, danger };
    emit();
    requestAnimationFrame(() => {
      const btn = document.querySelector('#confirm [data-action="confirm-no"].btn');
      if (btn) btn.focus();
    });
  });
}
export function closeConfirm(value) {
  S.confirm = null;
  const r = confirmResolve;
  confirmResolve = null;
  emit();
  if (r) r(value);
}

// ================================================================ toast
let toastTimer = null;
export function showToast(msg, { actionLabel, action, ms } = {}) {
  S.toast = { msg, actionLabel, action: action || null };
  S.toastShown = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms || (actionLabel ? 7000 : 3000));
  emit();
}
function hideToast() {
  S.toastShown = false; // the words stay while it slides away
  if (S.toast) S.toast = { ...S.toast, action: null };
  emit();
}
export function toastAction() {
  const fn = S.toast && S.toast.action;
  hideToast();
  if (fn) fn();
}

// ================================================================ add to home screen
// Android can show its own install prompt. On iPhone a page cannot start the install at all,
// so there the button opens the steps instead.
export const phone = { ios: false, android: false, inAppBrowser: false, iosOtherBrowser: false };
let installPrompt = null; // Android's prompt, held until the button is tapped
let installedNow = false;

function isInstalled() {
  return installedNow || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
export function canOfferInstall() {
  return !(isInstalled() || !(phone.ios || phone.android || installPrompt));
}
export async function doInstall() {
  if (!installPrompt) return openSheet('install');
  const prompt = installPrompt;
  installPrompt = null; // a browser lets each prompt be used only once
  try {
    await prompt.prompt();
  } catch (_) {
    openSheet('install');
  }
}

// ================================================================ files & sharing
/** Share the file (phone share sheet) or download it. Returns 'shared', 'downloaded' or false if cancelled. */
export async function shareOrDownload(filename, text, type) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], filename, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

export async function doRestore(file) {
  let parsed;
  try {
    parsed = L.normalizeState(JSON.parse(await file.text()));
  } catch (e) {
    showToast('打不开这个文件：' + (e.message || '格式不对'), { ms: 6000 });
    return;
  }
  // The restored records become the latest copy on the server too.
  if (await confirmAndRestore(parsed, '这个备份')) serverChanged();
}

/** Ask, then replace the records with a checked backup. Returns true if restored. */
async function confirmAndRestore(parsed, what) {
  const n = parsed.state;
  const yes = await confirmBox({
    title: `用${what}取代现在的记录？`,
    message: (
      <>
        {`备份里有 ${n.funds.length} 个项目、${n.members.length} 人、${n.receipts.length} 笔收款。`}
        <br />
        手机里<strong>现在的记录会被取代</strong>。
      </>
    ),
    ok: '是，恢复备份',
    danger: true,
  });
  if (!yes) return false;
  try { localStorage.setItem(STORE_KEY + ':before-restore', JSON.stringify(S.state)); } catch (_) { /* ignore */ }
  adopt(n);
  showToast(`已恢复${parsed.dropped ? `（有 ${parsed.dropped} 笔坏掉的记录被跳过）` : ''}`, { ms: 5000 });
  return true;
}

/** Make checked records this phone's records, and show the home screen. */
function adopt(state) {
  S.state = state;
  S.state.settings.lastBackupAt = Date.now();
  S.state.settings.changesSinceBackup = 0;
  persist();
  applyFontSize();
  nav('#/', true);
}

// ================================================================ the family's book, by setup code
// How a new phone gets mum's records. The family publishes her book on the backup server under a
// setup code: 32 random hex digits, which is the only thing that opens it. The phone gets the
// code in a link (#/setup/<code>) or pasted into 恢复记录, fetches that one book, and from then on
// works like any phone: the records live here and back up by themselves. The family's key for
// reading backups is never involved.
const SETUP_CODE = /(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i;
/** The setup code in what was typed or pasted: the code by itself, or the whole link. */
export function setupCodeFrom(text) {
  const m = SETUP_CODE.exec(String(text == null ? '' : text).trim());
  return m ? m[1].toLowerCase() : null;
}

async function fetchBook(code) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(`${SERVER}/book/${code}`, { cache: 'no-store', signal: ctl.signal });
  } catch (e) {
    throw new Error(navigator.onLine === false ? '没有网络' : '连不上服务器');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new Error('设置码不对，或者已经换了新的');
  if (!res.ok) throw new Error(`服务器出错（${res.status}）`);
  let parsed;
  try {
    parsed = L.normalizeState(await res.json());
  } catch (e) {
    throw new Error('收到的记录格式不对');
  }
  if (!parsed.state.funds.length) throw new Error('收到的记录是空的');
  return parsed;
}

let loadingBook = false;
/**
 * Fetch the book under a setup code and make it this phone's records. A phone that already has
 * records is left alone unless `replace` is set, and then it asks first, like restoring a file.
 * Returns true if the records were loaded.
 */
async function loadBook(code, { replace = false } = {}) {
  if (loadingBook) return false;
  loadingBook = true;
  try {
    showToast('正在载入记录…', { ms: 35000 });
    let parsed;
    try {
      parsed = await fetchBook(code);
    } catch (e) {
      showToast('没能载入记录：' + e.message, { ms: 8000 });
      return false;
    }
    // Looked at again after the wait: she may have started a book of her own meanwhile.
    if (S.state.funds.length) {
      if (!replace) {
        showToast('这部手机已经有记录，没有更改。', { ms: 8000 });
        return false;
      }
      if (!(await confirmAndRestore(parsed, '家人准备的记录'))) return false;
    } else {
      const n = parsed.state;
      adopt(n);
      showToast(`已载入 ${n.funds.length} 个项目、${n.members.length} 人的记录`, { ms: 6000 });
    }
    serverChanged(); // from now on this phone backs the book up as its own
    return true;
  } finally {
    loadingBook = false;
  }
}

/** From 恢复记录, for the family: load the book under the code or link they pasted. */
export async function loadBookFromText(text) {
  const code = setupCodeFrom(text);
  if (!code) {
    showToast('请贴上家人给的设置链接或设置码。', { ms: 6000 });
    return false;
  }
  return loadBook(code, { replace: true });
}

/**
 * A setup link was opened (#/setup/<code>). The code is taken out of the address at once, so it
 * is not left in the address bar or the phone's history. Only an empty phone loads the book.
 */
function takeSetupLink() {
  const m = /^#\/setup(?:\/([^/?#]*))?/.exec(location.hash);
  if (!m) return;
  history.replaceState(history.state, '', '#/');
  const code = setupCodeFrom(m[1]);
  if (!code) showToast('这个设置链接不完整，请向家人再要一次。', { ms: 8000 });
  else if (S.state.funds.length) showToast('这部手机已经有记录，没有更改。', { ms: 8000 });
  else loadBook(code);
}

export async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制，可以贴到 WhatsApp');
  } catch (_) {
    showToast('无法分享，请截图');
  }
}

// ================================================================ start
let started = false;
/** Load the records and start listening. Called once, in the browser, when the app first shows. */
export function init() {
  if (started) return;
  started = true;

  // Read here, not when the file loads, so a test can point the app away from the real server.
  SERVER = window.LEDGER_BACKUP_SERVER || 'https://mum-backup.franklee.asia';
  backupOff = !window.LEDGER_BACKUP_SERVER && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // The sample book that ?demo used to keep on the phone. Demo mode is gone, so clear it away.
  lsDel('dana-ledger:demo');

  // Version 1.2.0 asked for a key and kept its own status. Forget both: the key read backups,
  // so it must not stay on a phone.
  ['dana-ledger:server-key', 'dana-ledger:server-pending', 'dana-ledger:server-status'].forEach(lsDel);

  S.state = loadState();
  applyFontSize();

  const UA = navigator.userAgent;
  phone.ios = /iPad|iPhone|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  phone.android = /Android/.test(UA);
  phone.inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|WhatsApp|; wv\)/.test(UA);
  phone.iosOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(UA);
  installPrompt = window.__installPrompt || null; // caught in app/layout.jsx if it came early
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installedNow = true;
    emit();
    showToast('已添加到主屏幕。以后请从主屏幕的「善款簿」图标打开。', { ms: 9000 });
  });

  window.addEventListener('popstate', () => {
    if (S.confirm) closeConfirm(false);
    if (S.sheet && !(history.state && history.state.sheet)) hideSheet();
    emit();
  });
  window.addEventListener('hashchange', () => {
    takeSetupLink();
    emit();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (S.confirm) closeConfirm(false);
    else if (S.sheet) closeSheet();
  });

  // Another tab or window changed the data: reload it so we never overwrite newer records.
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY) {
      S.state = loadState();
      applyFontSize();
      emit();
    }
  });

  // Send changes still waiting for the server when the signal comes back or the app is reopened,
  // and try once more as the app goes into the background.
  window.addEventListener('online', () => scheduleUpload(1000));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleUpload(1000);
    else if (lsGet(KEY_PENDING)) uploadNow();
  });
  // Records that have never reached the server (for example, from before automatic backup) go now.
  if (!backupOff && S.state.funds.length && !lsGet(KEY_STATUS)) markPending();
  scheduleUpload(2000);

  // The service worker is made by `npm run build`, so there is none while developing.
  if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW registration failed', err));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) showToast('善款簿已更新', { actionLabel: '重新打开', action: () => location.reload(), ms: 15000 });
    });
  }

  S.ready = true;
  emit();
  takeSetupLink();
}
