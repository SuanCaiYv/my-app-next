use std::{net::SocketAddr, path::PathBuf, thread, time::Duration};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const APP_URL: &str = "http://127.0.0.1:34867";

fn static_dir(_app: &tauri::App) -> anyhow::Result<PathBuf> {
    #[cfg(debug_assertions)]
    {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/dist"))
    }

    #[cfg(not(debug_assertions))]
    {
        let resource_dir = _app.path().resource_dir()?;
        let candidates = [resource_dir.join("ui/dist"), resource_dir.join("_up_/ui/dist")];
        Ok(candidates
            .into_iter()
            .find(|path| path.exists())
            .unwrap_or_else(|| resource_dir.join("ui/dist")))
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let log_path = personal_studio::init_tracing_with_file(app_data_dir.join("logs"))?;
            tracing::info!("Rust backend log file: {}", log_path.display());

            let data_dir = app_data_dir.join("data");
            let static_dir = static_dir(app)?;
            let addr: SocketAddr = "127.0.0.1:34867".parse()?;

            thread::spawn(move || {
                let runtime = tokio::runtime::Runtime::new().expect("create tokio runtime");
                if let Err(error) = runtime.block_on(personal_studio::run_server(data_dir, static_dir, addr)) {
                    tracing::error!("failed to run local server: {error:?}");
                }
            });

            thread::sleep(Duration::from_millis(300));

            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(APP_URL.parse().expect("valid app url")),
            )
            .title("")
            .inner_size(1180.0, 780.0)
            .min_inner_size(900.0, 620.0)
            .devtools(true);

            #[cfg(target_os = "macos")]
            {
                builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
                builder = builder.traffic_light_position(tauri::LogicalPosition::new(18.0, 18.0));
                builder = builder.hidden_title(true);
            }

            builder.build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Hello.me");
}
