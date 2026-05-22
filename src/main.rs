use std::{net::SocketAddr, path::PathBuf};

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    personal_studio::init_tracing();

    let addr: SocketAddr = "0.0.0.0:3003".parse()?;
    personal_studio::run_server(PathBuf::from("data"), PathBuf::from("ui/dist"), addr).await
}
