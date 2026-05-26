use std::{
    collections::HashSet,
    error::Error as StdError,
    fs,
    io::Cursor,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use anyhow::{Context, Result};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, State},
    http::{header, HeaderMap, StatusCode},
    response::{sse::Event, IntoResponse, Response, Sse},
    routing::{delete, get, post, put},
    Json, Router,
};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use exif::{In, Reader as ExifReader, Tag, Value as ExifValue};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageEncoder, ImageReader};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tower_http::{
    services::ServeDir,
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use uuid::Uuid;

const MAX_PHOTO_UPLOAD_BYTES: usize = 50 * 1024 * 1024;
const PHOTO_THUMB_MAX_SIZE: u32 = 720;
static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    uploads_dir: PathBuf,
    static_dir: PathBuf,
    owner_password: String,
    sessions: Arc<Mutex<HashSet<String>>>,
    http: Client,
}

#[derive(Debug, Serialize)]
struct PostItem {
    id: i64,
    title: String,
    body: String,
    kind: String,
    status: String,
    category: String,
    tags: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct PhotoItem {
    id: i64,
    title: String,
    description: String,
    category: String,
    tags: String,
    filename: String,
    original_name: String,
    mime: String,
    url: String,
    thumbnail_url: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct AnalysisItem {
    id: i64,
    subject: String,
    prompt: String,
    model: String,
    base_url: String,
    post_ids: String,
    photo_ids: String,
    free_text: String,
    answer: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    password: String,
}

#[derive(Debug, Deserialize)]
struct PostInput {
    title: String,
    body: String,
    kind: String,
    status: String,
    category: String,
    tags: String,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PhotoInput {
    title: String,
    description: String,
    category: String,
    tags: String,
}

#[derive(Debug, Deserialize)]
struct AnalyzeRequest {
    api_key: String,
    base_url: Option<String>,
    model: String,
    prompt: String,
    post_ids: Vec<i64>,
    photo_ids: Vec<i64>,
    free_text: Option<String>,
    save: Option<bool>,
    provider: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatMessageInput {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    api_key: String,
    base_url: Option<String>,
    model: String,
    post_ids: Vec<i64>,
    photo_ids: Vec<i64>,
    free_text: Option<String>,
    messages: Vec<ChatMessageInput>,
    stream: Option<bool>,
    provider: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatSessionSummary {
    id: i64,
    title: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct ChatSessionItem {
    id: i64,
    title: String,
    messages: String,
    context_post_ids: String,
    context_photo_ids: String,
    context_free_text: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct ChatSessionInput {
    title: Option<String>,
    messages: Option<String>,
    context_post_ids: Option<String>,
    context_photo_ids: Option<String>,
    context_free_text: Option<String>,
}

pub fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("personal_studio=info,tower_http=info"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .try_init();
}

pub fn init_tracing_with_file(log_dir: PathBuf) -> Result<PathBuf> {
    fs::create_dir_all(&log_dir).context("create log directory")?;
    let log_path = log_dir.join("backend.log");
    let file_appender = tracing_appender::rolling::never(&log_dir, "backend.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("personal_studio=info,tower_http=info"));

    let _ = LOG_GUARD.set(guard);
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(file_writer),
        )
        .try_init();
    Ok(log_path)
}

pub async fn run_server(data_dir: PathBuf, static_dir: PathBuf, addr: SocketAddr) -> Result<()> {
    let uploads_dir = data_dir.join("uploads");
    fs::create_dir_all(&uploads_dir).context("create upload directory")?;
    fs::create_dir_all(&static_dir).context("create static directory")?;

    let db_path = data_dir.join("site.sqlite3");
    init_db(&db_path)?;

    let owner_password =
        std::env::var("PERSONAL_SITE_PASSWORD").unwrap_or_else(|_| "123456".to_string());
    if owner_password == "123456" {
        warn!("PERSONAL_SITE_PASSWORD is not set. Temporary owner password: change-me");
    }

    let state = AppState {
        db_path,
        uploads_dir: uploads_dir.clone(),
        static_dir: static_dir.clone(),
        owner_password,
        sessions: Arc::new(Mutex::new(HashSet::new())),
        http: Client::new(),
    };

    let app = Router::new()
        .route("/", get(serve_index))
        .route("/index.html", get(serve_index))
        .route("/api/auth/login", post(login))
        .route("/api/auth/me", get(me))
        .route("/api/posts", get(list_posts).post(create_post))
        .route("/api/posts/{id}", put(update_post).delete(delete_post))
        .route(
            "/api/photos",
            get(list_photos)
                .post(upload_photo)
                .layer(DefaultBodyLimit::max(MAX_PHOTO_UPLOAD_BYTES)),
        )
        .route("/api/photos/{id}", put(update_photo).delete(delete_photo))
        .route("/api/analyses", get(list_analyses))
        .route("/api/analyses/{id}", delete(delete_analysis))
        .route("/api/analyze", post(analyze))
        .route("/api/chat", post(chat))
        .route(
            "/api/chat-sessions",
            get(list_chat_sessions).post(create_chat_session),
        )
        .route(
            "/api/chat-sessions/{id}",
            get(get_chat_session)
                .put(update_chat_session)
                .delete(delete_chat_session),
        )
        .route("/assets/{*path}", get(serve_asset))
        .nest_service("/uploads", ServeDir::new(uploads_dir.clone()))
        .fallback_service(
            tower::ServiceBuilder::new()
                .layer(SetResponseHeaderLayer::overriding(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static(
                        "no-store, no-cache, max-age=0, must-revalidate",
                    ),
                ))
                .service(ServeDir::new(static_dir).append_index_html_on_directories(true)),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    info!("Personal Studio is running at http://{addr}");
    axum::serve(tokio::net::TcpListener::bind(addr).await?, app).await?;
    Ok(())
}

fn init_db(path: &Path) -> Result<()> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
        create table if not exists posts (
            id integer primary key autoincrement,
            title text not null,
            body text not null,
            kind text not null default 'article',
            status text not null default 'draft',
            category text not null default '',
            tags text not null default '',
            created_at text not null,
            updated_at text not null
        );

        create table if not exists photos (
            id integer primary key autoincrement,
            title text not null default '',
            description text not null default '',
            category text not null default '',
            tags text not null default '',
            filename text not null,
            original_name text not null,
            mime text not null,
            latitude real,
            longitude real,
            created_at text not null,
            updated_at text not null
        );

        create table if not exists analyses (
            id integer primary key autoincrement,
            subject text not null default '',
            prompt text not null,
            model text not null,
            base_url text not null default '',
            post_ids text not null default '[]',
            photo_ids text not null default '[]',
            free_text text not null default '',
            answer text not null,
            created_at text not null
        );

        create table if not exists chat_sessions (
            id integer primary key autoincrement,
            title text not null default '新对话',
            messages text not null default '[]',
            context_post_ids text not null default '[]',
            context_photo_ids text not null default '[]',
            context_free_text text not null default '',
            created_at text not null,
            updated_at text not null
        );
        "#,
    )?;
    let _ = conn.execute("alter table photos add column latitude real", []);
    let _ = conn.execute("alter table photos add column longitude real", []);
    Ok(())
}

async fn serve_index(State(state): State<AppState>) -> ApiResult<Response> {
    serve_no_cache_text(
        state.static_dir.join("index.html"),
        "text/html; charset=utf-8",
    )
    .await
}

async fn serve_asset(
    State(state): State<AppState>,
    AxumPath(path): AxumPath<String>,
) -> ApiResult<Response> {
    if path.split('/').any(|part| part == ".." || part.is_empty()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "无效资源路径"));
    }
    let path = state.static_dir.join("assets").join(path);
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let body = tokio::fs::read(path).await?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type.as_str()),
            (
                header::CACHE_CONTROL,
                "no-store, no-cache, max-age=0, must-revalidate",
            ),
            (header::PRAGMA, "no-cache"),
            (header::EXPIRES, "0"),
        ],
        body,
    )
        .into_response())
}

async fn serve_no_cache_text(path: PathBuf, content_type: &'static str) -> ApiResult<Response> {
    let body = tokio::fs::read_to_string(path).await?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CACHE_CONTROL,
                "no-store, no-cache, max-age=0, must-revalidate",
            ),
            (header::PRAGMA, "no-cache"),
            (header::EXPIRES, "0"),
        ],
        body,
    )
        .into_response())
}

async fn login(
    State(state): State<AppState>,
    Json(input): Json<LoginRequest>,
) -> ApiResult<Json<Value>> {
    if input.password != state.owner_password {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "密码不对"));
    }
    let token = Uuid::new_v4().to_string();
    state.sessions.lock().unwrap().insert(token.clone());
    Ok(Json(json!({ "token": token, "role": "owner" })))
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Json<Value> {
    let role = if is_owner(&state, &headers) {
        "owner"
    } else {
        "guest"
    };
    Json(json!({ "role": role }))
}

async fn list_posts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<PostItem>>> {
    let owner = is_owner(&state, &headers);
    let conn = Connection::open(&state.db_path)?;
    let sql = if owner {
        "select id, title, body, kind, status, category, tags, created_at, updated_at from posts order by updated_at desc"
    } else {
        "select id, title, body, kind, status, category, tags, created_at, updated_at from posts where status = 'published' order by updated_at desc"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map([], post_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

async fn create_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PostInput>,
) -> ApiResult<Json<PostItem>> {
    require_owner(&state, &headers)?;
    validate_post(&input)?;
    let created_at = Utc::now().to_rfc3339();
    let updated_at = input
        .updated_at
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "insert into posts (title, body, kind, status, category, tags, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![input.title.trim(), input.body, input.kind, input.status, input.category.trim(), input.tags.trim(), created_at, updated_at],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Json(load_post(&conn, id)?))
}

async fn update_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    Json(input): Json<PostInput>,
) -> ApiResult<Json<PostItem>> {
    require_owner(&state, &headers)?;
    validate_post(&input)?;
    let updated_at = input
        .updated_at
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let conn = Connection::open(&state.db_path)?;
    let changed = conn.execute(
        "update posts set title = ?1, body = ?2, kind = ?3, status = ?4, category = ?5, tags = ?6, updated_at = ?7 where id = ?8",
        params![input.title.trim(), input.body, input.kind, input.status, input.category.trim(), input.tags.trim(), updated_at, id],
    )?;
    if changed == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "文章不存在"));
    }
    Ok(Json(load_post(&conn, id)?))
}

async fn delete_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<StatusCode> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    conn.execute("delete from posts where id = ?1", params![id])?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_photos(State(state): State<AppState>) -> ApiResult<Json<Vec<PhotoItem>>> {
    let rows = {
        let conn = Connection::open(&state.db_path)?;
        let mut stmt = conn.prepare(
            "select id, title, description, category, tags, filename, original_name, mime, latitude, longitude, created_at, updated_at from photos order by updated_at desc",
        )?;
        let rows = stmt
            .query_map([], photo_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for photo in &rows {
        ensure_photo_thumbnail(&state.uploads_dir, &photo.filename).await?;
    }
    Ok(Json(rows))
}

async fn upload_photo(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> ApiResult<Json<PhotoItem>> {
    require_owner(&state, &headers)?;
    let mut title = String::new();
    let mut description = String::new();
    let mut category = String::new();
    let mut tags = String::new();
    let mut file: Option<(String, String, Bytes)> = None;

    while let Some(field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or_default().to_string();
        if name == "file" {
            let original = field.file_name().unwrap_or("photo").to_string();
            let mime = field
                .content_type()
                .map(ToString::to_string)
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let bytes = field.bytes().await.map_err(multipart_error)?;
            file = Some((original, mime, bytes));
        } else {
            let value = field.text().await.map_err(multipart_error)?;
            match name.as_str() {
                "title" => title = value,
                "description" => description = value,
                "category" => category = value,
                "tags" => tags = value,
                _ => {}
            }
        }
    }

    let (original, mime, bytes) =
        file.ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "请选择图片"))?;
    if !mime.starts_with("image/") {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "只能上传图片"));
    }
    let ext = mime_guess::get_mime_extensions_str(&mime)
        .and_then(|items| items.first().copied())
        .unwrap_or("bin");
    let location = extract_gps_location(&bytes);
    let filename = format!("{}.{}", Uuid::new_v4(), ext);
    tokio::fs::write(state.uploads_dir.join(&filename), bytes).await?;
    ensure_photo_thumbnail(&state.uploads_dir, &filename).await?;

    let now = Utc::now().to_rfc3339();
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "insert into photos (title, description, category, tags, filename, original_name, mime, latitude, longitude, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![title.trim(), description.trim(), category.trim(), tags.trim(), filename, original, mime, location.map(|item| item.0), location.map(|item| item.1), now],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Json(load_photo(&conn, id)?))
}

async fn update_photo(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    Json(input): Json<PhotoInput>,
) -> ApiResult<Json<PhotoItem>> {
    require_owner(&state, &headers)?;
    let now = Utc::now().to_rfc3339();
    let conn = Connection::open(&state.db_path)?;
    let changed = conn.execute(
        "update photos set title = ?1, description = ?2, category = ?3, tags = ?4, updated_at = ?5 where id = ?6",
        params![input.title.trim(), input.description.trim(), input.category.trim(), input.tags.trim(), now, id],
    )?;
    if changed == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "照片不存在"));
    }
    Ok(Json(load_photo(&conn, id)?))
}

async fn delete_photo(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<StatusCode> {
    require_owner(&state, &headers)?;
    let filename = {
        let conn = Connection::open(&state.db_path)?;
        let filename = conn
            .query_row(
                "select filename from photos where id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        conn.execute("delete from photos where id = ?1", params![id])?;
        filename
    };
    if let Some(filename) = filename {
        let _ = tokio::fs::remove_file(state.uploads_dir.join(&filename)).await;
        let _ = tokio::fs::remove_file(state.uploads_dir.join(thumbnail_filename(&filename))).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_analyses(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<AnalysisItem>>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select id, subject, prompt, model, base_url, post_ids, photo_ids, free_text, answer, created_at from analyses where prompt not like '请为下面这篇个人文章或随手想法生成一个中文标题%' order by created_at desc",
    )?;
    let rows = stmt
        .query_map([], analysis_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

async fn delete_analysis(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<StatusCode> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    conn.execute("delete from analyses where id = ?1", params![id])?;
    Ok(StatusCode::NO_CONTENT)
}

async fn analyze(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AnalyzeRequest>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &headers)?;
    if input.api_key.trim().is_empty() || input.model.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "请填写 API Key 和模型名",
        ));
    }
    let has_free_text = input
        .free_text
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if input.post_ids.is_empty() && input.photo_ids.is_empty() && !has_free_text {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "请先选择或填写需要分析的内容",
        ));
    }

    let conn = Connection::open(&state.db_path)?;
    let mut text = String::new();
    if let Some(free_text) = input.free_text.as_deref() {
        if !free_text.trim().is_empty() {
            text.push_str("\n[指定片段]\n");
            text.push_str(free_text.trim());
            text.push('\n');
        }
    }
    let mut subject_parts = Vec::new();
    for id in &input.post_ids {
        let post = load_post(&conn, *id)?;
        subject_parts.push(format!("{} · {}", post.title, kind_name_rust(&post.kind)));
        text.push_str(&format!(
            "\n[{}: {} / {}] ({})\n{}\n",
            post.kind, post.title, post.category, post.updated_at, post.body
        ));
    }

    let mut photo_items = Vec::new();
    for id in &input.photo_ids {
        let photo = load_photo(&conn, *id)?;
        subject_parts.push(format!(
            "{} · 照片",
            if photo.title.is_empty() {
                photo.original_name.clone()
            } else {
                photo.title.clone()
            }
        ));
        let bytes = tokio::fs::read(state.uploads_dir.join(&photo.filename)).await?;
        let b64 = general_purpose::STANDARD.encode(bytes);
        photo_items.push((photo, b64));
    }

    let is_anthropic = input.provider.as_deref().unwrap_or("") == "anthropic";

    let base_url = input
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(if is_anthropic { "https://api.anthropic.com" } else { "https://api.openai.com" })
        .trim()
        .trim_end_matches('/');

    let answer: String;
    if is_anthropic {
        let endpoint = llm_endpoint(base_url, "/v1/messages");
        let mut content: Vec<Value> = vec![json!({
            "type": "text",
            "text": format!("{}\n\n{}", input.prompt.trim(), text.trim())
        })];
        for (photo, b64) in &photo_items {
            content.push(json!({
                "type": "text",
                "text": format!("图片：{}；说明：{}；分类：{}；标签：{}", photo.title, photo.description, photo.category, photo.tags)
            }));
            content.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": photo.mime.as_str(),
                    "data": b64
                }
            }));
        }
        let payload = json!({
            "model": input.model.trim(),
            "system": "你是个人知识库里的分析助手。优先基于用户选中的文章、想法、照片和指定片段回答；如果上下文不足，请明确说明。",
            "messages": [{ "role": "user", "content": content }],
            "max_tokens": 4096
        });
        let resp = state
            .http
            .post(endpoint)
            .header("x-api-key", input.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&payload)
            .send()
            .await
            .map_err(|err| {
                let msg = format_reqwest_error(&err);
                warn!("{msg}");
                ApiError::new(StatusCode::BAD_GATEWAY, msg)
            })?;
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let value: Value = serde_json::from_str(&body_text).unwrap_or_else(|_| json!({ "message": body_text }));
        if !status.is_success() {
            let msg = format!("LLM 返回错误：{}", extract_llm_error(&value));
            warn!("{msg} (HTTP {status}, 原始响应: {body_text})");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, msg));
        }
        answer = value["content"][0]["text"]
            .as_str()
            .unwrap_or("没有拿到可读回复")
            .to_string();
    } else {
        let endpoint = llm_endpoint(base_url, "/v1/chat/completions");
        let mut content = vec![json!({
            "type": "text",
            "text": format!("{}\n\n{}", input.prompt.trim(), text.trim())
        })];
        for (photo, b64) in &photo_items {
            content.push(json!({
                "type": "text",
                "text": format!("图片：{}；说明：{}；分类：{}；标签：{}", photo.title, photo.description, photo.category, photo.tags)
            }));
            content.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{};base64,{}", photo.mime, b64) }
            }));
        }
        let mut payload = json!({
            "model": input.model.trim(),
            "messages": [{ "role": "user", "content": content }],
            "temperature": 0.3
        });
        apply_openai_compatible_provider_options(&mut payload, input.provider.as_deref());
        let resp = with_llm_auth(
            state.http.post(endpoint),
            input.provider.as_deref(),
            input.api_key.trim(),
        )
            .json(&payload)
            .send()
            .await
            .map_err(|err| {
                let msg = format_reqwest_error(&err);
                warn!("{msg}");
                ApiError::new(StatusCode::BAD_GATEWAY, msg)
            })?;
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        let value: Value = serde_json::from_str(&body_text).unwrap_or_else(|_| json!({ "message": body_text }));
        if !status.is_success() {
            let msg = format!("LLM 返回错误：{}", extract_llm_error(&value));
            warn!("{msg} (HTTP {status}, 原始响应: {body_text})");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, msg));
        }
        answer = value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("没有拿到可读回复")
            .to_string();
    }

    let mut id = Value::Null;
    if input.save.unwrap_or(true) {
        let subject = if subject_parts.is_empty() {
            "指定片段".to_string()
        } else {
            subject_parts.join(" / ")
        };
        let created_at = Utc::now().to_rfc3339();
        conn.execute(
            "insert into analyses (subject, prompt, model, base_url, post_ids, photo_ids, free_text, answer, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                subject,
                input.prompt.trim(),
                input.model.trim(),
                base_url,
                serde_json::to_string(&input.post_ids).unwrap_or_else(|_| "[]".to_string()),
                serde_json::to_string(&input.photo_ids).unwrap_or_else(|_| "[]".to_string()),
                input.free_text.as_deref().unwrap_or("").trim(),
                answer,
                created_at,
            ],
        )?;
        id = json!(conn.last_insert_rowid());
    }
    Ok(Json(json!({ "id": id, "answer": answer })))
}

async fn chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ChatRequest>,
) -> ApiResult<Response> {
    require_owner(&state, &headers)?;
    if input.api_key.trim().is_empty() || input.model.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "请填写 API Key 和模型名",
        ));
    }
    if input.messages.is_empty()
        || input
            .messages
            .last()
            .is_none_or(|message| message.content.trim().is_empty())
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请输入要发送的内容"));
    }

    let conn = Connection::open(&state.db_path)?;
    let mut context_text = String::new();
    if let Some(free_text) = input.free_text.as_deref() {
        if !free_text.trim().is_empty() {
            context_text.push_str("\n[指定片段]\n");
            context_text.push_str(free_text.trim());
            context_text.push('\n');
        }
    }
    for id in &input.post_ids {
        let post = load_post(&conn, *id)?;
        context_text.push_str(&format!(
            "\n[{}: {} / {}] ({})\n{}\n",
            post.kind, post.title, post.category, post.updated_at, post.body
        ));
    }

    let mut photos = Vec::new();
    for id in &input.photo_ids {
        let photo = load_photo(&conn, *id)?;
        let bytes = tokio::fs::read(state.uploads_dir.join(&photo.filename)).await?;
        let b64 = general_purpose::STANDARD.encode(bytes);
        photos.push((photo, b64));
    }

    let is_anthropic = input.provider.as_deref().unwrap_or("") == "anthropic";

    let base_url = input
        .base_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(if is_anthropic { "https://api.anthropic.com" } else { "https://api.openai.com" })
        .trim()
        .trim_end_matches('/');

    let stream = input.stream.unwrap_or(false);

    if is_anthropic {
        let endpoint = llm_endpoint(base_url, "/v1/messages");
        let system_text = "你是个人知识库里的对话助手。优先基于用户选中的文章、想法、照片和指定片段回答；如果上下文不足，请明确说明。";

        let mut context_parts: Vec<Value> = vec![];
        if !context_text.trim().is_empty() {
            context_parts.push(json!({
                "type": "text",
                "text": format!("以下是本次对话的上下文：\n{}", context_text.trim())
            }));
        }
        for (photo, b64) in &photos {
            context_parts.push(json!({
                "type": "text",
                "text": format!("图片：{}；说明：{}；分类：{}；标签：{}", photo.title, photo.description, photo.category, photo.tags)
            }));
            context_parts.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": photo.mime.as_str(),
                    "data": b64
                }
            }));
        }

        let mut messages: Vec<Value> = vec![];
        let mut current_user_parts: Vec<Value> = vec![];

        for message in &input.messages {
            if message.content.trim().is_empty() {
                continue;
            }
            if message.role == "assistant" {
                if !current_user_parts.is_empty() {
                    messages.push(json!({ "role": "user", "content": current_user_parts }));
                    current_user_parts = vec![];
                }
                messages.push(json!({ "role": "assistant", "content": message.content.trim() }));
            } else {
                current_user_parts.push(json!({ "type": "text", "text": message.content.trim() }));
            }
        }

        if !current_user_parts.is_empty() {
            if messages.is_empty() && !context_parts.is_empty() {
                let mut merged = context_parts;
                merged.append(&mut current_user_parts);
                messages.push(json!({ "role": "user", "content": merged }));
            } else {
                if !context_parts.is_empty() {
                    messages.push(json!({ "role": "user", "content": context_parts }));
                }
                messages.push(json!({ "role": "user", "content": current_user_parts }));
            }
        } else if !context_parts.is_empty() {
            messages.push(json!({ "role": "user", "content": context_parts }));
        }

        let payload = json!({
            "model": input.model.trim(),
            "system": system_text,
            "messages": messages,
            "max_tokens": 4096,
            "stream": stream
        });

        let req = state
            .http
            .post(endpoint)
            .header("x-api-key", input.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&payload);

        let resp = req
            .send()
            .await
            .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, format!("LLM 请求失败：{err}")))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }));
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("LLM 返回错误：{}", extract_llm_error(&value)),
            ));
        }

        if stream {
            let (tx, rx): (mpsc::Sender<Result<Event, std::convert::Infallible>>, _) = mpsc::channel(32);
            let sse_stream = tokio_stream::wrappers::ReceiverStream::new(rx);

            tokio::spawn(async move {
                let mut byte_stream = resp.bytes_stream();
                let mut buf = String::new();

                while let Some(result) = byte_stream.next().await {
                    match result {
                        Ok(bytes) => {
                            buf.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(pos) = buf.find('\n') {
                                let line = buf.drain(..=pos).collect::<String>();
                                let line = line.trim_end();
                                if line.starts_with("data: ") {
                                    let data = line.strip_prefix("data: ").unwrap_or("").trim();
                                    if data == "[DONE]" {
                                        let _ = tx.send(Ok(Event::default().data("[DONE]"))).await;
                                        return;
                                    }
                                    if let Ok(json) = serde_json::from_str::<Value>(data) {
                                        if let Some(content) = json["delta"]["text"].as_str() {
                                            if !content.is_empty() {
                                                let payload = json!({ "delta": { "text": content } }).to_string();
                                                let _ = tx.send(Ok(Event::default().data(payload))).await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            });

            Ok(Sse::new(sse_stream).into_response())
        } else {
            let value: Value = resp.json().await.unwrap_or_else(|_| json!({}));
            let answer = value["content"][0]["text"]
                .as_str()
                .unwrap_or("没有拿到可读回复");
            Ok(Json(json!({ "answer": answer })).into_response())
        }
    } else {
        let endpoint = llm_endpoint(base_url, "/v1/chat/completions");

        let mut messages = vec![json!({
            "role": "system",
            "content": "你是个人知识库里的对话助手。优先基于用户选中的文章、想法、照片和指定片段回答；如果上下文不足，请明确说明。"
        })];

        if photos.is_empty() {
            if !context_text.trim().is_empty() {
                messages.push(json!({
                    "role": "user",
                    "content": format!("以下是本次对话的上下文：\n{}", context_text.trim())
                }));
            }
        } else {
            let mut context_content = vec![json!({
                "type": "text",
                "text": format!("以下是本次对话的上下文：\n{}", context_text.trim())
            })];
            for (photo, b64) in &photos {
                context_content.push(json!({
                    "type": "text",
                    "text": format!("图片：{}；说明：{}；分类：{}；标签：{}", photo.title, photo.description, photo.category, photo.tags)
                }));
                context_content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", photo.mime, b64) }
                }));
            }
            messages.push(json!({ "role": "user", "content": context_content }));
        }

        for message in &input.messages {
            if message.content.trim().is_empty() {
                continue;
            }
            let role = if message.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            messages.push(json!({ "role": role, "content": message.content.trim() }));
        }

        let mut payload = json!({
            "model": input.model.trim(),
            "messages": messages,
            "temperature": 0.4,
            "stream": stream
        });
        apply_openai_compatible_provider_options(&mut payload, input.provider.as_deref());

        let resp = with_llm_auth(
            state.http.post(endpoint),
            input.provider.as_deref(),
            input.api_key.trim(),
        )
            .json(&payload)
            .send()
            .await
            .map_err(|err| {
                let msg = format_reqwest_error(&err);
                warn!("{msg}");
                ApiError::new(StatusCode::BAD_GATEWAY, msg)
            })?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }));
            let msg = format!("LLM 返回错误：{}", extract_llm_error(&value));
            warn!("{msg} (HTTP {status}, 原始响应: {text})");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, msg));
        }

        if stream {
            let (tx, rx): (mpsc::Sender<Result<Event, std::convert::Infallible>>, _) = mpsc::channel(32);
            let sse_stream = tokio_stream::wrappers::ReceiverStream::new(rx);

            tokio::spawn(async move {
                let mut byte_stream = resp.bytes_stream();
                let mut buf = String::new();

                while let Some(result) = byte_stream.next().await {
                    match result {
                        Ok(bytes) => {
                            buf.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(pos) = buf.find('\n') {
                                let line = buf.drain(..=pos).collect::<String>();
                                let line = line.trim_end();
                                if line.starts_with("data: ") {
                                    let data = line.strip_prefix("data: ").unwrap_or("").trim();
                                    if data == "[DONE]" {
                                        let _ = tx.send(Ok(Event::default().data("[DONE]"))).await;
                                        return;
                                    }
                                    if let Ok(json) = serde_json::from_str::<Value>(data) {
                                        if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                                            if !content.is_empty() {
                                                let payload = json!({ "choices": [{ "delta": { "content": content } }] }).to_string();
                                                let _ = tx.send(Ok(Event::default().data(payload))).await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            });

            Ok(Sse::new(sse_stream).into_response())
        } else {
            let value: Value = resp.json().await.unwrap_or_else(|_| json!({}));
            let answer = value["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("没有拿到可读回复");
            let usage = value.get("usage").cloned().unwrap_or(Value::Null);
            Ok(Json(json!({ "answer": answer, "usage": usage })).into_response())
        }
    }
}

async fn list_chat_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<ChatSessionSummary>>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select id, title, created_at, updated_at from chat_sessions order by updated_at desc",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ChatSessionSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

async fn create_chat_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ChatSessionInput>,
) -> ApiResult<Json<ChatSessionItem>> {
    require_owner(&state, &headers)?;
    let now = Utc::now().to_rfc3339();
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "insert into chat_sessions (title, messages, context_post_ids, context_photo_ids, context_free_text, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            input.title.as_deref().unwrap_or("新对话"),
            input.messages.as_deref().unwrap_or("[]"),
            input.context_post_ids.as_deref().unwrap_or("[]"),
            input.context_photo_ids.as_deref().unwrap_or("[]"),
            input.context_free_text.as_deref().unwrap_or(""),
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Json(load_chat_session_item(&conn, id)?))
}

async fn get_chat_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<Json<ChatSessionItem>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    Ok(Json(load_chat_session_item(&conn, id)?))
}

async fn update_chat_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    Json(input): Json<ChatSessionInput>,
) -> ApiResult<Json<ChatSessionItem>> {
    require_owner(&state, &headers)?;
    let now = Utc::now().to_rfc3339();
    let conn = Connection::open(&state.db_path)?;
    let changed = conn.execute(
        "update chat_sessions set title = coalesce(?1, title), messages = coalesce(?2, messages), context_post_ids = coalesce(?3, context_post_ids), context_photo_ids = coalesce(?4, context_photo_ids), context_free_text = coalesce(?5, context_free_text), updated_at = ?6 where id = ?7",
        params![
            input.title,
            input.messages,
            input.context_post_ids,
            input.context_photo_ids,
            input.context_free_text,
            now,
            id,
        ],
    )?;
    if changed == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "会话不存在"));
    }
    Ok(Json(load_chat_session_item(&conn, id)?))
}

async fn delete_chat_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<StatusCode> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    conn.execute("delete from chat_sessions where id = ?1", params![id])?;
    Ok(StatusCode::NO_CONTENT)
}

fn load_chat_session_item(conn: &Connection, id: i64) -> ApiResult<ChatSessionItem> {
    conn.query_row(
        "select id, title, messages, context_post_ids, context_photo_ids, context_free_text, created_at, updated_at from chat_sessions where id = ?1",
        params![id],
        |row| {
            Ok(ChatSessionItem {
                id: row.get(0)?,
                title: row.get(1)?,
                messages: row.get(2)?,
                context_post_ids: row.get(3)?,
                context_photo_ids: row.get(4)?,
                context_free_text: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "会话不存在"))
}

fn extract_llm_error(value: &Value) -> String {
    let raw = value
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|v| v.as_str())
        .or_else(|| value.get("message").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| value.to_string());

    if raw.trim_start().starts_with('<') {
        if let Some(title) = raw.lines().find(|l| l.contains("<title>")).and_then(|l| {
            l.trim().strip_prefix("<title>").and_then(|s| s.strip_suffix("</title>"))
        }) {
            return format!("服务商返回 HTML 错误页面：{title}，请检查 base_url 配置");
        }
        "服务商返回了 HTML 错误页面，请检查 base_url 配置".to_string()
    } else {
        raw
    }
}

fn llm_endpoint(base_url: &str, default_path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let normalized_path = default_path.trim_start_matches('/');
    let version_prefix = normalized_path
        .split_once('/')
        .map(|(prefix, _)| prefix)
        .unwrap_or(normalized_path);

    if base.rsplit('/').next() == Some(version_prefix) {
        let suffix = normalized_path
            .strip_prefix(version_prefix)
            .unwrap_or("")
            .trim_start_matches('/');
        if suffix.is_empty() {
            base.to_string()
        } else {
            format!("{base}/{suffix}")
        }
    } else {
        format!("{base}/{normalized_path}")
    }
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts = vec!["LLM 请求失败".to_string()];
    if err.is_timeout() {
        parts.push("原因：请求超时".to_string());
    } else if err.is_connect() {
        parts.push("原因：连接失败（网络不通、DNS 错误或服务器拒绝连接）".to_string());
    } else if err.is_request() {
        parts.push("原因：请求发送失败".to_string());
    }
    if let Some(url) = err.url() {
        parts.push(format!("请求地址：{url}"));
    }
    parts.push(format!("reqwest 错误：{err}"));
    let mut source = err.source();
    while let Some(s) = source {
        parts.push(format!("底层错误：{s}"));
        source = s.source();
    }
    parts.join(" | ")
}

fn with_llm_auth(
    request: reqwest::RequestBuilder,
    provider: Option<&str>,
    api_key: &str,
) -> reqwest::RequestBuilder {
    let request = request.bearer_auth(api_key);
    if provider == Some("mimo") {
        request.header("api-key", api_key)
    } else {
        request
    }
}

fn apply_openai_compatible_provider_options(payload: &mut Value, provider: Option<&str>) {
    if provider == Some("mimo") {
        payload["thinking"] = json!({ "type": "disabled" });
    }
}

fn kind_name_rust(kind: &str) -> &'static str {
    match kind {
        "article" => "文章",
        "thought" => "想法",
        "note" => "随手写",
        _ => "文字",
    }
}

fn is_owner(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let Some(token) = value.strip_prefix("Bearer ") else {
        return false;
    };
    state.sessions.lock().unwrap().contains(token)
}

fn require_owner(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    if is_owner(state, headers) {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::UNAUTHORIZED, "需要主人登录"))
    }
}

fn validate_post(input: &PostInput) -> ApiResult<()> {
    if input.title.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "标题不能为空"));
    }
    if !["article", "thought", "note"].contains(&input.kind.as_str()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "类型不合法"));
    }
    if !["draft", "published"].contains(&input.status.as_str()) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "状态不合法"));
    }
    Ok(())
}

fn multipart_error(error: axum::extract::multipart::MultipartError) -> ApiError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "图片不能超过 50MB");
    }

    ApiError::new(StatusCode::BAD_REQUEST, error.body_text())
}

async fn ensure_photo_thumbnail(uploads_dir: &Path, filename: &str) -> ApiResult<()> {
    let thumbnail = thumbnail_filename(filename);
    let thumbnail_path = uploads_dir.join(&thumbnail);
    if tokio::fs::try_exists(&thumbnail_path)
        .await
        .unwrap_or(false)
    {
        return Ok(());
    }

    let source_path = uploads_dir.join(filename);
    let bytes = match tokio::fs::read(source_path).await {
        Ok(bytes) => bytes,
        Err(_) => return Ok(()),
    };
    let thumbnail_bytes = tokio::task::spawn_blocking(move || create_thumbnail_bytes(bytes))
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if let Some(thumbnail_bytes) = thumbnail_bytes {
        tokio::fs::write(thumbnail_path, thumbnail_bytes).await?;
    }
    Ok(())
}

fn create_thumbnail_bytes(bytes: Vec<u8>) -> Option<Vec<u8>> {
    let mut decoder = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let icc_profile = decoder.icc_profile().ok().flatten();
    let image = DynamicImage::from_decoder(decoder).ok()?;
    let thumbnail = image.thumbnail(PHOTO_THUMB_MAX_SIZE, PHOTO_THUMB_MAX_SIZE);
    let mut output = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut output, 78);
    if let Some(icc_profile) = icc_profile {
        let _ = encoder.set_icc_profile(icc_profile);
    }
    encoder.encode_image(&thumbnail).ok()?;
    Some(output)
}

fn thumbnail_filename(filename: &str) -> String {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|item| item.to_str())
        .filter(|item| !item.is_empty())
        .unwrap_or(filename);
    format!("thumb-v2-{stem}.jpg")
}

fn load_post(conn: &Connection, id: i64) -> ApiResult<PostItem> {
    conn.query_row(
        "select id, title, body, kind, status, category, tags, created_at, updated_at from posts where id = ?1",
        params![id],
        post_from_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "文章不存在"))
}

fn load_photo(conn: &Connection, id: i64) -> ApiResult<PhotoItem> {
    conn.query_row(
        "select id, title, description, category, tags, filename, original_name, mime, latitude, longitude, created_at, updated_at from photos where id = ?1",
        params![id],
        photo_from_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "照片不存在"))
}

fn post_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PostItem> {
    Ok(PostItem {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        kind: row.get(3)?,
        status: row.get(4)?,
        category: row.get(5)?,
        tags: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn photo_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PhotoItem> {
    let filename: String = row.get(5)?;
    Ok(PhotoItem {
        id: row.get(0)?,
        title: row.get(1)?,
        description: row.get(2)?,
        category: row.get(3)?,
        tags: row.get(4)?,
        url: format!("/uploads/{filename}"),
        thumbnail_url: format!("/uploads/{}", thumbnail_filename(&filename)),
        filename,
        original_name: row.get(6)?,
        mime: row.get(7)?,
        latitude: row.get(8)?,
        longitude: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn extract_gps_location(bytes: &[u8]) -> Option<(f64, f64)> {
    let exif = ExifReader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()?;
    let latitude = exif_rational_coordinate(
        &exif.get_field(Tag::GPSLatitude, In::PRIMARY)?.value,
        exif.get_field(Tag::GPSLatitudeRef, In::PRIMARY)
            .and_then(|field| exif_ascii(&field.value))
            .unwrap_or("N"),
    )?;
    let longitude = exif_rational_coordinate(
        &exif.get_field(Tag::GPSLongitude, In::PRIMARY)?.value,
        exif.get_field(Tag::GPSLongitudeRef, In::PRIMARY)
            .and_then(|field| exif_ascii(&field.value))
            .unwrap_or("E"),
    )?;
    Some((latitude, longitude))
}

fn exif_rational_coordinate(value: &ExifValue, direction: &str) -> Option<f64> {
    let ExifValue::Rational(items) = value else {
        return None;
    };
    if items.len() < 3 {
        return None;
    }
    let degrees = items[0].to_f64();
    let minutes = items[1].to_f64();
    let seconds = items[2].to_f64();
    let sign = if matches!(direction, "S" | "W") {
        -1.0
    } else {
        1.0
    };
    Some(sign * (degrees + minutes / 60.0 + seconds / 3600.0))
}

fn exif_ascii(value: &ExifValue) -> Option<&str> {
    let ExifValue::Ascii(items) = value else {
        return None;
    };
    std::str::from_utf8(items.first()?).ok().map(str::trim)
}

fn analysis_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnalysisItem> {
    Ok(AnalysisItem {
        id: row.get(0)?,
        subject: row.get(1)?,
        prompt: row.get(2)?,
        model: row.get(3)?,
        base_url: row.get(4)?,
        post_ids: row.get(5)?,
        photo_ids: row.get(6)?,
        free_text: row.get(7)?,
        answer: row.get(8)?,
        created_at: row.get(9)?,
    })
}

type ApiResult<T> = std::result::Result<T, ApiError>;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({
                "error": self.message
            })),
        )
            .into_response()
    }
}
