#!/bin/bash
set -e

echo "==> Building frontend..."
cd ui
npm install --prefer-offline 2>/dev/null || true
npm run build
cd ..

echo "==> Building Tauri app (DMG)..."
cd src-tauri
cargo tauri build
cd ..

echo ""
echo "==> Done! DMG output:"
ls -lh src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || echo "No DMG found in src-tauri/target/release/bundle/dmg/"
