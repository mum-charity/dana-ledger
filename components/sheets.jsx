'use client';
/* 善款簿 — the sheets that slide up from the bottom: one form each. */
import { useRef, useState } from 'react';
import { S, L, mutate, money, cur, thisYear, nav, closeSheet, confirmBox, showToast, shareText, phone } from './store';

/** A named control inside a form (avoids clashes like form.name). */
const field = (form, name) => form.elements.namedItem(name);

/** What was true when the sheet opened. The form keeps showing that while a save is on its way out. */
const useOpened = (fn) => useState(fn)[0];

function SheetShell({ title, sub = '', error = '', onSubmit, children }) {
  return (
    <>
      <div className="sheet-backdrop" data-action="sheet-close" onClick={() => closeSheet()} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="sheet-head">
          <div><h2 id="sheet-title">{title}</h2>{sub ? <p className="sheet-sub">{sub}</p> : null}</div>
          <button type="button" className="sheet-x" data-action="sheet-close" aria-label="关闭" onClick={() => closeSheet()}>✕</button>
        </div>
        <form
          className="sheet-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (onSubmit) onSubmit(e.currentTarget);
          }}
        >
          {children}
          <p className="form-error" role="alert">{error}</p>
        </form>
      </div>
    </>
  );
}

function MonthOptions({ selected, allowNone = false, noneLabel = '' }) {
  const now = L.currentMonth();
  let from = `${thisYear() - 2}-01`;
  let to = `${thisYear() + 1}-12`;
  if (selected && selected < from) from = `${selected.slice(0, 4)}-01`;
  if (selected && selected > to) to = `${selected.slice(0, 4)}-12`;
  const opts = [];
  if (allowNone) opts.push(<option key="none" value="">{noneLabel}</option>);
  for (let m = from; m <= to; m = L.addMonths(m, 1)) {
    opts.push(<option key={m} value={m}>{`${L.monthLabel(m)}${m === now ? '（本月）' : ''}`}</option>);
  }
  return opts;
}

// ---------------------------------------------------------------- receipt sheet
function ReceiptSheet({ memberId, month }) {
  const { m, r } = useOpened(() => {
    const member = L.getMember(S.state, memberId);
    return { m: member, r: member ? L.receiptOf(S.state, memberId, month) : null };
  });
  const startAmount = m ? (r ? r.amount : m.pledge) : 0;
  const [amountText, setAmountText] = useState(startAmount ? L.fmtPlain(startAmount) : '');
  const [n, setN] = useState(1);
  const [error, setError] = useState('');
  if (!m) return null;

  let countHint = '';
  if (!r && n > 1) {
    const months = L.nextUnpaidMonths(S.state, memberId, month, n);
    const each = L.parseAmount(amountText);
    const span = months.length > 1 ? `${L.monthLabel(months[0])} 到 ${L.monthLabel(months[months.length - 1])}` : L.monthLabel(months[0]);
    const skipped = months.length && months[months.length - 1] !== L.addMonths(month, n - 1) ? '（已付的月份会跳过）' : '';
    countHint = `${span}，共 ${n} 个月${each ? `，合计 ${money(each * n)}` : ''}${skipped}`;
  }

  const submit = (form) => {
    setError('');
    const amt = L.parseAmount(field(form, 'amount').value);
    if (!amt) return setError('请输入正确的金额，例如 10 或 10.50');
    const date = field(form, 'date').value;
    if (!L.isDate(date)) return setError('请选择收到的日期');
    const note = field(form, 'note').value;
    if (r || n === 1) {
      mutate((s) => L.setReceipt(s, { memberId, month, amount: amt, date, note }));
      closeSheet();
      showToast(r ? '已修改' : `已记录：${m.name} ${L.monthShort(month)} ${money(amt)}`);
    } else {
      const made = mutate((s) => L.prepay(s, { memberId, fromMonth: month, count: n, amountEach: amt, date, note }));
      closeSheet();
      showToast(`已记录 ${made.length} 个月，合计 ${money(amt * made.length)}`, {
        actionLabel: '撤销',
        action: () => mutate((s) => made.forEach((x) => L.removeReceipt(s, x.memberId, x.month))),
      });
    }
  };

  const remove = async () => {
    const yes = await confirmBox({ title: '取消这笔收款？', message: `${m.name} ${L.monthLabel(month)} ${money(r.amount)}`, ok: '是，取消收款', danger: true });
    if (!yes) return;
    const removed = mutate((s) => L.removeReceipt(s, memberId, month));
    closeSheet();
    showToast('已取消这笔收款', { actionLabel: '撤销', action: () => mutate((s) => L.restoreReceipt(s, removed)) });
  };

  return (
    <SheetShell title={m.name} sub={`${L.monthLabel(month)}${m.pledge ? ` · 每月 ${money(m.pledge)}` : ''}`} error={error} onSubmit={submit}>
      <label className="field"><span className="field-label" data-role="amount-label">{n > 1 ? `每个月金额（${cur()}）` : `金额（${cur()}）`}</span>
        <input className="input input-money" name="amount" inputMode="decimal" autoComplete="off" defaultValue={amountText} placeholder="0" data-autofocus={startAmount ? undefined : ''} onChange={(e) => setAmountText(e.target.value)} /></label>
      <label className="field"><span className="field-label">收到日期</span>
        <input className="input" type="date" name="date" defaultValue={r ? r.date : L.todayISO()} /></label>
      {r ? null : (
        <div className="field"><span className="field-label">这次付了几个月？</span>
          <div className="stepper">
            <button type="button" className="step" data-action="step" data-d="-1" aria-label="少一个月" onClick={() => setN(Math.max(1, n - 1))}>−</button>
            <output className="step-val" data-role="count">{n}</output>
            <button type="button" className="step" data-action="step" data-d="1" aria-label="多一个月" onClick={() => setN(Math.min(24, n + 1))}>＋</button>
          </div>
          <p className="hint" data-role="count-hint">{countHint}</p>
        </div>
      )}
      <label className="field"><span className="field-label">备注（可以不填）</span>
        <input className="input" name="note" defaultValue={r ? r.note : ''} placeholder="例如：转账、已付全年" autoComplete="off" /></label>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary btn-block">{r ? '保存修改' : '✓ 确认收到'}</button>
        {r ? <button type="button" className="btn btn-danger btn-block" data-action="receipt-delete" onClick={remove}>取消这笔收款</button> : null}
      </div>
    </SheetShell>
  );
}

// ---------------------------------------------------------------- payout sheet
function PayoutSheet({ fundId, id, month }) {
  const { p, notes } = useOpened(() => ({
    p: id ? L.getPayout(S.state, id) : null,
    notes: [...new Set(S.state.payouts.filter((x) => x.fundId === fundId && x.note).map((x) => x.note))].slice(-12),
  }));
  const [mo, setMo] = useState(p ? p.month : month);
  const [error, setError] = useState('');
  const amountRef = useRef(null);

  const sm = L.monthSummary(S.state, fundId, mo);
  const left = sm.received - sm.paidOut + (p && p.month === mo ? p.amount : 0);

  const submit = (form) => {
    setError('');
    const amount = L.parseAmount(field(form, 'amount').value);
    if (!amount) return setError('请输入正确的金额');
    const data = { fundId, month: field(form, 'month').value, date: field(form, 'date').value, amount, note: field(form, 'note').value };
    try {
      mutate((s) => (p ? L.updatePayout(s, p.id, data) : L.addPayout(s, data)));
    } catch (e) {
      return setError(e.message);
    }
    closeSheet();
    showToast(p ? '已修改' : `已记录交出 ${money(amount)}`);
  };

  const remove = async () => {
    const yes = await confirmBox({ title: '删除这笔交钱记录？', message: `${L.shortDate(p.date)} ${money(p.amount)} ${p.note}`, ok: '是，删除', danger: true });
    if (!yes) return;
    const removed = mutate((s) => L.removePayout(s, p.id));
    closeSheet();
    showToast('已删除', { actionLabel: '撤销', action: () => mutate((s) => L.restorePayout(s, removed)) });
  };

  return (
    <SheetShell title={p ? '修改交钱 / 支出' : '记录交钱 / 支出'} error={error} onSubmit={submit}>
      <label className="field"><span className="field-label">属于哪个月</span>
        <select className="input" name="month" defaultValue={mo} onChange={(e) => setMo(e.target.value)}><MonthOptions selected={p ? p.month : month} /></select></label>
      <label className="field"><span className="field-label">交钱日期</span>
        <input className="input" type="date" name="date" defaultValue={p ? p.date : L.todayISO()} /></label>
      <label className="field"><span className="field-label">{`金额（${cur()}）`}</span>
        <input ref={amountRef} className="input input-money" name="amount" inputMode="decimal" autoComplete="off" defaultValue={p ? L.fmtPlain(p.amount) : ''} placeholder="0" data-autofocus={p ? undefined : ''} /></label>
      <p className="hint" data-role="month-hint">
        {`${L.monthLabel(mo)}已收 ${money(sm.received)}${!p && left > 0 ? ' ' : ''}`}
        {!p && left > 0 ? <><button type="button" className="link-btn" data-action="fill-amount" onClick={() => { amountRef.current.value = L.fmtPlain(left); }}>{`填入 ${money(left)}`}</button></> : null}
      </p>
      <label className="field"><span className="field-label">交给谁 / 用在哪里</span>
        <input className="input" name="note" list="payout-notes" defaultValue={p ? p.note : ''} placeholder="例如：交给 Bhante、做茶点" autoComplete="off" /></label>
      <datalist id="payout-notes">{notes.map((n) => <option key={n} value={n} />)}</datalist>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary btn-block">保存</button>
        {p ? <button type="button" className="btn btn-danger btn-block" data-action="payout-delete" onClick={remove}>删除这笔记录</button> : null}
      </div>
    </SheetShell>
  );
}

// ---------------------------------------------------------------- offering sheet
/**
 * One 供养. The same people give most days and the dedication hardly changes, so a new one starts
 * with the last one's names (amounts empty) and its dedication. A row left without an amount is
 * someone who did not give that day, and is not saved.
 */
function OfferingSheet({ id }) {
  const { o, last, recipients } = useOpened(() => ({
    o: id ? L.getOffering(S.state, id) : null,
    last: L.offeringsSorted(S.state)[0] || null,
    recipients: [...new Set(L.offeringsSorted(S.state).map((x) => x.recipient))].slice(0, 12),
  }));
  const seq = useRef(0);
  const row = (name = '', amount = '') => ({ key: ++seq.current, name, amount });
  const [rows, setRows] = useState(() => {
    if (o) return o.lines.map((l) => row(l.name, L.fmtPlain(l.amount)));
    if (last) return last.lines.map((l) => row(l.name));
    return [row(), row(), row()];
  });
  const [error, setError] = useState('');
  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const total = rows.reduce((t, r) => t + (L.parseAmount(r.amount) || 0), 0);

  const submit = (form) => {
    setError('');
    const lines = [];
    for (const r of rows) {
      if (!r.amount.trim()) continue;
      const amount = L.parseAmount(r.amount);
      if (!amount) return setError(`「${r.name.trim() || '没有名字的那一行'}」的金额不对`);
      lines.push({ name: r.name, amount });
    }
    const data = { date: field(form, 'date').value, recipient: field(form, 'recipient').value, lines, dedication: field(form, 'dedication').value, note: field(form, 'note').value };
    try {
      mutate((s) => (o ? L.updateOffering(s, o.id, data) : L.addOffering(s, data)));
    } catch (e) {
      return setError(e.message);
    }
    closeSheet();
    showToast(o ? '已修改' : `已记录供养 ${money(total)}`);
  };

  const remove = async () => {
    const yes = await confirmBox({ title: '删除这笔供养记录？', message: `${L.shortDate(o.date)} ${o.recipient} ${money(L.offeringTotal(o))}`, ok: '是，删除', danger: true });
    if (!yes) return;
    const removed = mutate((s) => L.removeOffering(s, o.id));
    closeSheet();
    showToast('已删除', { actionLabel: '撤销', action: () => mutate((s) => L.restoreOffering(s, removed)) });
  };

  return (
    <SheetShell title={o ? '修改供养' : '记录供养'} error={error} onSubmit={submit}>
      <label className="field"><span className="field-label">日期</span>
        <input className="input" type="date" name="date" defaultValue={o ? o.date : L.todayISO()} /></label>
      <label className="field"><span className="field-label">供养给谁</span>
        <input className="input" name="recipient" list="offering-recipients" defaultValue={o ? o.recipient : ''} placeholder="例如：法悦林僧团午餐" autoComplete="off" data-autofocus={o ? undefined : ''} /></label>
      <datalist id="offering-recipients">{recipients.map((n) => <option key={n} value={n} />)}</datalist>

      <div className="field">
        <span className="field-label">{`谁出多少（${cur()}）`}</span>
        {!o && last ? <p className="hint">名字照上一次的。今天没出的人，金额留空就可以。</p> : null}
        <ul className="olines">
          {rows.map((r, i) => (
            <li key={r.key} className="oline">
              <input className="input" aria-label={`第 ${i + 1} 个名字`} data-role="oline-name" value={r.name} placeholder="名字" autoComplete="off" onChange={(e) => setRow(r.key, { name: e.target.value })} />
              <input className="input oline-amt" aria-label={`${r.name || `第 ${i + 1} 个人`} 的金额`} data-role="oline-amount" value={r.amount} placeholder="0" inputMode="decimal" autoComplete="off" onChange={(e) => setRow(r.key, { amount: e.target.value })} />
              <button type="button" className="oline-x" aria-label={`拿掉 ${r.name || `第 ${i + 1} 行`}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-ghost btn-block" data-action="oline-add" onClick={() => setRows((rs) => [...rs, row()])}>＋ 加一个人</button>
        <p className="ototal" data-role="offering-total"><span>合计</span><b>{money(total)}</b></p>
      </div>

      <label className="field"><span className="field-label">回向功德给</span>
        <textarea className="input textarea" name="dedication" defaultValue={o ? o.dedication : last ? last.dedication : ''} placeholder={'一行一个，例如：\n吴门历代祖先\n十方法界一切众生'} /></label>
      <label className="field"><span className="field-label">备注</span>
        <input className="input" name="note" defaultValue={o ? o.note : ''} placeholder="例如：General Fund 收据号码" autoComplete="off" /></label>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary btn-block">保存</button>
        {o ? <button type="button" className="btn btn-secondary btn-block" data-action="offering-share" onClick={() => shareText(L.offeringShareText(o, cur()))}>分享这次供养（WhatsApp）</button> : null}
        {o ? <button type="button" className="btn btn-danger btn-block" data-action="offering-delete" onClick={remove}>删除这笔记录</button> : null}
      </div>
    </SheetShell>
  );
}

// ---------------------------------------------------------------- member sheets
function MemberSheet({ fundId, id }) {
  const { m, hasReceipts } = useOpened(() => {
    const member = id ? L.getMember(S.state, id) : null;
    return { m: member, hasReceipts: !!member && L.memberHasReceipts(S.state, member.id) };
  });
  const [error, setError] = useState('');

  const submit = (form) => {
    setError('');
    const pledgeRaw = field(form, 'pledge').value.trim();
    const pledge = pledgeRaw ? L.parseAmount(pledgeRaw) : 0;
    if (pledge == null) return setError('每月金额不对，例如 10 或留空');
    const data = { fundId, name: field(form, 'name').value, pledge, startMonth: field(form, 'startMonth').value, endMonth: field(form, 'endMonth').value || null, note: field(form, 'note').value };
    try {
      mutate((s) => (m ? L.updateMember(s, m.id, data) : L.addMember(s, data)));
    } catch (e) {
      return setError(e.message);
    }
    closeSheet();
    showToast(m ? '已保存' : `已添加：${data.name.trim()}`);
  };

  const remove = async () => {
    const yes = await confirmBox({ title: `删除「${m.name}」？`, ok: '是，删除', danger: true });
    if (!yes) return;
    try {
      mutate((s) => L.deleteMember(s, m.id));
    } catch (e) {
      return setError(e.message);
    }
    closeSheet();
    showToast('已删除');
  };

  return (
    <SheetShell title={m ? '修改资料' : '添加一人'} error={error} onSubmit={submit}>
      <label className="field"><span className="field-label">名字</span>
        <input className="input" name="name" defaultValue={m ? m.name : ''} placeholder="例如：陈美玲 / 陈家合家" autoComplete="off" data-autofocus={m ? undefined : ''} /></label>
      <label className="field"><span className="field-label">{`每月金额（${cur()}）`}</span>
        <input className="input input-money" name="pledge" inputMode="decimal" autoComplete="off" defaultValue={m && m.pledge ? L.fmtPlain(m.pledge) : ''} placeholder="不固定就留空" /></label>
      <label className="field"><span className="field-label">从哪个月开始</span>
        <select className="input" name="startMonth" defaultValue={m ? m.startMonth : L.currentMonth()}><MonthOptions selected={m ? m.startMonth : L.currentMonth()} /></select></label>
      <label className="field"><span className="field-label">到哪个月停止</span>
        <select className="input" name="endMonth" defaultValue={(m && m.endMonth) || ''}><MonthOptions selected={m ? m.endMonth : null} allowNone noneLabel="一直捐（没有停止）" /></select></label>
      <label className="field"><span className="field-label">备注（可以不填）</span>
        <input className="input" name="note" defaultValue={m ? m.note : ''} placeholder="例如：已故、电话号码" autoComplete="off" /></label>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary btn-block">保存</button>
        {m ? (
          hasReceipts
            ? <p className="hint">这个人已有收款记录，所以不能删除。如果不再捐，请设定“到哪个月停止”。</p>
            : <button type="button" className="btn btn-danger btn-block" data-action="member-delete" onClick={remove}>删除这个人</button>
        ) : null}
      </div>
    </SheetShell>
  );
}

function BulkSheet({ fundId }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const rows = L.parseBulkMembers(text);

  const submit = (form) => {
    setError('');
    const list = L.parseBulkMembers(field(form, 'text').value);
    if (!list.length) return setError('请先输入名单');
    try {
      mutate((s) => L.addMembersBulk(s, fundId, list, field(form, 'startMonth').value));
    } catch (e) {
      return setError(e.message);
    }
    closeSheet();
    showToast(`已添加 ${list.length} 人`);
  };

  return (
    <SheetShell title="一次添加多人" sub="每行一个人：名字，后面加每月金额" error={error} onSubmit={submit}>
      <label className="field"><span className="field-label">名单</span>
        <textarea className="input textarea" name="text" rows={8} placeholder={'陈美玲 10\n林志明、黄淑芬 20\nTan Ah Kow 合家 10\n王小华'} data-autofocus="" onChange={(e) => setText(e.target.value)} /></label>
      <label className="field"><span className="field-label">从哪个月开始</span>
        <select className="input" name="startMonth" defaultValue={L.currentMonth()}><MonthOptions selected={L.currentMonth()} /></select></label>
      <p className="hint">如果选更早的月份，那些月份会显示红色（未收），要在「全年表」里把旧记录补上。只想从现在开始记，就选本月。</p>
      <div className="bulk-preview" data-role="preview">
        {rows.length ? (
          <>
            <p className="section-label">会添加：</p>
            <ol className="preview-list">
              {rows.map((r, i) => <li key={i}><span>{r.name}</span><span>{r.pledge ? money(r.pledge) : <span className="muted">不固定</span>}</span></li>)}
            </ol>
          </>
        ) : null}
      </div>
      <div className="sheet-actions"><button type="submit" className="btn btn-primary btn-block" data-role="bulk-submit">{rows.length ? `添加 ${rows.length} 人` : '添加'}</button></div>
    </SheetShell>
  );
}

// ---------------------------------------------------------------- fund sheet
function FundSheet({ id }) {
  const f = useOpened(() => (id ? L.getFund(S.state, id) : null));
  const [error, setError] = useState('');

  const submit = (form) => {
    setError('');
    const raw = field(form, 'opening').value.trim();
    const opening = raw ? L.parseAmount(raw) : 0;
    if (opening == null) return setError('金额不对');
    const data = { name: field(form, 'name').value, opening, note: field(form, 'note').value };
    let created;
    try {
      created = mutate((s) => (f ? L.updateFund(s, f.id, data) : L.addFund(s, data)));
    } catch (e) {
      return setError(e.message);
    }
    closeSheet().then(() => {
      if (!f) nav(`#/f/${created.id}/p`);
    });
    showToast(f ? '已保存' : '项目已建立，现在添加名单');
  };

  const remove = async () => {
    const people = L.fundMembers(S.state, f.id).length;
    const recs = S.state.receipts.filter((r) => r.fundId === f.id).length + S.state.payouts.filter((p) => p.fundId === f.id).length;
    const yes = await confirmBox({
      title: `删除整个「${f.name}」？`,
      message: <>{`会同时删除 ${people} 人和 ${recs} 笔记录。`}<strong>删除后不能恢复</strong>（除非有备份）。</>,
      ok: '是，全部删除',
      danger: true,
    });
    if (!yes) return;
    await closeSheet();
    mutate((s) => L.deleteFund(s, f.id));
    nav('#/', true);
    showToast('项目已删除');
  };

  return (
    <SheetShell title={f ? '修改项目' : '新增项目'} error={error} onSubmit={submit}>
      <label className="field"><span className="field-label">项目名称</span>
        <input className="input" name="name" defaultValue={f ? f.name : ''} placeholder="例如：Bhante 医疗费用" autoComplete="off" data-autofocus={f ? undefined : ''} /></label>
      <label className="field"><span className="field-label">{`开始时手上已有的钱（${cur()}）`}</span>
        <input className="input input-money" name="opening" inputMode="decimal" autoComplete="off" defaultValue={f && f.opening ? L.fmtPlain(f.opening) : ''} placeholder="没有就留空" /></label>
      <p className="hint">开始用这个 App 之前，这个项目已经存下的钱。</p>
      <label className="field"><span className="field-label">说明（可以不填）</span>
        <input className="input" name="note" defaultValue={f ? f.note : ''} placeholder="例如：师父看脊椎治疗" autoComplete="off" /></label>
      <div className="sheet-actions">
        <button type="submit" className="btn btn-primary btn-block">保存</button>
        {f ? <button type="button" className="btn btn-danger btn-block" data-action="fund-delete" onClick={remove}>删除整个项目</button> : null}
      </div>
    </SheetShell>
  );
}

function NoteSheet({ fundId, month }) {
  const start = useOpened(() => {
    const f = L.getFund(S.state, fundId);
    return (f && f.monthNotes && f.monthNotes[month]) || '';
  });
  const submit = (form) => {
    mutate((s) => L.setMonthNote(s, fundId, month, field(form, 'text').value));
    closeSheet();
  };
  return (
    <SheetShell title="本月备注" sub={L.monthLabel(month)} onSubmit={submit}>
      <label className="field"><span className="field-label visually-hidden">备注</span>
        <textarea className="input textarea" name="text" rows={5} placeholder="例如：9/1 看医生，谁出油钱" data-autofocus="" defaultValue={start} /></label>
      <div className="sheet-actions"><button type="submit" className="btn btn-primary btn-block">保存</button></div>
    </SheetShell>
  );
}

// ---------------------------------------------------------------- add to home screen
function InstallSheet() {
  const again = '再点一次「添加到手机主屏幕」';
  let title = '添加到手机主屏幕';
  let note = '如果主屏幕上已经有「善款簿」，直接点图标打开就可以。';
  let steps;
  if (phone.inAppBrowser) {
    title = '请先用浏览器打开';
    steps = ['点右上角的菜单（⋯ 或 ⋮）', '选「在浏览器中打开」（iPhone 用 Safari，Android 用 Chrome）', `在浏览器里${again}`];
  } else if (phone.ios && phone.iosOtherBrowser) {
    title = '请先用 Safari 打开';
    steps = ['打开 Safari', <>在地址栏输入：<b>{location.host + location.pathname}</b></>, `在 Safari 里${again}`];
  } else if (phone.ios) {
    steps = [
      '点下面的「分享」按钮（方框加向上的箭头）。看不到的话，先点右下角的「⋯」',
      '往下滑，点「添加到主屏幕」',
      '点右上角的「添加」',
      '以后从主屏幕的「善款簿」图标打开，再开始记录',
    ];
    if (S.state.funds.length) note = '注意：iPhone 主屏幕的善款簿和 Safari 里的是分开的，这里已有的记录不会自动带过去。请先告诉家人。';
  } else {
    steps = ['点浏览器右上角的菜单（⋮）', '点「安装应用」或「添加到主屏幕」', '按提示确认，主屏幕就会出现「善款簿」图标'];
  }
  return (
    <SheetShell title={title}>
      <ol className="install-steps">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      <p className="hint">{note}</p>
      <div className="sheet-actions"><button type="button" className="btn btn-primary btn-block" data-action="sheet-close" onClick={() => closeSheet()}>知道了</button></div>
    </SheetShell>
  );
}

export const SHEETS = {
  receipt: ReceiptSheet,
  payout: PayoutSheet,
  offering: OfferingSheet,
  member: MemberSheet,
  bulk: BulkSheet,
  fund: FundSheet,
  note: NoteSheet,
  install: InstallSheet,
};
