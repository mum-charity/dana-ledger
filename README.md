# 善款簿 (Dana Ledger)

**App link:** https://mum.franklee.asia/

A small offline web app (PWA) for keeping a monthly donation book. It works like a paper book:

- Each **fund** (项目) has a numbered list of people. Each person gives a set amount every month, or a different amount each time.
- **供养记录:** one entry for each offering, for example a monks' lunch: the date, who it was offered to, what each person gave, and who the merit is dedicated to. A new entry starts with the last entry's names and dedication, so only the amounts need typing. Offerings are separate from the funds and never change the money a fund should be holding.
- **Month page (每月):** tap the box next to a name to tick that month as paid. Undo appears for a few seconds. One payment can cover several months (e.g. 已付全年).
- **Money handed over (交钱 / 支出):** record the date, amount and who it went to. Small spending like 做茶点 goes here too.
- **Year table (全年表):** a Jan–Dec grid with monthly totals, money handed over, dates and running balance. It can be printed or saved as a PDF, or exported to Excel (CSV).
- **Backup:** save a backup file or restore from one. A WhatsApp text summary of the month is also available.

The interface is Simplified Chinese with large text, and amounts are in RM (you can change the currency in 设置).

## Current status

Last checked on 19 Nov 2026.

https://mum.franklee.asia/ runs version 2.0.1, deployed from the `dev` branch on 19 Nov 2026. It is the 1.5.0 app rebuilt with Next.js and React, plus a desktop layout and without the demo. **It was checked in desktop Chrome at a phone's size, not yet on a real phone.**

| Copy | Version | Backup |
|---|---|---|
| https://mum.franklee.asia/ | 2.0.1 | Automatic, to the family's backup server |
| Branch `dev` | 2.0.1 | Automatic |
| Branch `main` | 2.0.1 | Automatic |

To go back to 1.5.0: `npx wrangler@4.158.0 rollback cff2a828-edf0-41cd-81eb-416fa8cb617a`. The tag `pi-server-as-installed` keeps 1.6.0 with the backup server's files exactly as they were installed on the Pi.

What 2.0.0 changes:

- The screens are React components in `components/`. The money rules in `lib/model.js` are unchanged, and so is everything saved on the phone, so her records and her folder on the backup server carry over. `tests/upgrade.js` checks this.
- On a phone it looks the same as 1.6.0. On a wide screen (960px and up) the funds are listed down the left side, the month page has two columns, and sheets open as dialogs in the middle.
- It is still only static files with no server code of its own. Backups still go to the family's backup server.
- It now needs a build step (`npm run build`). The copy that used to be on GitHub Pages was 1.1.1 served straight from `main`; GitHub Pages was turned off on 19 Nov 2026, so mum.franklee.asia is the only address.

Since 1.4.0 the app sends records to the backup server by itself whenever there is signal, and the 保存备份文件 button is gone. A backup file can only be restored from a hidden screen: tap the version line in 设置 five times.

Still to do:

- Try 2.0.1 on a real iPhone and Android phone. The tests run in desktop Chrome at a phone's size.
- Find where 1.5.0 was deployed from. The live app went from 1.4.0 to 1.5.0 on 7–8 Nov from a copy outside this repo, and another deploy from there would replace anything deployed from here.
- The backup server's log shows only two small test backups, on 7 and 8 Nov, and none since. Uploading works, but check that her real book arrives once she is using the app.
- Backups moved from the Pi to AWS (an S3 bucket) on 19 Nov: the app's backup address now points at the server in [server/aws/](server/aws/README.md). The Pi's backup service is still running but unused; stopping it is [issue #8](https://github.com/mum-charity/dana-ledger/issues/8).

## Where the data lives

Records are kept on the phone, in the browser's storage for this site. Whenever there is signal, the app also sends a copy by itself to the family's backup server, which keeps every version in a private S3 bucket on AWS (see [server/aws/README.md](server/aws/README.md)). There is nothing for her to tap or set up.

This means:

- If the phone is lost or its browser data is cleared, the records can be restored from the last backup. Anything entered since then, while there was no signal, is lost.
- The app warns on its home screen only when backups have been failing for 14 days, or 30 changes have never been backed up.
- A new phone can load mum's book with a **setup link** the family makes. See [Putting mum's book on a new phone](#putting-mums-book-on-a-new-phone).
- To put a backup on a phone, the family fetches the file from the backup server with the key, sends it to the phone, and loads it from the hidden 恢复记录 screen: tap the version line in 设置 five times, then 从备份文件恢复. The steps are in [server/aws/README.md](server/aws/README.md#restoring-a-phone).
- Each phone, and each browser on it, backs up as a separate book.

## Run locally

```sh
npm install
npm run dev                # http://localhost:3000, reloads as you edit. No offline mode here.
npm run build              # writes the finished app to out/
npx http-server -c-1 out   # serves the built app, with offline mode, at http://localhost:8080
```

**Trying things by hand on your own computer is safe.** At `localhost` the app keeps records in that browser only and never sends them to the backup server. At any other address, anything you enter is sent to the real backup server as a new phone's backup.

```sh
npm test                                   # type-checks the backup server, then unit tests for the money/balance rules and the server
npm run test:e2e                           # builds, then drives the real app on a phone-sized screen
npm run build && node tests/upgrade.js     # a phone on 1.6.0 moves to this build and keeps its records
```

The browser tests use Edge. Put `E2E_CHANNEL=chrome` in front to use Chrome. They send backups to their own stand-in server, never the real one.

The end-to-end test fixes the date to 6 Nov 2026. It creates a fund, ticks people as paid, prepays a year, records a payout, and checks the year table's balances against hand-worked numbers. It also checks offline use, automatic backup, wipe-and-restore, the CSV export and the desktop layout. Screenshots go to `.e2e-out/`.

## Deploy (Cloudflare)

**The copy that 1.5.0 was deployed from has never been found.** Another deploy from that copy would replace 2.0.0 with 1.5.0. See [Current status](#current-status).

The app at https://mum.franklee.asia/ is a static-assets-only Cloudflare Worker, set up in `wrangler.jsonc`.

```sh
npx wrangler@4.158.0 login   # first time only: approve in the browser within about 2 minutes
npm run deploy               # builds the app into out/, then uploads it
```

`npm run deploy` uploads only `out/`, so the README, tests and `node_modules` stay private. Cloudflare redirects `/index.html` to `/`, so the service worker caches the page as `./`. The end-to-end test's server does the same redirect.

## Releasing a change

**Every time you change the app:** bump `version` in `package.json`. That is the number shown in 设置. Phones pick up a new build either way, because `npm run build` gives the offline cache a new name whenever any file changes. The next time she opens the app it updates and shows 「善款簿已更新」.

## Files

| File | What it does |
| --- | --- |
| `app/layout.jsx`, `app/page.jsx` | Page shell and PWA meta tags |
| `app/globals.css` | Styles: large text, dark mode, the desktop layout, and the print layout for the year table |
| `lib/model.js` | All data rules (money in integer cents, months as `YYYY-MM`). Has no screen code and is unit-tested in Node |
| `components/store.js` | Saving on the phone, automatic backup, routes, and which sheet or toast is open |
| `components/LedgerApp.jsx` | The screens |
| `components/sheets.jsx` | The forms that slide up (dialogs on desktop) |
| `scripts/sw.template.js`, `scripts/build.js` | Offline cache. The build fills in the file list and writes `out/sw.js` |
| `public/manifest.webmanifest`, `public/icons/` | Home-screen install |
| `server/backup-core.ts` | The backup server's rules: what it accepts, refuses and keeps. Shared by the Pi and AWS versions. Not part of the app's build |
| `server/backup-server.ts`, `server/store-disk.ts`, `server/pi-setup.sh`, `server/dana-backup.*` | The version that runs on the family's Raspberry Pi and keeps files on its disk, with its systemd service and installer |
| `server/tsconfig.json`, `server/package.json`, `scripts/build-server.mts`, `lib/model.d.ts` | The server is TypeScript on Node.js. Node 24 runs it as it is; `npm run build:server` turns it into JavaScript in `server/dist/` for AWS Lambda and the Pi. `model.d.ts` describes `lib/model.js`, which is still JavaScript, as are the screens |
| `scripts/publish-book.mts` | For the family: publishes a book on the backup server and prints its setup link |
| `server/aws/` | The version for AWS, keeping backups in an S3 bucket. See [server/aws/README.md](server/aws/README.md) |
| `tests/server.test.mts` | Tests for the backup server, run against both the disk and S3 versions |
| `tests/model.test.js` | Unit tests for balances, prepayments, import and CSV |
| `tests/e2e.js` | End-to-end test on a phone-sized screen, plus the desktop layout |
| `tests/upgrade.js` | Moving a phone from 1.6.0 to this build |
| `next.config.js`, `wrangler.jsonc` | Build settings (static export) and Cloudflare deploy settings |

## Putting mum's book on a new phone

**Not live yet.** This is in 2.2.0, which is not deployed: both the app and the backup server on AWS have to be deployed before a setup link works.

The family publishes a book on the backup server under a **setup code**, 32 random hex digits. Whoever has the code can read that one book, and nothing else on the server. The family's key for reading backups is needed to publish, and never goes to a phone.

```sh
node scripts/publish-book.mts private/book.json                       # checks the file, sends nothing
BACKUP_TOKEN=<the family key> node scripts/publish-book.mts private/book.json --send
```

The second command prints a link like `https://mum.franklee.asia/#/setup/<code>`.

- **Android:** tap the link on the new phone. If the app has no records, it loads the book.
- **iPhone:** a link opens in Safari, not in the installed app. Open 「善款簿」 from the home screen, tap the version line in 设置 five times, and paste the link under 「家人给的设置链接或设置码」.
- A phone that already has records is not changed by the link. From 恢复记录 it asks first, then replaces them.
- After loading, the phone works as before: records are kept on the phone and back up by themselves as that phone's own book. It does not fetch the shared book again.
- **Treat the link like a password.** Anyone who gets it can read every name and amount in the book. To stop an old link working, publish under a new code; the old copy stays in the bucket until someone with AWS access removes it.
- Keep the book file in `private/`, which git ignores.

## First-time setup for mum

**Install it on her phone first, then set it up from the home-screen icon.** On iPhone, the home-screen app has its own storage, separate from the Safari tab. Anything entered in Safari *before* installing won't show up in the installed app. If that happens, the family can fetch the Safari copy's backup from the backup server and load it in the installed app (see [Where the data lives](#where-the-data-lives)). Android Chrome shares storage, so this only affects iPhone.

1. Install it (steps below), then open 「善款簿」 from the home screen.
2. Tap **＋ 新增项目**, e.g. 「Bhante 医疗费用」. Enter the money already on hand as 「开始时手上已有的钱」.
3. Tap **名单 → 一次添加多人** and paste one person per line, with the monthly amount at the end:
   ```
   陈美玲 10
   林志明、黄淑芬 20
   Tan Ah Kow 合家 10
   王小华
   ```
   Leave the amount off for people who give a different amount each month.
4. **「从哪个月开始」:** to start recording from now, keep the current month. If you pick an earlier month (e.g. January), those months show red (unpaid) until you fill them in from the paper book. To do that, open **全年表** and tap each cell.
5. Repeat for the other fund (e.g. 「Dana Parami」).
6. Nothing to do for backup: with signal, the app backs up by itself a few seconds after each change.

### 安装到手机（给妈妈）

**最简单：** 打开链接，点最上面的「添加到手机主屏幕」，照着提示做。

**Android（Chrome）：** 用 Chrome 打开链接 → 点右上角 ⋮ → 「安装应用」或「添加到主屏幕」 → 主屏幕会出现「善款簿」图标。

**iPhone（一定要用 Safari）：** 用 Safari 打开链接 → 点下面的「分享」按钮（方框加箭头）→ 往下找「添加到主屏幕」→ 点「添加」。

以后从主屏幕的「善款簿」图标打开就可以，不用上网也能用。

**每个月：** 收到钱后，在「每月」页点名字右边的方格打勾。交钱给 Bhante 后，点「＋ 记录交钱 / 支出」。

**备份：** 不用做什么。手机有网络时，善款簿会自己备份。
