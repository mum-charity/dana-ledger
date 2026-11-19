/*
 * Keeps backups as files on this computer's disk (the Raspberry Pi):
 *   <dir>/devices/<device>/<time>-<hash>.json   every version
 *   <dir>/devices/<device>/latest.json          the newest one again
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** Write a file so a crash or power cut leaves either the old file or the whole new one. */
async function writeFileDurably(file, text) {
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

function createDiskStore(dir) {
  const devicesDir = path.join(dir, 'devices');
  fs.mkdirSync(devicesDir, { recursive: true });
  const latestFile = (device) => path.join(devicesDir, device, 'latest.json');

  // Bytes already stored, so the quota holds across restarts.
  let used = 0;
  for (const d of fs.readdirSync(devicesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(devicesDir, d.name))) used += fs.statSync(path.join(devicesDir, d.name, f)).size;
  }

  const latestSize = (device) => fs.promises.stat(latestFile(device)).then((s) => s.size, () => 0);

  return {
    async getLatest(device) {
      try {
        return await fs.promises.readFile(latestFile(device), 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
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
    async list() {
      const out = [];
      for (const device of await fs.promises.readdir(devicesDir)) {
        let stat;
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

module.exports = { createDiskStore };
