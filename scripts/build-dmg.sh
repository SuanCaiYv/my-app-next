#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building Hello.me macOS DMG..."
cd src-tauri
cargo tauri build --bundles dmg

echo ""
echo "==> Done. DMG location:"
ls -1 target/release/bundle/dmg/*.dmg
