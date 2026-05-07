use std::{net::SocketAddr, path::PathBuf};

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    personal_studio::init_tracing();

    let addr: SocketAddr = "127.0.0.1:3000".parse()?;
    personal_studio::run_server(PathBuf::from("data"), PathBuf::from("static"), addr).await
}
