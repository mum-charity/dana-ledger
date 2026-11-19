// Runs after `next build`: writes out/sw.js from scripts/sw.template.js.
// The offline file list is every file Next.js exported into out/, so the two never drift apart.
// The cache name carries the version plus a fingerprint of the files, so any change to the app
// gives phones a fresh cache even if the version in package.json was not bumped.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out');
if (!fs.existsSync(path.join(out, 'index.html'))) throw new Error('out/index.html not found. Run `next build` first.');

// Not part of the app she opens: the service worker itself and Next.js's "page not found" files.
const SKIP = /^(sw\.js|404\.html|404\/|_not-found[./]|.*\.DS_Store$)/;

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
  });
}

const files = walk(out).filter((f) => !SKIP.test(f)).sort();
const hash = crypto.createHash('sha256');
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(out, f)));
const version = `${require(path.join(root, 'package.json')).version}-${hash.digest('hex').slice(0, 8)}`;

// The page is cached as './' (see the template for why).
const assets = files.map((f) => (f === 'index.html' ? './' : './' + f.split('/').map(encodeURIComponent).join('/')));
const sw = fs
  .readFileSync(path.join(__dirname, 'sw.template.js'), 'utf8')
  .replace("'__VERSION__'", JSON.stringify(version))
  .replace('__ASSETS__', JSON.stringify(assets, null, 2));
fs.writeFileSync(path.join(out, 'sw.js'), sw);
console.log(`out/sw.js ready: version ${version}, ${assets.length} files cached for offline use`);
