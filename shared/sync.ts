/*
 * 善款簿 — one book shared by the family's phones and computers.
 *
 * Each device keeps the whole book and works without signal, as before. When it can reach the
 * backup server it fetches the family's newest version, combines it with its own records, and
 * sends back the result. The server takes a write only from a device that has seen the newest
 * version (see server/backup-core.ts), so nothing here can overwrite work it has not looked at.
 *
 * Combining needs to know what changed on each side, not just how the two books differ. A record
 * here but not there was either added here or deleted there. So after every sync the device
 * keeps a fingerprint of each record as it was then (`Hashes`), and compares both sides with it:
 *
 *   changed on one side only          that side's version is kept
 *   changed on both sides             this device's version is kept (it is the later to sync)
 *   deleted on one side, untouched    it stays deleted
 *   deleted on one side, changed      the change is kept: an edit is never lost to a delete
 *
 * This file has no screen and no storage of its own, so it runs in the app and in the tests.
 */
import L, { type Receipt, type State } from '../lib/model.ts';

/** Fingerprint of every record at the last sync, by kind and id: { "r:abc123": "9x8k2…" }. */
export type Hashes = Record<string, string>;

/** What a device remembers between syncs. */
export interface SyncMeta {
  /** The family book's version this device last combined with. */
  version: number;
  hashes: Hashes;
}

type AnyRecord = { id: string; createdAt?: number };
const KINDS = [
  ['f', 'funds'],
  ['m', 'members'],
  ['r', 'receipts'],
  ['p', 'payouts'],
  ['o', 'offerings'],
] as const;
type Kind = (typeof KINDS)[number][1];

/** The records as the app saves them: the same fields in the same shape on every device. */
function tidy(state: State): State {
  const { state: clean, dropped } = L.normalizeState(JSON.parse(JSON.stringify(state)));
  if (dropped) throw new Error(`${dropped} records in this book are not valid`);
  return clean;
}

/** JSON with the keys of every object in order, so the same record always reads the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A 53-bit fingerprint of a string (cyrb53). Not for secrets: only to tell "same" from "changed". */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function hashesOfTidy(state: State): Hashes {
  const out: Hashes = {};
  for (const [letter, kind] of KINDS) for (const record of state[kind] as AnyRecord[]) out[`${letter}:${record.id}`] = fingerprint(stable(record));
  return out;
}

/** The fingerprint of every record in a book. Settings are not part of it: they belong to each device. */
export function hashesOf(state: State): Hashes {
  return hashesOfTidy(tidy(state));
}

export function sameHashes(a: Hashes, b: Hashes): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

export interface Merged {
  /** The combined book, to become this device's records. */
  state: State;
  hashes: Hashes;
  /** The combined book differs from what this device had: show it. */
  changedHere: boolean;
  /** The combined book differs from the family's version: send it. */
  changedThere: boolean;
}

/**
 * Combine this device's records with the family's newest version. `base` is the fingerprints
 * from the last sync; an empty `base` means nothing is known to have been deleted, so every
 * record on either side is kept.
 */
export function merge(localState: State, remoteState: State, base: Hashes): Merged {
  const local = tidy(localState);
  const remote = tidy(remoteState);
  const hLocal = hashesOfTidy(local);
  const hRemote = hashesOfTidy(remote);

  const out = L.emptyState();
  // Settings (text size, currency sign, backup counters) are this device's own and are not shared.
  out.settings = { ...local.settings };

  for (const [letter, kind] of KINDS) {
    const here = new Map((local[kind] as AnyRecord[]).map((r) => [r.id, r]));
    const kept: AnyRecord[] = [];
    // The family's order first, so every device ends up listing things the same way.
    for (const theirs of remote[kind] as AnyRecord[]) {
      const key = `${letter}:${theirs.id}`;
      const mine = here.get(theirs.id);
      const was = base[key];
      if (mine) {
        // On both sides. Theirs wins only if this device has not touched it since the last sync.
        kept.push(hLocal[key] !== hRemote[key] && hLocal[key] === was ? theirs : mine);
      } else if (was === undefined || hRemote[key] !== was) {
        // Not here: either new on their side, or deleted here but changed there since. Keep it.
        kept.push(theirs);
      }
      // else: deleted here, untouched there. It stays deleted.
    }
    const there = new Set((remote[kind] as AnyRecord[]).map((r) => r.id));
    const mineOnly = (local[kind] as AnyRecord[]).filter((mine) => {
      if (there.has(mine.id)) return false;
      const key = `${letter}:${mine.id}`;
      // Not there: either new here, or deleted there but changed here since. Keep it.
      // If it was synced before and is untouched here, they deleted it: it goes.
      return base[key] === undefined || hLocal[key] !== base[key];
    });
    (out[kind] as AnyRecord[]) = kept.concat(mineOnly);
  }

  // What the combined records must still obey: nothing may point at a fund or person that is
  // gone, and a person has one payment a month.
  const funds = new Set(out.funds.map((f) => f.id));
  out.members = out.members.filter((m) => funds.has(m.fundId));
  out.payouts = out.payouts.filter((p) => funds.has(p.fundId));
  const people = new Set(out.members.map((m) => m.id));
  const byMonth = new Map<string, Receipt>();
  for (const r of out.receipts) {
    if (!people.has(r.memberId)) continue;
    const key = `${r.memberId}|${r.month}`;
    const other = byMonth.get(key);
    // Two devices both ticked this person for this month. Keep the later one; every device
    // picks the same one, whichever order they sync in.
    if (!other || r.createdAt > other.createdAt || (r.createdAt === other.createdAt && r.id > other.id)) byMonth.set(key, r);
  }
  const winners = new Set(byMonth.values());
  out.receipts = out.receipts.filter((r) => winners.has(r));

  const state = tidy(out);
  const hashes = hashesOfTidy(state);
  return { state, hashes, changedHere: !sameHashes(hashes, hLocal), changedThere: !sameHashes(hashes, hRemote) };
}

// ================================================================ talking to the server

export interface SyncDeps {
  /** The backup server's address. */
  server: string;
  /** The family session from signing in, or null. */
  session(): string | null;
  /** This device's records, as they are right now. */
  local(): State;
  /** Make `state` this device's records. `replacing` is true when its own, unrelated records are being set aside. */
  apply(state: State, replacing: boolean): void;
  meta(): SyncMeta | null;
  setMeta(meta: SyncMeta): void;
  /** This device has records of its own that were never synced. Ask before setting them aside for the family's. */
  confirmReplace(theirs: State): Promise<boolean>;
  fetch: typeof fetch;
}

export type SyncResult =
  | { ok: true; version: number; pulled: boolean; pushed: boolean }
  | { ok: false; why: 'signed-out' | 'offline' | 'declined' | 'no-book' | 'busy' | 'error'; message: string };

const failed = (why: Exclude<SyncResult, { ok: true }>['why'], message: string): SyncResult => ({ ok: false, why, message });

/**
 * One sync: fetch the family's newest version if it changed, combine, apply, and send back
 * anything new from this device. Safe to call again at any point, and to stop at any point: the
 * device's records are changed before its "last synced" note is, so a sync cut short is simply
 * done again, and never mistakes a record it has not finished receiving for one deleted here.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  let pulled = false;
  // A write refused because someone else wrote first is tried again from the top, a few times.
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = deps.session();
    if (!token) return failed('signed-out', 'not signed in');
    const auth = { Authorization: `Bearer ${token}` };
    const meta = deps.meta();

    let res: Response;
    try {
      res = await deps.fetch(`${deps.server}/family${meta ? `/after/${meta.version}` : ''}`, { headers: auth, cache: 'no-store' });
    } catch (_) {
      return failed('offline', 'the server could not be reached');
    }
    if (res.status === 401) return failed('signed-out', 'the session is no longer accepted');
    if (res.status !== 200 && res.status !== 404) return failed('error', `the server answered ${res.status}`);

    // From here to the next request nothing waits, so the records cannot change under our feet.
    let version: number;
    let toSend: State | null = null;
    if (res.status === 404) {
      // The family has no book yet. A device with records starts it; an empty one has nothing to give.
      await res.text();
      const mine = deps.local();
      if (!mine.funds.length) return failed('no-book', 'the family has no book yet');
      version = 0;
      toSend = tidy(mine);
    } else {
      const got = (await res.json()) as { version: number; unchanged?: boolean; book?: unknown };
      version = got.version;
      if (got.unchanged && meta) {
        // Nothing new from the family. Anything changed here since the last sync goes up.
        const mine = tidy(deps.local());
        if (!sameHashes(hashesOfTidy(mine), meta.hashes)) toSend = mine;
      } else {
        const theirs = L.normalizeState(got.book).state;
        const mine = deps.local();
        if (!meta && mine.funds.length && !sameHashes(hashesOf(mine), hashesOf(theirs))) {
          // Records that were never part of the family's book. They are not mixed in: the same
          // people entered twice under different ids would be doubled. Ask, then set them aside.
          if (!(await deps.confirmReplace(theirs))) return failed('declined', 'kept the records already on this device');
          deps.apply(theirs, true);
          deps.setMeta({ version, hashes: hashesOf(theirs) });
          return { ok: true, version, pulled: true, pushed: false };
        }
        const combined = merge(mine, theirs, meta ? meta.hashes : {});
        if (combined.changedHere) {
          deps.apply(combined.state, false);
          pulled = true;
        }
        // Only now, with the records in place, is this version noted as the one last combined with.
        deps.setMeta({ version, hashes: hashesOf(theirs) });
        if (combined.changedThere) toSend = combined.state;
      }
    }
    if (!toSend) return { ok: true, version, pulled, pushed: false };

    let put: Response;
    try {
      put = await deps.fetch(`${deps.server}/family/after/${version}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: L.backupJSON(toSend), cache: 'no-store' });
    } catch (_) {
      return failed('offline', 'the server could not be reached');
    }
    if (put.status === 201) {
      const { version: written } = (await put.json()) as { version: number };
      // What was sent is now what the family has. Changes made here while it was on its way are
      // not in `toSend`, so they still differ from this note and go up next time.
      deps.setMeta({ version: written, hashes: hashesOfTidy(toSend) });
      return { ok: true, version: written, pulled, pushed: true };
    }
    await put.text();
    if (put.status === 401) return failed('signed-out', 'the session is no longer accepted');
    if (put.status !== 409) return failed('error', `the server answered ${put.status}`);
    // 409: another device wrote first. Go round again: fetch theirs, combine, send.
  }
  return failed('busy', 'other devices kept writing first; it will try again');
}
