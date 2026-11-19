/*
 * Keeps backups as objects in an S3 bucket, laid out like the files on the Pi:
 *   devices/<device>/<time>-<hash>.json   every version
 *   devices/<device>/latest.json          the newest one again
 *
 * `s3` is an S3 client and `cmd` its command classes, passed in so the tests can use a stand-in.
 * The function's role may read, write and list, but not delete.
 */
'use strict';

const PREFIX = 'devices/';

function createS3Store({ s3, cmd, bucket }) {
  const key = (device, name) => `${PREFIX}${device}/${name}`;

  /** Walk the whole bucket once: bytes used, and for each phone its newest backup and version count. */
  async function scan() {
    const devices = new Map(); // device -> { latestSize, lastBackup, versions }
    let used = 0;
    let token;
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
  let cache = null;
  const state = () => (cache || (cache = scan().catch((e) => { cache = null; throw e; })));

  return {
    async getLatest(device) {
      try {
        const res = await s3.send(new cmd.GetObjectCommand({ Bucket: bucket, Key: key(device, 'latest.json') }));
        return await res.Body.transformToString('utf-8');
      } catch (e) {
        if (e.name === 'NoSuchKey') return null;
        throw e;
      }
    },
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
      const put = (k, extra = {}) => s3.send(new cmd.PutObjectCommand({ Bucket: bucket, Key: k, Body: text, ContentType: 'application/json; charset=utf-8', ...extra }));
      let d = st.devices.get(device);
      if (!d) st.devices.set(device, (d = { latestSize: 0, lastBackup: null, versions: 0 }));
      try {
        // A version is written once and never replaced. Its name carries the time and a
        // fingerprint of the records, so a second write of the same name is the same backup.
        await put(key(device, name), { IfNoneMatch: '*' });
        d.versions++;
        st.used += size;
      } catch (e) {
        if (e.name !== 'PreconditionFailed') throw e;
      }
      await put(key(device, 'latest.json'));
      st.used += size - d.latestSize;
      d.latestSize = size;
      d.lastBackup = new Date().toISOString();
    },
    /** Always a fresh look at the bucket, since this is what the family reads to check on backups. */
    async list() {
      cache = Promise.resolve(await scan());
      return [...(await cache).devices].filter(([, d]) => d.lastBackup).map(([device, d]) => ({ device, lastBackup: d.lastBackup, versions: d.versions }));
    },
  };
}

module.exports = { createS3Store };
