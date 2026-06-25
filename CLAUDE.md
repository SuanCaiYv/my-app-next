# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal knowledge base / CMS web app ("Hello.me") with LLM integration. Rust backend (Axum) serving a React SPA (Vite + TypeScript). UI is in Chinese.

## Commands

```bash
# Backend
cargo build          # Build Rust backend
cargo run            # Run server on http://127.0.0.1:3003

# Frontend (run from ui/ directory)
cd ui
npm install          # Install dependencies (first time)
npm run dev          # Vite dev server with HMR
npm run build        # Type-check + production build → ui/dist/
npm run preview      # Preview production build locally
```

The backend serves the built frontend from `ui/dist/`. For development, run both `cargo run` and `npm run dev` (Vite proxies API requests to the backend).

Environment variable `PERSONAL_SITE_PASSWORD` sets the owner login password (defaults to `123456`).

No tests exist in this project.

## Architecture

**Backend** (`src/main.rs` + `src/lib.rs`): Axum web server. `lib.rs` contains routing, handlers, data access, EXIF parsing, error types. `main.rs` is the entry point. Serves the React frontend from `ui/dist/` with SPA catch-all fallback.

**Shared state**: `AppState` wrapped in `Arc<Mutex<...>>` holding db path, uploads dir, password, in-memory session set, and a `reqwest::Client` for LLM API calls.

**Database**: SQLite via `rusqlite` (bundled). Three tables — `posts`, `photos`, `analyses`. Schema created on startup if not exists.

**Auth**: Password-based. Login returns a UUID token stored in-memory (no expiration, no persistence across restarts). Bearer token checked via `Authorization` header. Owner vs guest role only.

**LLM integration**: `/api/analyze` and `/api/chat` proxy to any OpenAI-compatible API. Client supplies `api_key`, `base_url`, `model`. Photos sent as base64 image_url blocks for vision models.

**Frontend** (`ui/`): Vite + React 19 + TypeScript SPA. Key structure:
- `src/App.tsx` — root shell with tab-based navigation (state-driven, no React Router)
- `src/api.ts` — fetch-based API client with Bearer token auth and SSE streaming
- `src/context/AuthContext.tsx` — auth state (guest/owner role, token from localStorage)
- `src/pages/` — Posts, Photos, Map (Leaflet), Chat, Analyze
- `src/components/` — LoginDialog, Select (portal-based dropdown)
- `src/hooks/` — useToast (Popover API), useConfirm
- `src/styles/` — modular CSS (base, layout, effects, responsive, per-page)
- Build output: `ui/dist/` (hashed assets). Backend serves this directory.

Owner features (Chat, Analyze tabs) hidden by default. Clicking the brand logo 7 times triggers login. Auth token stored in localStorage, provided via React Context.

## Key Dependencies

**Backend (Rust):**
- `axum 0.8` (multipart) — web framework
- `rusqlite 0.32` (bundled) — SQLite
- `reqwest 0.12` (json, rustls-tls) — HTTP client for LLM APIs
- `kamadak-exif 0.6` — GPS extraction from photo EXIF
- `chrono`, `uuid`, `serde`, `serde_json`, `anyhow`, `tower-http`, `base64`

**Frontend (ui/):**
- `react` + `react-dom` 19 — UI framework
- `leaflet` + `react-leaflet` — map rendering
- `vite` 5 — build tool
- `typescript` 6 — type checking
