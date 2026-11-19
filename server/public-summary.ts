/*
 * 善款簿 public accounts: what anyone may see about the funds, made from mum's book.
 *
 * Only money totals leave the book: for each fund the family chose to show, how many people give,
 * what came in and went out each month, the balance, and the date and amount of each hand-over.
 * Nothing written by hand is copied: no names of people, no notes, no reference numbers, and
 * no 供养记录. Whom a fund's money goes to comes only from the label the family supplies.
 *
 * The output is built field by field from numbers and the family's own labels, never by copying
 * an object from the book, so a field added to the book later cannot slip into it.
 */
import L from '../lib/model.js';
import { httpError } from './backup-core.ts';

export const PUBLIC_APP = 'dana-ledger-public';

/** One fund to show, as the family chose it. */
export interface PublicFundChoice {
  /** The fund's name exactly as in the book. */
  name: string;
  /** Whom its money is handed to, as the public should read it (an organisation, not a person). */
  recipient?: string;
}

export interface PublicMonth {
  month: string;
  received: number;
  paidOut: number;
  /** Money on hand at the end of the month. */
  balance: number;
}

export interface PublicFund {
  name: string;
  recipient: string | null;
  /** How many names are on the fund's list (a name may be a family or a group). */
  people: number;
  /** On hand before the year began. */
  carriedIn: number;
  received: number;
  paidOut: number;
  onHand: number;
  months: PublicMonth[];
  payouts: { date: string; amount: number }[];
}

export interface PublicSummary {
  app: typeof PUBLIC_APP;
  version: 1;
  updatedAt: string;
  currency: string;
  year: number;
  /** A line from the family shown above the accounts, for example that they are still being checked. */
  notice: string;
  funds: PublicFund[];
}

/** What the family sends to publish (PUT /public). */
export interface PublicRequest {
  book: unknown;
  funds: PublicFundChoice[];
  year?: number;
  notice?: string;
}

const MAX_FUNDS = 50;
const label = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const pad2 = (n: number) => String(n).padStart(2, '0');

export function publicSummary(request: PublicRequest, now: number): PublicSummary {
  if (!request || typeof request !== 'object') throw httpError(400, 'expected { book, funds }');
  let parsed: ReturnType<typeof L.normalizeState>;
  try {
    parsed = L.normalizeState(request.book);
  } catch (_) {
    throw httpError(400, 'book is not a 善款簿 backup');
  }
  if (parsed.dropped) throw httpError(422, `${parsed.dropped} records in this book are not valid`);
  const s = parsed.state;

  const choices = Array.isArray(request.funds) ? request.funds : [];
  if (!choices.length) throw httpError(422, 'choose at least one fund to show');
  if (choices.length > MAX_FUNDS) throw httpError(422, `at most ${MAX_FUNDS} funds`);
  const year = request.year === undefined ? new Date(now).getFullYear() : request.year;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw httpError(422, 'year is not a year');
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`);

  const seen = new Set<string>();
  const funds: PublicFund[] = choices.map((choice) => {
    const name = label(choice && choice.name, 60);
    const fund = s.funds.find((f) => f.name === name);
    if (!fund) throw httpError(422, `no fund named "${name}" in this book`);
    if (seen.has(fund.id)) throw httpError(422, `"${name}" is chosen twice`);
    seen.add(fund.id);

    const receipts = s.receipts.filter((r) => r.fundId === fund.id);
    const payouts = s.payouts.filter((p) => p.fundId === fund.id);
    const sumWhere = <T extends { month: string; amount: number }>(list: T[], keep: (month: string) => boolean) =>
      list.reduce((t, x) => (keep(x.month) ? t + x.amount : t), 0);
    const first = months[0];
    const last = months[11];
    const carriedIn = fund.opening + sumWhere(receipts, (m) => m < first) - sumWhere(payouts, (m) => m < first);

    let balance = carriedIn;
    const perMonth: PublicMonth[] = months.map((month) => {
      const received = sumWhere(receipts, (m) => m === month);
      const paidOut = sumWhere(payouts, (m) => m === month);
      balance += received - paidOut;
      return { month, received, paidOut, balance };
    });
    return {
      name: fund.name,
      recipient: label(choice.recipient, 80) || null,
      people: s.members.filter((m) => m.fundId === fund.id).length,
      carriedIn,
      received: sumWhere(receipts, (m) => m >= first && m <= last),
      paidOut: sumWhere(payouts, (m) => m >= first && m <= last),
      // Everything, including months after this year that were paid ahead.
      onHand: carriedIn + sumWhere(receipts, (m) => m >= first) - sumWhere(payouts, (m) => m >= first),
      months: perMonth,
      payouts: payouts
        .filter((p) => p.month >= first && p.month <= last)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        .map((p) => ({ date: p.date, amount: p.amount })),
    };
  });

  return {
    app: PUBLIC_APP,
    version: 1,
    updatedAt: new Date(now).toISOString(),
    currency: label(s.settings.currency, 8) || 'RM',
    year,
    notice: label(request.notice, 300),
    funds,
  };
}
