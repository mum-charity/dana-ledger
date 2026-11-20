#!/usr/bin/env bash
# Builds the web app, serves it from this Mac at http://localhost:41871, and runs the iPhone app's
# UI tests in the simulator: first with the server up, then with it stopped (offline).
# At localhost the web app never sends records to the family's backup server.
#
#   bash ios/test.sh                          # uses the "iPhone 17" simulator
#   IOS_SIMULATOR="iPhone 17 Pro" bash ios/test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE="${IOS_SIMULATOR:-iPhone 17}"
DESTINATION="platform=iOS Simulator,name=$DEVICE"
PROJECT=ios/DanaLedger.xcodeproj
DERIVED=ios/build
RESULTS=ios/build/results
rm -rf "$RESULTS"
mkdir -p "$RESULTS"

# An unusual port: editors and other tools often sit on 8080 or 3000. The UI tests use the same one.
PORT=41871
if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use; stop whatever is on it and try again." >&2
  exit 1
fi

npm run build

python3 -m http.server $PORT --bind 127.0.0.1 --directory out >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.1; done
curl -sf --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null || { echo "The web app is not being served on port $PORT." >&2; exit 1; }

xcodebuild -project "$PROJECT" -scheme DanaLedger -destination "$DESTINATION" -derivedDataPath "$DERIVED" \
  -resultBundlePath "$RESULTS/online.xcresult" -only-testing:DanaLedgerUITests/OnlineTests test

kill $SERVER
wait $SERVER 2>/dev/null || true

xcodebuild -project "$PROJECT" -scheme DanaLedger -destination "$DESTINATION" -derivedDataPath "$DERIVED" \
  -resultBundlePath "$RESULTS/offline.xcresult" -only-testing:DanaLedgerUITests/OfflineTests test-without-building

echo "UI tests passed. Screenshots are in $RESULTS/*.xcresult (open them in Xcode)."
