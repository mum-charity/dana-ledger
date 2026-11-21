'use client';
/* 善款簿 — the screens. The records and everything behind them are in store.tsx. */
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { Fund, Member, Offering, Settings } from '../lib/model.ts';
import type { PublicSummary } from '../server/public-summary.ts';
import {
  S, L, APP_VERSION, subscribe, getVersion, init, route, nav, goBack, mutate, money, openSheet,
  closeConfirm, confirmBox, showToast, toastAction, serverStatus, backupWarning, canOfferInstall, doInstall,
  shareOrDownload, shareText, doRestore, loadBookFromText, setFontSize, setCurrency, fetchPublicAccounts,
  account, canSignIn, hasUnsynced, signInWithGoogle, signOut, syncNow,
  type ConfirmOptions, type Route,
} from './store';
import { SHEETS } from './sheets';

export default function LedgerApp() {
  useSyncExternalStore(subscribe, getVersion, () => 0);
  useEffect(init, []);

  const r = S.ready ? route() : null;
  const title = r ? (r.fund ? `${r.fund.name} · 善款簿` : r.name === 'public' ? '公开账目 · 善款簿' : '善款簿') : '善款簿';
  useEffect(() => {
    document.title = title;
  }, [title]);

  let view = null;
  if (r) {
    if (r.name === 'month') view = <MonthView fund={r.fund} month={r.month} />;
    else if (r.name === 'year') view = <YearView fund={r.fund} year={r.year} />;
    else if (r.name === 'people') view = <PeopleView fund={r.fund} />;
    else if (r.name === 'offerings') view = <OfferingsView />;
    else if (r.name === 'settings') view = <SettingsView />;
    else if (r.name === 'restore') view = <RestoreView />;
    else if (r.name === 'public') view = <PublicView landing={!!r.landing} />;
    else view = <HomeView />;
  }
  const Sheet = S.sheet && SHEETS[S.sheet.type];

  return (
    <>
      <div id="app">
        {view}
        {/* The public page is for visitors: no list of this phone's own funds beside it. */}
        {r && r.name !== 'public' && <Sidebar r={r} />}
      </div>
      <div id="sheet" className={S.sheetShown ? 'open' : undefined}>
        {Sheet && <Sheet key={S.sheet!.key} {...S.sheet!.props} />}
      </div>
      <div id="confirm" className={S.confirm ? 'open' : undefined}>
        {S.confirm && <ConfirmBox {...S.confirm} />}
      </div>
      <div id="toast" role="status" aria-live="polite" className={S.toastShown ? 'show' : undefined}>
        {S.toast && (
          <div className="toast-inner">
            <span className="toast-msg">{S.toast.msg}</span>
            {S.toast.actionLabel && <button className="toast-btn" data-action="toast-action" onClick={toastAction}>{S.toast.actionLabel}</button>}
          </div>
        )}
      </div>
      <input
        type="file"
        id="restore-file"
        accept=".json,application/json,text/plain"
        hidden
        onChange={(e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (file) doRestore(file);
        }}
      />
    </>
  );
}

function ConfirmBox({ title, message, ok, cancel, danger }: Required<ConfirmOptions>) {
  return (
    <>
      <div className="sheet-backdrop" data-action="confirm-no" onClick={() => closeConfirm(false)} />
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={message ? 'confirm-msg' : undefined}>
        <h2 id="confirm-title">{title}</h2>
        {message ? <p id="confirm-msg">{message}</p> : null}
        <div className="confirm-actions">
          <button className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'} btn-block`} data-action="confirm-yes" onClick={() => closeConfirm(true)}>{ok}</button>
          <button className="btn btn-ghost btn-block" data-action="confirm-no" onClick={() => closeConfirm(false)}>{cancel}</button>
        </div>
      </div>
    </>
  );
}

// ================================================================ shared pieces
/** The Google sign-in button, for the family. */
function GoogleButton({ label = '用 Google 帐号登入' }) {
  return <button className="btn btn-primary btn-block" data-action="google-sign-in" onClick={signInWithGoogle}>{label}</button>;
}

/** One line saying whether this device's records are the same as the family's right now. */
function SyncLine() {
  const a = account();
  if (!a) return null;
  const y = S.sync;
  const time = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  let text;
  if (y.busy) text = '正在和家里的记录同步…';
  else if (y.ok === false) text = `⚠ 还没同步（${y.error}）。有网络时会自动再试。`;
  else if (hasUnsynced()) text = '有更改还没传到家里的记录，马上会自动传。';
  else if (y.ok) text = `已和家里的记录同步 · ${time(y.at!)}`;
  else text = '已登入，和家里的记录同步。';
  return <p className="hint sync-line" data-role="sync-line" data-sync={y.busy ? 'busy' : y.ok === false ? 'error' : hasUnsynced() ? 'pending' : 'ok'}>{text}</p>;
}

const go = (to: string) => () => nav(to);
const goReplace = (to: string) => () => nav(to, true);

// A drawn chevron, not the ‹ › characters: each font puts those at a different height
// (Microsoft YaHei draws them ~7px below the middle of the round button).
function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg className="chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  );
}

function Topbar({ title, back = false, right = null }: { title: string; back?: boolean; right?: ReactNode }) {
  return (
    <header className="topbar">
      {back ? <button className="topbar-btn" data-action="back" onClick={goBack}><span aria-hidden="true">‹</span> 返回</button> : <span />}
      <h1 className="topbar-title">{title}</h1>
      {right || <span />}
    </header>
  );
}

function FundHeader({ fund, tab, month }: { fund: Fund; tab: 'month' | 'year' | 'people'; month?: string }) {
  const m = month || L.currentMonth();
  const tabs = [
    ['month', '每月', `#/f/${fund.id}/m/${m}`],
    ['year', '全年表', `#/f/${fund.id}/y/${m.slice(0, 4)}`],
    ['people', '名单', `#/f/${fund.id}/p`],
  ];
  return (
    <>
      <Topbar title={fund.name} back right={<button className="topbar-btn" data-action="fund-edit" onClick={() => openSheet('fund', { id: fund.id })}>编辑</button>} />
      <nav className="tabs" aria-label="页面">
        {tabs.map(([key, label, to]) => (
          <button key={key} className="tab" aria-current={key === tab ? 'page' : 'false'} onClick={goReplace(to)}>{label}</button>
        ))}
      </nav>
    </>
  );
}

/**
 * Desktop only (hidden on a phone by the stylesheet): the funds down the left side, so a wide
 * screen can jump between them without going back to the home page. It comes after the page in
 * the markup so that on a phone the page's own buttons are still the first ones found.
 */
function Sidebar({ r }: { r: Route }) {
  const month = L.currentMonth();
  return (
    <aside className="sidebar" aria-label="项目">
      <button className="side-brand" onClick={go('#/')}><span className="side-mark" aria-hidden="true">善</span>善款簿</button>
      <nav className="side-funds" aria-label="项目">
        <button className="side-link" aria-current={r.name === 'home' ? 'page' : 'false'} onClick={go('#/')}><span className="side-name">全部项目</span></button>
        {S.state.funds.map((f) => (
          <button key={f.id} className="side-link" aria-current={r.fund && r.fund.id === f.id ? 'page' : 'false'} onClick={go(`#/f/${f.id}/m/${month}`)}>
            <span className="side-name">{f.name}</span>
            <span className="side-amt">{money(L.cashOnHand(S.state, f.id))}</span>
          </button>
        ))}
        <button className="side-link side-add" onClick={() => openSheet('fund', { id: null })}>＋ 新增项目</button>
        <button className="side-link" data-action="side-offerings" aria-current={r.name === 'offerings' ? 'page' : 'false'} onClick={go('#/offerings')}><span className="side-name">供养记录</span></button>
      </nav>
      <button className="side-link" aria-current={r.name === 'settings' || r.name === 'restore' ? 'page' : 'false'} onClick={go('#/settings')}><span className="side-name">设置</span></button>
    </aside>
  );
}

const Progress = ({ pct }: { pct: number }) => <span className="progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>;

// ================================================================ home
function HomeView() {
  const state = S.state;
  const month = L.currentMonth();
  const warning = backupWarning();
  return (
    <>
      <Topbar title="善款簿" right={<button className="topbar-btn topbar-settings" onClick={go('#/settings')}>设置</button>} />
      <main className="page page-home">
        {!S.storageOK && <div className="banner banner-danger">⚠ 这个浏览器无法保存记录。请用 Chrome 或 Safari 的正常模式打开（不要用无痕模式）。</div>}
        {warning && (
          <div className="banner banner-warn" role="status">
            <span className="banner-text"><strong>{warning}</strong><span>新的记录现在只在这部手机里。请连上网络（例如 Wi-Fi）再打开善款簿，它会自动备份。</span></span>
          </div>
        )}
        {canOfferInstall() && <button className="btn btn-secondary btn-block" data-action="install" onClick={doInstall}>添加到手机主屏幕</button>}
        <SyncLine />
        {state.funds.length && !account() && canSignIn() ? (
          <section className="card" data-role="sign-in-card">
            <p>用 Google 帐号登入，这部手机就和家人的手机、电脑用同一本记录。</p>
            <GoogleButton />
          </section>
        ) : null}
        {!state.funds.length && (account() || S.signingIn) ? (
          <section className="card empty" data-role="family-loading">
            <div className="empty-mark" aria-hidden="true">善</div>
            {S.sync.ok === false ? (
              <>
                <h2>还没能载入家里的记录</h2>
                <p>{`${S.sync.error}。`}</p>
                <button className="btn btn-primary btn-block" data-action="sync-now" onClick={() => syncNow()}>再试一次</button>
              </>
            ) : (
              <h2>正在载入家里的记录…</h2>
            )}
          </section>
        ) : !state.funds.length ? (
          <section className="card empty">
            <div className="empty-mark" aria-hidden="true">善</div>
            <h2>欢迎使用善款簿</h2>
            <p>先新增一个项目，例如「Bhante 医疗费用」或「Dana Parami」，再把捐款人的名单加进去。</p>
            <button className="btn btn-primary btn-block" data-action="fund-new" onClick={() => openSheet('fund', { id: null })}>＋ 新增项目</button>
          </section>
        ) : (
          <>
            <p className="section-label">{L.monthLabel(month)}</p>
            <div className="stack fund-grid">
              {state.funds.map((f) => {
                const s = L.monthSummary(state, f.id, month);
                const total = s.members.length;
                const pct = total ? Math.round((s.receivedCount / total) * 100) : 0;
                return (
                  <button key={f.id} className="card fund-card" onClick={go(`#/f/${f.id}/m/${month}`)}>
                    <span className="fund-name">{f.name}</span>
                    <Progress pct={pct} />
                    <span className="fund-row"><span>本月已收 <b>{s.receivedCount}</b>{` / ${total} 人`}</span><b>{money(s.received)}</b></span>
                    <span className="fund-row fund-row-strong"><span>手上应有</span><b>{money(L.cashOnHand(state, f.id))}</b></span>
                  </button>
                );
              })}
            </div>
            <button className="btn btn-ghost btn-block" data-action="fund-new" onClick={() => openSheet('fund', { id: null })}>＋ 新增项目</button>
          </>
        )}
        <OfferingsCard month={month} />
      </main>
    </>
  );
}

/** The way into 供养记录 from the home page, with this month's count and total. */
function OfferingsCard({ month }: { month: string }) {
  const mine = S.state.offerings.filter((o) => o.date.slice(0, 7) === month);
  const total = mine.reduce((t, o) => t + L.offeringTotal(o), 0);
  return (
    <button className="card offerings-card" data-action="offerings-open" onClick={go('#/offerings')}>
      <span className="fund-name">供养记录</span>
      <span className="fund-row"><span>{mine.length ? <>本月 <b>{mine.length}</b> 次</> : '每天的供养、谁出多少、回向给谁'}</span>{mine.length ? <b>{money(total)}</b> : <span aria-hidden="true">›</span>}</span>
    </button>
  );
}

// ================================================================ offerings (供养)
function OfferingsView() {
  const list = L.offeringsSorted(S.state);
  const months: { month: string; items: Offering[] }[] = [];
  for (const o of list) {
    const mo = o.date.slice(0, 7);
    if (!months.length || months[months.length - 1].month !== mo) months.push({ month: mo, items: [] });
    months[months.length - 1].items.push(o);
  }
  return (
    <>
      <Topbar title="供养记录" back />
      <main className="page page-offerings">
        <button className="btn btn-primary btn-block" data-action="offering-new" onClick={() => openSheet('offering', { id: null })}>＋ 记录供养</button>
        {!list.length && (
          <section className="card empty">
            <p>这里记每一次供养，例如僧团午餐：日期、供养给谁、每个人出多少、回向功德给谁。</p>
            <p className="muted">供养记录和每月善款的项目分开，不会影响项目里「手上应有」的钱。</p>
          </section>
        )}
        {months.map(({ month, items }) => (
          <section className="card" key={month}>
            <h3 className="card-title offering-month"><span>{L.monthLabel(month)}</span><span>{`${items.length} 次 · ${money(items.reduce((t, o) => t + L.offeringTotal(o), 0))}`}</span></h3>
            <ul className="plist">
              {items.map((o) => (
                <li key={o.id}>
                  <button className="prow offering-row" onClick={() => openSheet('offering', { id: o.id })}>
                    <span className="pdate">{L.shortDate(o.date)}</span>
                    <span className="pnote">{o.recipient}<span className="offering-sub">{`${o.lines.length} 人`}</span></span>
                    <span className="pamt offering-amt">{money(L.offeringTotal(o))}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
    </>
  );
}

// ================================================================ month page
function quickPay(memberId: string, month: string) {
  const m = L.getMember(S.state, memberId);
  if (!m || !m.pledge) return openSheet('receipt', { memberId, month });
  mutate((s) => L.setReceipt(s, { memberId, month, amount: m.pledge, date: L.todayISO() }));
  showToast(`✓ ${m.name} ${L.monthShort(month)} ${money(m.pledge)}`, {
    actionLabel: '撤销',
    action: () => mutate((s) => L.removeReceipt(s, memberId, month)),
  });
}

/** The people a month's 全部打勾 would tick: still 未收, with a fixed monthly amount. */
const tickAllDue = (s: ReturnType<typeof L.monthSummary>) => s.unpaid.filter((m) => m.pledge);

/** Tick all of them at their monthly amount, received today, once she says yes. One 撤销 takes them all back. */
async function tickAll(fundId: string, month: string) {
  const s = L.monthSummary(S.state, fundId, month);
  const due = tickAllDue(s);
  const open = s.unpaid.length - due.length;
  const total = due.reduce((t, m) => t + m.pledge, 0);
  const yes = await confirmBox({
    title: `${L.monthLabel(month)}全部打勾？`,
    message: `还没收的 ${due.length} 人，各按每月金额，共 ${money(total)}，收到日期是今天。${open ? `金额不固定的 ${open} 人不包括在内，要自己记录。` : ''}`,
    ok: `是，${due.length} 人打勾`,
  });
  if (!yes) return;
  const today = L.todayISO();
  // Someone may have been ticked on another device while she was deciding: they keep their record.
  const added = mutate((st) => due.filter((m) => !L.receiptOf(st, m.id, month)).map((m) => L.setReceipt(st, { memberId: m.id, month, amount: m.pledge, date: today })));
  const ids = new Set(added.map((r) => r.id));
  showToast(`✓ ${added.length} 人 · ${money(added.reduce((t, r) => t + r.amount, 0))}`, {
    actionLabel: '撤销',
    action: () => mutate((st) => { st.receipts = st.receipts.filter((r) => !ids.has(r.id)); }),
  });
}

function PersonRow({ m, month, no }: { m: Member; month: string; no?: number }) {
  const r = L.receiptOf(S.state, m.id, month);
  const openReceipt = () => openSheet('receipt', { memberId: m.id, month });
  const sub = r
    ? `${L.shortDate(r.date)} 收到${r.amount !== m.pledge && m.pledge ? `（每月 ${L.fmtNum(m.pledge)}）` : ''}${r.note ? ' · ' + r.note : ''}`
    : m.pledge
      ? `每月 ${money(m.pledge)}`
      : '金额不固定';
  let tick;
  if (r) {
    tick = (
      <button className="tick is-paid" onClick={openReceipt} aria-label={`${m.name} 已收 ${money(r.amount)}，点击修改`}>
        <span className="tick-mark" aria-hidden="true">✓</span><span className="tick-amt">{L.fmtNum(r.amount)}</span>
      </button>
    );
  } else if (m.pledge) {
    tick = (
      <button className="tick" onClick={() => quickPay(m.id, month)} aria-label={`把 ${m.name} 标记为已收 ${money(m.pledge)}`}>
        <span className="tick-box" aria-hidden="true" /><span className="tick-amt">未收</span>
      </button>
    );
  } else {
    tick = (
      <button className="tick" onClick={openReceipt} aria-label={`记录 ${m.name} 的金额`}>
        <span className="tick-box" aria-hidden="true" /><span className="tick-amt">记录</span>
      </button>
    );
  }
  return (
    <li className={`person${r ? ' is-paid' : ''}`}>
      <button className="person-main" onClick={openReceipt}>
        <span className="num">{no}</span>
        <span className="pinfo"><span className="pname">{m.name}</span><span className="psub">{sub}</span></span>
      </button>
      {tick}
    </li>
  );
}

function MonthView({ fund, month }: { fund: Fund; month: string }) {
  const state = S.state;
  const s = L.monthSummary(state, fund.id, month);
  const numbers = new Map(L.fundMembers(state, fund.id).map((m, i) => [m.id, i + 1]));
  const total = s.members.length;
  const pct = total ? Math.round((s.receivedCount / total) * 100) : 0;
  const isNow = month === L.currentMonth();
  const prepaid = L.prepaidAfter(state, fund.id, month);
  const note = (fund.monthNotes && fund.monthNotes[month]) || '';
  const to = (m: string) => `#/f/${fund.id}/m/${m}`;

  return (
    <>
      <FundHeader fund={fund} tab="month" month={month} />
      <main className="page page-month">
        <div className="period-nav">
          <button className="period-btn" onClick={goReplace(to(L.addMonths(month, -1)))} aria-label="上个月"><Chevron dir="left" /></button>
          <h2 className="period-title">{L.monthLabel(month)}</h2>
          <button className="period-btn" onClick={goReplace(to(L.addMonths(month, 1)))} aria-label="下个月"><Chevron dir="right" /></button>
        </div>
        {!isNow && <button className="link-btn" onClick={goReplace(to(L.currentMonth()))}>回到本月</button>}

        <section className="card summary">
          <div className="summary-main">
            <span className="summary-label">本月已收</span>
            <span className="summary-big">{money(s.received)}</span>
            <span className="summary-count">{`${s.receivedCount} / ${total} 人`}</span>
          </div>
          <Progress pct={pct} />
          <dl className="summary-grid">
            <div><dt>上月结余</dt><dd>{money(s.opening)}</dd></div>
            <div><dt>本月交出</dt><dd>{s.paidOut ? '−' + money(s.paidOut) : money(0)}</dd></div>
            <div className="summary-total"><dt>本月结余</dt><dd>{money(s.closing)}</dd></div>
          </dl>
          {prepaid ? <p className="hint">{`另有 ${money(prepaid)} 是预先付了以后月份的。`}</p> : null}
        </section>

        {/* On a phone these two wrappers do nothing; on a desktop they are the two columns. */}
        <div className="month-cols">
        <div className="month-list">
        {total ? (
          <>
            <div className="list-top">
              <p className="hint">收到钱后，点右边的方格打勾 ✓</p>
              {tickAllDue(s).length > 1 ? (
                <button className="btn btn-ghost tick-all" data-action="tick-all" onClick={() => tickAll(fund.id, month)}>{`全部打勾（${tickAllDue(s).length} 人）`}</button>
              ) : null}
            </div>
            <ol className="people">{s.members.map((m) => <PersonRow key={m.id} m={m} month={month} no={numbers.get(m.id)} />)}</ol>
          </>
        ) : (
          <div className="card empty">
            <p>{`${L.monthLabel(month)}还没有名单。`}</p>
            <button className="btn btn-primary btn-block" onClick={goReplace(`#/f/${fund.id}/p`)}>去添加名单</button>
          </div>
        )}
        </div>
        <div className="month-aside">

        <section className="card">
          <h3 className="card-title">交钱 / 支出</h3>
          {s.payouts.length ? (
            <ul className="plist">
              {s.payouts.map((p) => (
                <li key={p.id}>
                  <button className="prow" onClick={() => openSheet('payout', { fundId: p.fundId, id: p.id })}>
                    <span className="pdate">{L.shortDate(p.date)}</span>
                    <span className="pnote">{p.note || '交钱'}</span>
                    <span className="pamt">{`−${money(p.amount)}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">这个月还没有交钱记录。</p>
          )}
          <button className="btn btn-ghost btn-block" onClick={() => openSheet('payout', { fundId: fund.id, month })}>＋ 记录交钱 / 支出</button>
        </section>

        <section className="card">
          <h3 className="card-title">本月备注</h3>
          <button className="note-btn" onClick={() => openSheet('note', { fundId: fund.id, month })}>
            {note ? <span className="note-text">{note}</span> : <span className="muted">＋ 写备注（例如：Chiro 日期、谁出油钱）</span>}
          </button>
        </section>

        <button className="btn btn-secondary btn-block" onClick={() => shareText(L.monthShareText(state, fund.id, month))}>分享本月记录（WhatsApp）</button>
        </div>
        </div>
      </main>
    </>
  );
}

// ================================================================ year table
function YearView({ fund, year }: { fund: Fund; year: number }) {
  const state = S.state;
  const g = L.yearGrid(state, fund.id, year);
  const now = L.currentMonth();

  const table = g.rows.length ? (
    <div className="grid-wrap" tabIndex={0} aria-label={`${year}年 全年表，可以左右滑动`}>
      <table className="grid">
        <thead>
          <tr>
            <th scope="col" className="name-col">名字</th>
            {g.months.map((m) => <th key={m} scope="col">{`${+m.slice(5)}月`}</th>)}
            <th scope="col">合计</th>
          </tr>
        </thead>
        <tbody>
          {g.rows.map((r) => {
            const ended = r.member.endMonth && r.member.endMonth < now;
            return (
              <tr key={r.member.id} className={ended ? 'ended' : undefined}>
                <th scope="row" className="name-col">
                  <span className="gnum">{r.no}</span><span className="gname">{r.member.name}</span>
                  {r.member.pledge ? <span className="gpledge">{`每月 ${L.fmtNum(r.member.pledge)}`}</span> : null}
                </th>
                {r.cells.map((c) => {
                  let cls = 'cell';
                  let text = '';
                  if (c.receipt) { cls += ' paid'; text = L.fmtNum(c.receipt.amount); }
                  else if (!c.active) { cls += ' off'; text = '–'; }
                  else if (c.month <= now) { cls += ' due'; }
                  const label = `${r.member.name} ${L.monthLabel(c.month)}${c.receipt ? ' 已收 ' + L.fmtNum(c.receipt.amount) : ' 未收'}`;
                  return (
                    <td key={c.month} className={cls}>
                      <button onClick={() => openSheet('receipt', { memberId: r.member.id, month: c.month })} aria-label={label}>{text}</button>
                    </td>
                  );
                })}
                <td className="total">{L.fmtNum(r.total)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="sum-row">
            <th scope="row" className="name-col">收到合计</th>
            {g.received.map((v, i) => <td key={i}>{v ? L.fmtNum(v) : ''}</td>)}
            <td className="total">{L.fmtNum(g.totalReceived)}</td>
          </tr>
          <tr className="out-row">
            <th scope="row" className="name-col">交出<span className="gpledge">交钱日期</span></th>
            {g.payouts.map((list, i) => {
              const amt = g.paidOut[i];
              const dates = list.map((p) => L.shortDate(p.date)).join(' ');
              return (
                <td key={i}>
                  <button onClick={goReplace(`#/f/${fund.id}/m/${g.months[i]}`)} aria-label={`${L.monthLabel(g.months[i])} 交出`}>
                    {amt ? L.fmtNum(amt) : ''}{dates ? <span className="gdate">{dates}</span> : null}
                  </button>
                </td>
              );
            })}
            <td className="total">{L.fmtNum(g.totalPaidOut)}</td>
          </tr>
          <tr className="bal-row">
            <th scope="row" className="name-col">结余</th>
            {g.balance.map((v, i) => <td key={i}>{g.months[i] <= now ? L.fmtNum(v) : ''}</td>)}
            <td className="total" />
          </tr>
          {g.notes.some(Boolean) ? (
            <tr className="note-row">
              <th scope="row" className="name-col">备注</th>
              {g.notes.map((n, i) => <td key={i}>{n}</td>)}
              <td />
            </tr>
          ) : null}
        </tfoot>
      </table>
    </div>
  ) : (
    <div className="card empty">
      <p>{`${year}年还没有名单。`}</p>
      <button className="btn btn-primary btn-block" onClick={goReplace(`#/f/${fund.id}/p`)}>去添加名单</button>
    </div>
  );

  return (
    <>
      <FundHeader fund={fund} tab="year" month={`${year}-${now.slice(5)}`} />
      <main className="page page-wide">
        <div className="period-nav">
          <button className="period-btn" onClick={goReplace(`#/f/${fund.id}/y/${year - 1}`)} aria-label="上一年"><Chevron dir="left" /></button>
          <h2 className="period-title">{`${year}年`}</h2>
          <button className="period-btn" onClick={goReplace(`#/f/${fund.id}/y/${year + 1}`)} aria-label="下一年"><Chevron dir="right" /></button>
        </div>
        <h2 className="print-title">{`${fund.name} · ${year}年`}</h2>
        <p className="hint no-print">表格可以左右滑动。点格子可以记录或修改。</p>
        {table}
        <dl className="year-totals">
          <div><dt>上年结余</dt><dd>{money(g.opening)}</dd></div>
          <div><dt>全年收到</dt><dd>{money(g.totalReceived)}</dd></div>
          <div><dt>全年交出</dt><dd>{money(g.totalPaidOut)}</dd></div>
          <div className="summary-total"><dt>年底结余</dt><dd>{money(g.balance[11])}</dd></div>
        </dl>
        <div className="actions no-print">
          <button className="btn btn-secondary btn-block" onClick={() => window.print()}>打印 / 存成 PDF</button>
          <button className="btn btn-ghost btn-block" onClick={() => shareOrDownload(`${fund.name}-${year}.csv`, L.yearCSV(state, fund.id, year), 'text/csv')}>导出 Excel 表格</button>
        </div>
      </main>
    </>
  );
}

// ================================================================ people list
function PeopleView({ fund }: { fund: Fund }) {
  const list = L.fundMembers(S.state, fund.id);
  const now = L.currentMonth();
  return (
    <>
      <FundHeader fund={fund} tab="people" />
      <main className="page">
        <div className="btn-row">
          <button className="btn btn-primary" onClick={() => openSheet('member', { fundId: fund.id })}>＋ 添加一人</button>
          <button className="btn btn-secondary" onClick={() => openSheet('bulk', { fundId: fund.id })}>一次添加多人</button>
        </div>
        {list.length ? (
          <>
            <p className="section-label">{`共 ${list.length} 人`}</p>
            <ol className="roster">
              {list.map((m, i) => {
                const ended = m.endMonth && m.endMonth < now;
                const range = `${L.monthLabel(m.startMonth)}起${m.endMonth ? ` · 到${L.monthLabel(m.endMonth)}` : ''}`;
                return (
                  <li key={m.id} className={`roster-item${ended ? ' ended' : ''}`}>
                    <button className="roster-main" onClick={() => openSheet('member', { fundId: m.fundId, id: m.id })}>
                      <span className="num">{i + 1}</span>
                      <span className="pinfo">
                        <span className="pname">{m.name}{ended ? <> <span className="tag">已停止</span></> : null}</span>
                        <span className="psub">{`${m.pledge ? `每月 ${money(m.pledge)}` : '金额不固定'} · ${range}`}</span>
                        {m.note ? <span className="psub">{m.note}</span> : null}
                      </span>
                    </button>
                    <span className="order-btns">
                      <button className="order-btn" onClick={() => mutate((s) => L.moveMember(s, m.id, -1))} aria-label={`把 ${m.name} 往上移`} disabled={i === 0}>↑</button>
                      <button className="order-btn" onClick={() => mutate((s) => L.moveMember(s, m.id, 1))} aria-label={`把 ${m.name} 往下移`} disabled={i === list.length - 1}>↓</button>
                    </span>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <div className="card empty"><p>还没有名单。可以一个一个添加，或者一次贴上多人。</p></div>
        )}
      </main>
    </>
  );
}

// ================================================================ settings
function SettingsView() {
  const st = S.state.settings;
  const sizes: [Settings['fontSize'], string][] = [['normal', '标准'], ['large', '大'], ['xlarge', '特大']];
  // Five quick taps on the version line open 恢复记录.
  const taps = useRef<{ n: number; timer: ReturnType<typeof setTimeout> | undefined }>({ n: 0, timer: undefined });
  const aboutTap = () => {
    const t = taps.current;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => { t.n = 0; }, 1500);
    if (++t.n >= 5) {
      t.n = 0;
      nav('#/restore');
    }
  };
  return (
    <>
      <Topbar title="设置" back />
      <main className="page">
        <section className="card">
          <h3 className="card-title">字体大小</h3>
          <div className="segmented" role="radiogroup" aria-label="字体大小">
            {sizes.map(([k, label]) => (
              <button key={k} role="radio" aria-checked={st.fontSize === k} data-action="font" data-size={k} onClick={() => setFontSize(k)}>{label}</button>
            ))}
          </div>
        </section>
        <section className="card">
          <h3 className="card-title">货币</h3>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              setCurrency((e.currentTarget.elements.namedItem('currency') as HTMLInputElement).value);
            }}
          >
            <input className="input" name="currency" defaultValue={st.currency} maxLength={8} aria-label="货币符号" />
            <button className="btn btn-secondary" type="submit">保存</button>
          </form>
        </section>
        <section className="card" data-role="account-card">
          <h3 className="card-title">家人登入</h3>
          {account() ? (
            <>
              <p>{`已登入：${account()!.email}`}</p>
              <SyncLine />
              <div className="btn-row">
                <button className="btn btn-secondary" data-action="sync-now" onClick={() => syncNow()}>现在同步</button>
                <button className="btn btn-ghost" data-action="sign-out" onClick={signOut}>登出</button>
              </div>
            </>
          ) : canSignIn() ? (
            <>
              <p className="muted">登入后，这部手机和家人的手机、电脑用同一本记录。</p>
              <GoogleButton />
            </>
          ) : (
            <p className="muted">在这个地址不能登入。</p>
          )}
          <button className="link-btn" data-action="open-public" onClick={go('#/public')}>看公开账目</button>
        </section>
        <p className="about" data-action="about-tap" onClick={aboutTap}>{`善款簿 ${APP_VERSION} · 不需要上网也能用`}</p>
      </main>
    </>
  );
}

/**
 * 公开账目, for anyone: each fund's money in, money handed over and balance, as the family
 * published it on the backup server. No names: the server sends only totals. This page never
 * reads or changes the records on this phone.
 */
function PublicView({ landing = false }: { landing?: boolean }) {
  const [state, setState] = useState<{ loading: boolean; data: PublicSummary | null; error: string | null }>({ loading: true, data: null, error: null });
  useEffect(() => {
    let live = true;
    fetchPublicAccounts().then(
      (data) => live && setState({ loading: false, data, error: null }),
      (e) => live && setState({ loading: false, data: null, error: e.message })
    );
    return () => { live = false; };
  }, []);
  const { loading, data, error } = state;
  const rm = (c: number) => L.fmtMoney(c, data ? data.currency : 'RM');
  const shortMonth = (m: string) => `${+m.slice(5, 7)}月`;
  const when = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <>
      <Topbar title="公开账目" back={!landing} />
      <main className="page" data-page="public">
        {landing && canSignIn() ? (
          <section className="card" data-role="family-sign-in">
            <p><strong>家人请登入</strong>，就能看到和修改完整的记录。</p>
            <GoogleButton />
          </section>
        ) : null}
        <section className="card">
          <p>{'这里公开每个项目的钱：收到多少、交出多少、手上还有多少。'}<br />{'不显示捐款人的名字，也不显示各人给了多少。'}</p>
          {data ? <p className="hint">{`${data.year} 年 · 更新于 ${when(data.updatedAt)}`}</p> : null}
        </section>
        {data && data.notice ? <div className="banner" role="note"><span className="banner-text">{data.notice}</span></div> : null}
        {loading ? <p className="muted" data-role="public-loading">正在载入…</p> : null}
        {error ? <div className="empty" data-role="public-error"><p>{error}</p></div> : null}
        {data
          ? data.funds.map((f) => (
              <section className="card pub-card" key={f.name} data-role="public-fund">
                <h2 className="fund-name">{f.name}</h2>
                {f.recipient ? <span className="fund-row"><span>交给</span><b>{f.recipient}</b></span> : null}
                <span className="fund-row"><span>名单上</span><b>{`${f.people} 个名字`}</b></span>
                {f.carriedIn ? <span className="fund-row"><span>{`${data.year - 1} 年留下`}</span><b>{rm(f.carriedIn)}</b></span> : null}
                <span className="fund-row"><span>{`${data.year} 年收到`}</span><b>{rm(f.received)}</b></span>
                <span className="fund-row"><span>{`${data.year} 年交出`}</span><b>{rm(f.paidOut)}</b></span>
                <span className="fund-row fund-row-strong"><span>手上应有</span><b className={f.onHand < 0 ? 'pub-neg' : undefined}>{rm(f.onHand)}</b></span>
                <details>
                  <summary>每月明细</summary>
                  <div className="grid-wrap" tabIndex={0} aria-label={`${f.name} 每月明细，可以左右滑动`}>
                    <table className="grid">
                      <thead><tr><th scope="col" className="name-col">月份</th><th scope="col">收到</th><th scope="col">交出</th><th scope="col">结余</th></tr></thead>
                      <tbody>
                        {f.months.map((m) => (
                          <tr key={m.month}>
                            <th scope="row" className="name-col">{shortMonth(m.month)}</th>
                            <td className="pub-cell">{m.received ? L.fmtNum(m.received) : ''}</td>
                            <td className="pub-cell">{m.paidOut ? L.fmtNum(m.paidOut) : ''}</td>
                            <td className={m.balance < 0 ? 'pub-cell pub-neg' : 'pub-cell'}>{L.fmtNum(m.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {f.payouts.length ? (
                    <>
                      <h3 className="section-label">交出的日期</h3>
                      <ul className="plist">
                        {f.payouts.map((p, i) => (
                          <li className="prow" key={i}><span className="pdate">{L.shortDate(p.date) + '/' + p.date.slice(0, 4)}</span><span className="pamt">{rm(p.amount)}</span></li>
                        ))}
                      </ul>
                    </>
                  ) : <p className="hint">{`${data.year} 年还没有交出的记录。`}</p>}
                </details>
              </section>
            ))
          : null}
        {landing ? <button className="link-btn" data-action="start-new" onClick={go('#/new')}>不登入，在这部手机另开一本簿子</button> : null}
      </main>
    </>
  );
}

/**
 * For the family, not for mum: how her records get onto a new phone (by the setup code the family
 * made, or from a backup file), and whether backups are reaching the backup server. Five taps on the version line in 设置 open it, because on iPhone a link
 * opens in Safari, never inside the installed app. #/restore also works.
 */
function RestoreView() {
  const state = S.state;
  const counts = `${state.funds.length} 个项目 · ${state.members.length} 人 · ${state.receipts.length} 笔收款 · ${state.payouts.length} 笔交出 · ${state.offerings.length} 次供养`;
  const when = (t: number) => new Date(t).toLocaleString('zh-CN');
  const ss = serverStatus();
  let autoState;
  if (ss.ok) autoState = `已自动备份：${when(ss.at!)}`;
  else if (ss.at) autoState = <>{`⚠ 这次没能自动备份（${ss.error}），有网络时会自动再试。`}{ss.lastOkAt ? <><br />{`上次成功：${when(ss.lastOkAt)}`}</> : null}</>;
  else autoState = '还没有自动备份。';
  const loadByCode = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    loadBookFromText(new FormData(e.currentTarget).get('code'));
  };
  return (
    <>
      <Topbar title="恢复记录" back />
      <main className="page">
        <section className="card">
          <p className="muted">{autoState}</p>
          <p>用家人给的备份文件，取代这部手机现在的记录。</p>
          <button className="btn btn-ghost btn-block" data-action="restore" onClick={() => document.getElementById('restore-file')!.click()}>从备份文件恢复</button>
          <p className="hint">{`这部手机现在有：${counts}`}</p>
        </section>
        <section className="card">
          <form onSubmit={loadByCode}>
            <label className="field"><span className="field-label">家人给的设置链接或设置码</span>
              <input className="input" name="code" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="贴在这里" /></label>
            <button className="btn btn-ghost btn-block" type="submit" data-action="load-book">用设置码载入记录</button>
          </form>
          <p className="hint">这部手机如果已经有记录，会先问过才取代。</p>
        </section>
      </main>
    </>
  );
}
