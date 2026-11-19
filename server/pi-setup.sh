#!/usr/bin/env bash
# Set up the 善款簿 backup server on the Raspberry Pi, and connect it to the internet at
# https://mum-backup.franklee.asia through a Cloudflare Tunnel (no router ports opened).
#
#   sudo bash server/pi-setup.sh        # from a copy of this repo on the Pi
#
# Safe to run again: it keeps the existing key, backups and tunnel, and only updates the code,
# the service and the tunnel settings. The first run asks, once, to approve Cloudflare in a browser.
set -euo pipefail

PUBLIC_HOST="${PUBLIC_HOST:-mum-backup.franklee.asia}"
TUNNEL_NAME="${TUNNEL_NAME:-mum-backup}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/opt/charity-ledger
ENV_FILE=/etc/dana-backup.env
CF_DIR=/etc/cloudflared
# The Cloudflare login certificate. It can manage tunnels for the whole zone, so only root can read it.
export TUNNEL_ORIGIN_CERT=/root/.cloudflared/cert.pem

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nStopped: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo bash $0"
[ -f "$SRC/model.js" ] && [ -f "$SRC/server/backup-server.js" ] || die "model.js and server/ aren't in $SRC; run it from a copy of the repo"

# ------------------------------------------------------------------ 1. Node
say "1/5 Node.js"
if ! command -v node >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q nodejs
fi
[ "$(command -v node)" = /usr/bin/node ] || die "node is at $(command -v node), but the service runs /usr/bin/node"
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || die "Node 18 or newer is needed, found $(node --version)"
echo "Node $(node --version)"

# ------------------------------------------------------------------ 2. Code and key
say "2/5 Backup server files and key"
install -d -m 755 "$APP" "$APP/server"
install -m 644 "$SRC/model.js" "$APP/model.js"
install -m 644 "$SRC/server/backup-server.js" "$APP/server/backup-server.js"
if grep -Eq '^BACKUP_TOKEN=.{32,}$' "$ENV_FILE" 2>/dev/null; then
  echo "Keeping the existing key for reading backups in $ENV_FILE."
else
  key="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  # Written with shell builtins only, so the key never appears on a command line (visible in ps).
  (
    umask 077
    { printf 'BACKUP_TOKEN=%s\n' "$key"; grep -v '^BACKUP_TOKEN=' "$SRC/server/dana-backup.env.example"; } > "$ENV_FILE.new"
  )
  unset key
  chown root:root "$ENV_FILE.new"
  mv "$ENV_FILE.new" "$ENV_FILE"
  echo "Made a new key in $ENV_FILE"
fi

# ------------------------------------------------------------------ 3. Service
say "3/5 Backup service"
install -m 644 "$SRC/server/dana-backup.service" /etc/systemd/system/dana-backup.service
systemctl daemon-reload
systemctl enable --quiet dana-backup
systemctl restart dana-backup
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8787/health 2>/dev/null && break; sleep 0.5; done
if ! curl -fsS -o /dev/null http://127.0.0.1:8787/health; then
  journalctl -u dana-backup -n 20 --no-pager
  die "the backup service didn't start (log above)"
fi
echo "Running, and answering on 127.0.0.1:8787 (only this Pi can reach it there)."

# ------------------------------------------------------------------ 4. cloudflared
say "4/5 cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  install -d -m 755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q
  apt-get install -y -q cloudflared
fi
cloudflared --version

# ------------------------------------------------------------------ 5. Tunnel
say "5/5 Cloudflare Tunnel for https://$PUBLIC_HOST"
if [ ! -f "$TUNNEL_ORIGIN_CERT" ]; then
  echo "A Cloudflare link appears below. Open it on any computer, choose franklee.asia, and click Authorize."
  HOME=/root cloudflared tunnel login
fi
[ -f "$TUNNEL_ORIGIN_CERT" ] || die "the Cloudflare login didn't finish; run the script again"

# 'tunnel list' already leaves out deleted tunnels. (Its deleted_at is never empty: a live tunnel
# shows the zero time "0001-01-01T00:00:00Z", so it can't be used to filter.)
tunnel_id() {
  cloudflared tunnel list --output json |
    NAME="$TUNNEL_NAME" node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const t=(JSON.parse(s||"[]")||[]).find((x)=>x.name===process.env.NAME);if(t)process.stdout.write(t.id)})'
}
TUNNEL_ID="$(tunnel_id)" || die "couldn't list the Cloudflare tunnels (see the message above)"
if [ -z "$TUNNEL_ID" ]; then
  HOME=/root cloudflared tunnel create "$TUNNEL_NAME" >/dev/null
  TUNNEL_ID="$(tunnel_id)" || die "couldn't list the Cloudflare tunnels (see the message above)"
fi
[ -n "$TUNNEL_ID" ] || die "couldn't create or find the tunnel $TUNNEL_NAME"
echo "Tunnel $TUNNEL_NAME: $TUNNEL_ID"

install -d -m 755 "$CF_DIR"
CRED="$CF_DIR/$TUNNEL_ID.json"
if [ ! -f "$CRED" ]; then
  if [ -f "/root/.cloudflared/$TUNNEL_ID.json" ]; then
    install -m 600 "/root/.cloudflared/$TUNNEL_ID.json" "$CRED"
  else
    cloudflared tunnel token --cred-file "$CRED" "$TUNNEL_ID"
  fi
fi
chmod 600 "$CRED"

cat > "$CF_DIR/config.yml" <<EOF
# Written by server/pi-setup.sh. Sends $PUBLIC_HOST to the backup server; nothing else is served.
tunnel: $TUNNEL_ID
credentials-file: $CRED
ingress:
  - hostname: $PUBLIC_HOST
    service: http://127.0.0.1:8787
  - service: http_status:404
EOF
cloudflared tunnel --config "$CF_DIR/config.yml" ingress validate
cloudflared tunnel route dns --overwrite-dns "$TUNNEL_ID" "$PUBLIC_HOST"

if [ ! -f /etc/systemd/system/cloudflared.service ]; then
  cloudflared --config "$CF_DIR/config.yml" service install
fi
systemctl daemon-reload
systemctl enable --quiet cloudflared
systemctl restart cloudflared

echo "Waiting for https://$PUBLIC_HOST/health ..."
for _ in $(seq 1 60); do curl -fsS -o /dev/null --max-time 5 "https://$PUBLIC_HOST/health" 2>/dev/null && break; sleep 2; done
if curl -fsS -o /dev/null --max-time 5 "https://$PUBLIC_HOST/health"; then
  say "Done. https://$PUBLIC_HOST is up."
else
  echo "The tunnel is set up, but https://$PUBLIC_HOST doesn't answer yet. New DNS names can take a few minutes."
  echo "Check later with: curl https://$PUBLIC_HOST/health    Logs: journalctl -u cloudflared -n 30"
fi
cat <<EOF

Phones need nothing: 善款簿 backs up here by itself whenever it has signal.
The key for reading backups back (to restore a phone) is in $ENV_FILE. Keep it private.
Each backup shows up in: journalctl -u dana-backup
EOF
