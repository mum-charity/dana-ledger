/*
 * Types for lib/model.js, the 善款簿 data rules. The rules themselves are still plain JavaScript,
 * shared by the app and the backup server; this file describes the parts the server and its
 * tests use, so they can be checked. Money is integer cents; months are 'YYYY-MM' and dates
 * 'YYYY-MM-DD'.
 */
declare namespace Ledger {
  interface Settings {
    currency: string;
    fontSize: 'normal' | 'large' | 'xlarge';
    lastBackupAt: number | null;
    changesSinceBackup: number;
  }
  interface Fund {
    id: string;
    name: string;
    opening: number;
    note: string;
    monthNotes: Record<string, string>;
    createdAt: number;
  }
  interface Member {
    id: string;
    fundId: string;
    name: string;
    pledge: number;
    startMonth: string;
    endMonth: string | null;
    note: string;
    order: number;
    createdAt: number;
  }
  interface Receipt {
    id: string;
    fundId: string;
    memberId: string;
    month: string;
    amount: number;
    date: string;
    note: string;
    createdAt: number;
  }
  interface Payout {
    id: string;
    fundId: string;
    month: string;
    date: string;
    amount: number;
    note: string;
    createdAt: number;
  }
  interface OfferingLine {
    name: string;
    amount: number;
  }
  interface Offering {
    id: string;
    date: string;
    recipient: string;
    lines: OfferingLine[];
    dedication: string;
    note: string;
    createdAt: number;
  }
  interface State {
    schema: number;
    settings: Settings;
    funds: Fund[];
    members: Member[];
    receipts: Receipt[];
    payouts: Payout[];
    offerings: Offering[];
  }
  /** A backup file: the records wrapped with the app's name and when it was made. */
  interface Backup {
    app: string;
    schema: number;
    exportedAt: string;
    data: State;
  }
}

declare const Ledger: {
  emptyState(): Ledger.State;
  /** Checks and cleans records from storage or a backup. Throws if it is not a ledger at all. */
  normalizeState(raw: unknown): { state: Ledger.State; dropped: number };
  backupJSON(s: Ledger.State): string;

  addFund(s: Ledger.State, fund: { name: string; opening?: number; note?: string }): Ledger.Fund;
  setMonthNote(s: Ledger.State, fundId: string, month: string, text: string): void;
  addMember(s: Ledger.State, member: { fundId: string; name: string; pledge?: number; startMonth: string; endMonth?: string | null; note?: string }): Ledger.Member;
  setReceipt(s: Ledger.State, receipt: { memberId: string; month: string; amount: number; date: string; note?: string }): Ledger.Receipt;
  prepay(s: Ledger.State, payment: { memberId: string; fromMonth: string; count: number; amountEach: number; date: string; note?: string }): Ledger.Receipt[];
  addPayout(s: Ledger.State, payout: { fundId: string; month: string; date: string; amount: number; note?: string }): Ledger.Payout;
  addOffering(s: Ledger.State, offering: { date: string; recipient: string; lines: Ledger.OfferingLine[]; dedication?: string; note?: string }): Ledger.Offering;

  parseAmount(input: unknown): number | null;
  /** 1234500 -> 'RM 12,345' */
  fmtMoney(cents: number, currency?: string): string;
  cashOnHand(s: Ledger.State, fundId: string): number;
  balanceThrough(s: Ledger.State, fundId: string, month: string): number;
};

export = Ledger;
