/*
 * Keeps backups as files on this computer's disk (the Raspberry Pi):
 *   <dir>/devices/<device>/<time>-<hash>.json   every version
 *   <dir>/devices/<device>/latest.json          the newest one again
 *   <dir>/books/<id>.json                       a shared book, for new phones to load
 *   <dir>/family/<8-digit number>.json          each version of the family's shared book
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceEntry, Store } from './backup-core.ts';

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Write a file so a crash or power cut leaves either the old file or the whole new one. */
async function writeFileDurably(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, file);
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

export function createDiskStore(dir: string): Store {
  const devicesDir = path.join(dir, 'devices');
  fs.mkdirSync(devicesDir, { recursive: true });
  const latestFile = (device: string) => path.join(devicesDir, device, 'latest.json');
  const booksDir = path.join(dir, 'books');
  const bookFile = (id: string) => path.join(booksDir, `${id}.json`);
  const familyDir = path.join(dir, 'family');
  const familyFile = (n: number) => path.join(familyDir, `${String(n).padStart(8, '0')}.json`);

  // Bytes already stored, so the quota holds across restarts.
  let used = 0;
  for (const d of fs.readdirSync(devicesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(devicesDir, d.name))) used += fs.statSync(path.join(devicesDir, d.name, f)).size;
  }

  const latestSize = (device: string): Promise<number> => fs.promises.stat(latestFile(device)).then((s) => s.size, () => 0);

  return {
    getLatest: (device) => readOrNull(latestFile(device)),
    latestSize,
    async usedBytes() {
      return used;
    },
    async save(device, name, text) {
      const size = Buffer.byteLength(text);
      const growth = size + size - (await latestSize(device));
      const deviceDir = path.join(devicesDir, device);
      await fs.promises.mkdir(deviceDir, { recursive: true });
      await writeFileDurably(path.join(deviceDir, name), text);
      await writeFileDurably(latestFile(device), text);
      used += growth;
    },
    getBook: (id) => readOrNull(bookFile(id)),
    async saveBook(id, text) {
      await fs.promises.mkdir(booksDir, { recursive: true });
      await writeFileDurably(bookFile(id), text);
    },
    async familyHead() {
      let names: string[];
      try {
        names = await fs.promises.readdir(familyDir);
      } catch (e) {
        if (isMissing(e)) return 0;
        throw e;
      }
      return names.reduce((head, name) => (/^\d{8}\.json$/.test(name) ? Math.max(head, Number(name.slice(0, 8))) : head), 0);
    },
    getFamily: (n) => readOrNull(familyFile(n)),
    async putFamily(n, text) {
      await fs.promises.mkdir(familyDir, { recursive: true });
      let fh: fs.promises.FileHandle;
      try {
        fh = await fs.promises.open(familyFile(n), 'wx'); // fails if this version already exists
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      return true;
    },
    async list() {
      const out: DeviceEntry[] = [];
      for (const device of await fs.promises.readdir(devicesDir)) {
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(latestFile(device));
        } catch (_) {
          continue;
        }
        const versions = (await fs.promises.readdir(path.join(devicesDir, device))).filter((f) => f.endsWith('.json') && f !== 'latest.json').length;
        out.push({ device, lastBackup: stat.mtime.toISOString(), versions });
      }
      return out;
    },
  };
}
