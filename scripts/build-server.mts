/*
 * Builds the backup server and the data rules into plain JavaScript in server/dist/, laid out as it is uploaded:
 *
 *   server/dist/lib/model.js              the data rules, with the types removed
 *   server/dist/lib/package.json          says model.js is an ES module, wherever the folder ends up
 *   server/dist/server/package.json       says the server's files are ES modules
 *   server/dist/server/*.js, aws/*.js     the server, with the types removed
 *
 * server/aws/deploy.sh zips this folder for AWS Lambda, and server/pi-setup.sh installs from it.
 * Run with: npm run build:server
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'server', 'dist');

fs.rmSync(dist, { recursive: true, force: true });
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'server', 'tsconfig.build.json')], { stdio: 'inherit' });

fs.copyFileSync(path.join(root, 'lib', 'package.json'), path.join(dist, 'lib', 'package.json'));
fs.copyFileSync(path.join(root, 'server', 'package.json'), path.join(dist, 'server', 'package.json'));

// Load what was built the way Lambda and the Pi will, and ask it one question, so a build that
// cannot start is caught here and not after it is uploaded.
const built = (file: string) => import(pathToFileURL(path.join(dist, 'server', file)).href);
const { createBackupService } = await built('backup-core.js');
const { handler, createHandler } = await built('aws/lambda.js');
await built('backup-server.js');
const none = async () => null;
const service = createBackupService({ token: 'x'.repeat(32), store: { getLatest: none, getBook: none }, log: { log() {}, error() {} } });
const answer = await createHandler(service)({ rawPath: '/health', requestContext: { http: { method: 'GET' } } });
if (typeof handler !== 'function' || answer.statusCode !== 200 || answer.body !== '{"ok":true}') {
  console.error('The built server did not answer /health:', answer);
  process.exit(1);
}
console.log(`Built the backup server into ${path.relative(root, dist)}`);
