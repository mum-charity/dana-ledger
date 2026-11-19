// 善款簿 is exported as plain static files (out/), so it runs from Cloudflare's static hosting
// and keeps working offline. There is no server code: backups go to the family's own server.
const pkg = require('./package.json');

/** @type {import('next').NextConfig} */
module.exports = {
  output: 'export',
  // Set BASE_PATH=/dana-ledger when building for an address like https://<owner>.github.io/dana-ledger/.
  basePath: process.env.BASE_PATH || '',
  reactStrictMode: true,
  devIndicators: false,
  agentRules: false, // don't write an AGENTS.md into the repo when `next dev` starts
  // The version shown in 设置 and used by the service worker comes from package.json.
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
};
