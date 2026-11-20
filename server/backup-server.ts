#!/usr/bin/env node
/*
 * 善款簿 backup server for a computer of your own: keeps a copy of the records off the phone,
 * as files on this computer's disk. It runs on the home Raspberry Pi behind a Cloudflare Tunnel.
 * No packages. What it accepts and refuses is in backup-core.ts.
 *
 * It is written in TypeScript. Node 24 runs this file as it is; for an older Node (18+), run
 * `npm run build:server` and start server/dist/server/backup-server.js instead.
 *
 * Settings come from the environment (see server/dana-backup.env.example):
 *   BACKUP_TOKEN     required, 32+ characters: the key for reading backups ("Authorization: Bearer <key>")
 *   BACKUP_DIR       where backups are kept (default: ./data)
 *   ALLOWED_ORIGINS  comma-separated sites the app runs on (default: https://mum.franklee.asia)
 *   PORT, HOST       default 8787 on 127.0.0.1, so only the tunnel on the same Pi can reach it
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackupService, httpError } from './backup-core.ts';
import { createDiskStore } from './store-disk.ts';

const HOUR = 60 * 60 * 1000;

export interface BackupServerOptions {
  token: string | undefined;
  dir: string;
  origins?: string[];
  maxBytes?: number;
  quotaBytes?: number;
  /** From one internet address. */
  uploadsPerHour?: number;
  now?: () => number;
}

/** Read the request body, refusing anything over maxBytes. */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > maxBytes) return reject(httpError(413, 'backup too large'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= maxBytes) chunks.push(c);
    });
    req.on('end', () => (size > maxBytes ? reject(httpError(413, 'backup too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

export function createBackupServer({ token, dir, origins, maxBytes, quotaBytes, uploadsPerHour = 120, now = Date.now }: BackupServerOptions): http.Server {
  // Uploads per internet address in the current hour. cloudflared passes the phone's address in
  // CF-Connecting-IP; only cloudflared can reach this server, so the header can be trusted.
  const uploadCounts = new Map<string | undefined, { start: number; count: number }>();
  function allowUpload(ip: string | undefined): boolean {
    const t = now();
    if (uploadCounts.size > 10000) for (const [k, v] of uploadCounts) if (t - v.start >= HOUR) uploadCounts.delete(k);
    let c = uploadCounts.get(ip);
    if (!c || t - c.start >= HOUR) uploadCounts.set(ip, (c = { start: t, count: 0 }));
    return ++c.count <= uploadsPerHour;
  }

  const service = createBackupService({ token, store: createDiskStore(dir), origins, maxBytes, quotaBytes, allowUpload, now });

  return http.createServer(async (req, res) => {
    const forwarded = req.headers['cf-connecting-ip'];
    const out = await service.handle({
      method: req.method,
      url: req.url,
      headers: req.headers,
      ip: (Array.isArray(forwarded) ? forwarded[0] : forwarded) || req.socket.remoteAddress,
      readBody: (max) => readBody(req, max),
    });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
}

const thisFile = fileURLToPath(import.meta.url);
const startedDirectly = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(thisFile);
if (startedDirectly) {
  const env = process.env;
  const server = createBackupServer({
    token: env.BACKUP_TOKEN,
    dir: path.resolve(env.BACKUP_DIR || path.join(path.dirname(thisFile), '..', 'data')),
    origins: (env.ALLOWED_ORIGINS || 'https://mum.franklee.asia').split(',').map((s) => s.trim()).filter(Boolean),
  });
  const port = Number(env.PORT) || 8787;
  const host = env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`善款簿 backup server on http://${host}:${port}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
