#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{net::SocketAddr, path::PathBuf};

use anyhow::{Context, Result};

fn resolve_static_dir() -> Result<PathBuf> {
    let exe_path = std::env::current_exe()?;
    let mut base = exe_path.parent().context("executable has no parent directory")?;

    let candidates: Vec<PathBuf> = std::iter::from_fn(|| {
        let candidate = base.join("ui/dist");
        if let Some(parent) = base.parent() {
            base = parent;
            Some(candidate)
        } else {
            None
        }
    })
    .chain(std::iter::once(std::env::current_dir()?.join("ui/dist")))
    .collect();

    for candidate in candidates {
        if candidate.join("index.html").is_file() {
            return Ok(candidate);
        }
    }

    Err(anyhow::anyhow!(
        "could not find ui/dist/index.html relative to executable or cwd"
    ))
}

fn resolve_data_dir() -> Result<PathBuf> {
    let exe_path = std::env::current_exe()?;
    let mut base = exe_path.parent().context("executable has no parent directory")?;

    let candidates: Vec<PathBuf> = std::iter::from_fn(|| {
        let candidate = base.join("data");
        if let Some(parent) = base.parent() {
            base = parent;
            Some(candidate)
        } else {
            None
        }
    })
    .chain(std::iter::once(std::env::current_dir()?.join("data")))
    .collect();

    for candidate in candidates {
        let db = candidate.join("site.sqlite3");
        if db.is_file() {
            let meta = std::fs::metadata(&db)?;
            if meta.len() > 0 {
                return Ok(candidate);
            }
        }
    }

    Err(anyhow::anyhow!(
        "could not find data directory with site.sqlite3 relative to executable or cwd"
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    personal_studio::init_tracing();

    let addr: SocketAddr = "0.0.0.0:3003".parse()?;
    let data_dir = resolve_data_dir()?;
    let static_dir = resolve_static_dir()?;
    personal_studio::run_server(data_dir, static_dir, addr).await
}
