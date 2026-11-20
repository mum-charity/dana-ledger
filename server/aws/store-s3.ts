/*
 * Keeps backups as objects in an S3 bucket, laid out like the files on the Pi:
 *   devices/<device>/<time>-<hash>.json   every version
 *   devices/<device>/latest.json          the newest one again
 *   books/<id>.json                       a shared book, for new phones to load
 *   family/<8-digit number>.json          each version of the family's shared book
 *
 * `s3` is an S3 client and `cmd` its command classes, passed in so the tests can use a stand-in.
 * The function's role may read, write and list, but not delete. The bucket keeps earlier copies
 * of anything overwritten, so publishing a shared book again does not lose the one before.
 */
import type { Store } from '../backup-core.ts';

/** The few parts of the AWS SDK's S3 client this file uses. */
export interface S3Like {
  send(command: unknown): Promise<any>;
}
export interface S3Commands {
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  PutObjectCommand: new (input: { Bucket: string; Key: string; Body: string; ContentType: string; IfNoneMatch?: string }) => unknown;
  ListObjectsV2Command: new (input: { Bucket: string; Prefix: string; ContinuationToken?: string; StartAfter?: string }) => unknown;
}

interface DeviceState {
  latestSize: number;
  lastBackup: string | null;
  versions: number;
}
interface Scan {
  devices: Map<string, DeviceState>;
  used: number;
}

const PREFIX = 'devices/';
const errorName = (e: unknown): string | undefined => (e as { name?: string } | null)?.name;

export function createS3Store({ s3, cmd, bucket }: { s3: S3Like; cmd: S3Commands; bucket: string }): Store {
  const key = (device: string, name: string) => `${PREFIX}${device}/${name}`;
  const bookKey = (id: string) => `books/${id}.json`;
  const familyKey = (n: number) => `family/${String(n).padStart(8, '0')}.json`;
  // The newest family version this copy of the function has seen. Others may have written since,
  // so it is only where the next look starts from, never the answer by itself.
  let familySeen = 0;

  async function getText(Key: string): Promise<string | null> {
    try {
      const res = await s3.send(new cmd.GetObjectCommand({ Bucket: bucket, Key }));
      return await res.Body.transformToString('utf-8');
    } catch (e) {
      if (errorName(e) === 'NoSuchKey') return null;
      throw e;
    }
  }
  const putText = (Key: string, text: string, extra: { IfNoneMatch?: string } = {}) =>
    s3.send(new cmd.PutObjectCommand({ Bucket: bucket, Key, Body: text, ContentType: 'application/json; charset=utf-8', ...extra }));

  /** Walk the phones' backups once: bytes used, and for each phone its newest backup and version count. */
  async function scan(): Promise<Scan> {
    const devices = new Map<string, DeviceState>();
    let used = 0;
    let token: string | undefined;
    do {
      const page = await s3.send(new cmd.ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
      for (const o of page.Contents || []) {
        const m = /^devices\/([^/]+)\/([^/]+\.json)$/.exec(o.Key);
        if (!m) continue;
        used += o.Size;
        let d = devices.get(m[1]);
        if (!d) devices.set(m[1], (d = { latestSize: 0, lastBackup: null, versions: 0 }));
        if (m[2] === 'latest.json') {
          d.latestSize = o.Size;
          d.lastBackup = new Date(o.LastModified).toISOString();
        } else d.versions++;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { devices, used };
  }

  // Scanned once each time Lambda starts a fresh copy of the function, then kept up to date by
  // save(). Two copies running at once each keep their own count, so the quota can be passed by
  // a little; it is a ceiling on cost, not an exact limit.
  let cache: Promise<Scan> | null = null;
  const state = (): Promise<Scan> => (cache || (cache = scan().catch((e) => { cache = null; throw e; })));

  return {
    getLatest: (device) => getText(key(device, 'latest.json')),
    async latestSize(device) {
      const d = (await state()).devices.get(device);
      return d ? d.latestSize : 0;
    },
    async usedBytes() {
      return (await state()).used;
    },
    async save(device, name, text) {
      const st = await state();
      const size = Buffer.byteLength(text);
      let d = st.devices.get(device);
      if (!d) st.devices.set(device, (d = { latestSize: 0, lastBackup: null, versions: 0 }));
      try {
        // A version is written once and never replaced. Its name carries the time and a
        // fingerprint of the records, so a second write of the same name is the same backup.
        await putText(key(device, name), text, { IfNoneMatch: '*' });
        d.versions++;
        st.used += size;
      } catch (e) {
        if (errorName(e) !== 'PreconditionFailed') throw e;
      }
      await putText(key(device, 'latest.json'), text);
      st.used += size - d.latestSize;
      d.latestSize = size;
      d.lastBackup = new Date().toISOString();
    },
    getBook: (id) => getText(bookKey(id)),
    async saveBook(id, text) {
      await putText(bookKey(id), text);
    },
    async familyHead() {
      // Names sort by number, so listing after the newest one seen returns only newer versions.
      // Where to start is fixed before the first page: it must not move while the pages are read.
      const startAfter = familySeen ? { StartAfter: familyKey(familySeen) } : {};
      let token: string | undefined;
      do {
        const page = await s3.send(new cmd.ListObjectsV2Command({ Bucket: bucket, Prefix: 'family/', ContinuationToken: token, ...startAfter }));
        for (const o of page.Contents || []) {
          const m = /^family\/(\d{8})\.json$/.exec(o.Key);
          if (m) familySeen = Math.max(familySeen, Number(m[1]));
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return familySeen;
    },
    getFamily: (n) => getText(familyKey(n)),
    async putFamily(n, text) {
      try {
        await putText(familyKey(n), text, { IfNoneMatch: '*' }); // S3 refuses if this version already exists
        return true;
      } catch (e) {
        if (errorName(e) === 'PreconditionFailed') return false;
        throw e;
      }
    },
    /** Always a fresh look at the bucket, since this is what the family reads to check on backups. */
    async list() {
      const fresh = await scan();
      cache = Promise.resolve(fresh);
      const out = [];
      for (const [device, d] of fresh.devices) if (d.lastBackup) out.push({ device, lastBackup: d.lastBackup, versions: d.versions });
      return out;
    },
  };
}
