# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

Personal knowledge base / CMS web app ("Hello.me") with LLM integration. Rust backend (Axum) serving a vanilla JS SPA. UI is in Chinese.

## Commands

```bash
cargo build          # Build
cargo run            # Run server on http://127.0.0.1:3000
```

Environment variable `PERSONAL_SITE_PASSWORD` sets the owner login password (defaults to `change-me`).

No tests exist in this project.

## Architecture

**Single-file backend** (`src/main.rs`, ~900 lines): routing, handlers, data access, EXIF parsing, error types all in one file.

**Shared state**: `AppState` wrapped in `Arc<Mutex<...>>` holding db path, uploads dir, password, in-memory session set, and a `reqwest::Client` for LLM API calls.

**Database**: SQLite via `rusqlite` (bundled). Three tables — `posts`, `photos`, `analyses`. Schema created on startup if not exists.

**Auth**: Password-based. Login returns a UUID token stored in-memory (no expiration, no persistence across restarts). Bearer token checked via `Authorization` header. Owner vs guest role only.

**LLM integration**: `/api/analyze` and `/api/chat` proxy to any OpenAI-compatible API. Client supplies `api_key`, `base_url`, `model`. Photos sent as base64 image_url blocks for vision models.

**Frontend** (`static/`): Vanilla JS SPA — `index.html`, `app.js` (~1000 lines), `styles.css` (~1000 lines). No build step, no framework. Five tabs: Posts, Photos, Map (Leaflet), Chat, LLM Analysis. Owner features hidden via CSS class `owner-only`, toggled by clicking the brand logo 7 times.

## Key Dependencies

- `axum 0.8` (multipart) — web framework
- `rusqlite 0.32` (bundled) — SQLite
- `reqwest 0.12` (json, rustls-tls) — HTTP client for LLM APIs
- `kamadak-exif 0.6` — GPS extraction from photo EXIF
- `chrono`, `uuid`, `serde`, `serde_json`, `anyhow`, `tower-http`, `base64`
