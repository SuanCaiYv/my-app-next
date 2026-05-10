# Tauri Packaging

This project already embeds the Rust/Axum server inside a Tauri desktop shell.

## Prerequisites

Install the Tauri CLI once:

```bash
cargo install tauri-cli --version "^2"
```

## macOS DMG (local)

Run the helper script:

```bash
./scripts/build-dmg.sh
```

Or manually:

```bash
cd src-tauri
cargo tauri build --bundles dmg
```

The installer is written to:

```text
src-tauri/target/release/bundle/dmg/
```

## Windows EXE (local)

Tauri does not reliably cross-compile Windows installers from macOS.
Build the NSIS `.exe` on a Windows machine or use GitHub Actions (see below).

## GitHub Actions

Push to `main` or trigger manually via **Actions > Build > Run workflow**.

Two jobs run in parallel:

- `build-macos` on `macos-latest` → uploads `.dmg`
- `build-windows` on `windows-latest` → uploads `.exe`

Download artifacts from the workflow run page.
