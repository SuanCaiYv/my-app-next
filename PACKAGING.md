# Tauri Packaging

This project already embeds the Rust/Axum server inside a Tauri desktop shell.

## Prerequisites

Install the Tauri CLI once:

```bash
cargo install tauri-cli --version "^2"
```

## macOS DMG

Run on macOS:

```bash
cd src-tauri
cargo tauri build --bundles dmg
```

The installer is written to:

```text
src-tauri/target/release/bundle/dmg/
```

## Windows EXE

Run on Windows:

```powershell
cd src-tauri
cargo tauri build --bundles nsis
```

The installer `.exe` is written to:

```text
src-tauri\target\release\bundle\nsis\
```

Tauri does not reliably cross-compile Windows installers from macOS. Build the
NSIS `.exe` on a Windows machine or in Windows CI.
