use std::{
    collections::{HashMap, HashSet},
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
use chrono::{DateTime, Utc};
use exif::{In, Reader as ExifReader, Tag, Value as ExifValue};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, ImageDecoder, ImageEncoder, ImageReader};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer, trace::TraceLayer};
use tracing::{info, warn};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use uuid::Uuid;

const MAX_PHOTO_UPLOAD_BYTES: usize = 50 * 1024 * 1024;
const PHOTO_THUMB_MAX_SIZE: u32 = 720;
const DEFAULT_LOCATION_PROMPT: &str = "请从下面这篇个人文章或随手想法中提取所有真实存在的地点。对每个地点给出尽可能详细的名称（如\"浙江省杭州市西湖区西湖\"），以便后续地理编码。只返回 JSON 数组，不要解释。格式：[{\"name\":\"...\"}]";
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

#[derive(Debug, Serialize)]
struct LocationItem {
    id: i64,
    name: String,
    latitude: f64,
    longitude: f64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct LocationDetail {
    location: LocationItem,
    posts: Vec<PostItem>,
    photos: Vec<PhotoItem>,
}

#[derive(Debug, Deserialize)]
struct ExtractLocationsRequest {
    post_id: i64,
    amap_key: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    provider: Option<String>,
    prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AddLocationRequest {
    name: String,
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
struct LlmTestRequest {
    api_key: String,
    base_url: Option<String>,
    model: String,
    provider: Option<String>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingTestRequest {
    api_key: String,
    base_url: Option<String>,
    model: String,
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
    use_memory: Option<bool>,
    memory_budget_tokens: Option<usize>,
    embedding_model: Option<String>,
    embedding_api_key: Option<String>,
    embedding_base_url: Option<String>,
    embedding_provider: Option<String>,
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
    use_memory: bool,
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
    use_memory: Option<bool>,
}

#[derive(Debug, Serialize)]
struct MemoryItem {
    id: i64,
    content: String,
    normalized_content: String,
    topic: String,
    domain: String,
    status: String,
    relation: String,
    related_memory_id: Option<i64>,
    source_session_id: Option<i64>,
    supersedes_id: Option<i64>,
    mention_count: i64,
    confidence: f64,
    last_mentioned_at: String,
    valid_from: String,
    occurred_at: String,
    created_at: String,
    updated_at: String,
    kind: String,
    time_precision: String,
    importance: f64,
    emotion_weight: f64,
    strength: f64,
    last_activated_at: String,
    cues: Vec<MemoryCue>,
    sources: Vec<MemorySource>,
    edges: Vec<MemoryEdge>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MemoryCue {
    cue_type: String,
    value: String,
    specificity: f64,
}

#[derive(Debug, Serialize, Clone)]
struct MemorySource {
    source_type: String,
    source_id: Option<i64>,
    excerpt: String,
}

#[derive(Debug, Serialize, Clone)]
struct MemoryEdge {
    target_id: i64,
    relation: String,
    weight: f64,
}

#[derive(Debug, Deserialize)]
struct MemoryInput {
    content: Option<String>,
    topic: Option<String>,
    domain: Option<String>,
    status: Option<String>,
    relation: Option<String>,
    related_memory_id: Option<i64>,
    source_session_id: Option<i64>,
    confidence: Option<f64>,
    occurred_at: Option<String>,
    kind: Option<String>,
    time_precision: Option<String>,
    importance: Option<f64>,
    emotion_weight: Option<f64>,
    cues: Option<Vec<MemoryCue>>,
}

#[derive(Debug, Serialize)]
struct MemorySummaryItem {
    id: i64,
    kind: String,
    title: String,
    content: String,
    source_memory_ids: String,
    status: String,
    version: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
struct MemorySummaryInput {
    kind: Option<String>,
    title: Option<String>,
    content: Option<String>,
    source_memory_ids: Option<Vec<i64>>,
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MemoryExtractRequest {
    api_key: String,
    base_url: Option<String>,
    model: String,
    provider: Option<String>,
    session_id: Option<i64>,
    messages: Vec<ChatMessageInput>,
    #[serde(default)]
    post_ids: Vec<i64>,
    #[serde(default)]
    photo_ids: Vec<i64>,
    free_text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MemorySummaryGenerateRequest {
    api_key: String,
    base_url: Option<String>,
    model: String,
    provider: Option<String>,
    kind: String,
    title: String,
}

#[derive(Debug, Deserialize)]
struct ExtractedMemory {
    content: String,
    #[serde(default)]
    topic: String,
    #[serde(default)]
    domain: String,
    #[serde(default = "default_memory_relation")]
    relation: String,
    related_memory_id: Option<i64>,
    #[serde(default = "default_confidence")]
    confidence: f64,
    #[serde(default)]
    occurred_at: Option<String>,
    #[serde(default)]
    source_post_id: Option<i64>,
    #[serde(default = "default_memory_kind")]
    kind: String,
    #[serde(default = "default_time_precision")]
    time_precision: String,
    #[serde(default = "default_importance")]
    importance: f64,
    #[serde(default)]
    emotion_weight: f64,
    #[serde(default)]
    cues: Vec<MemoryCue>,
}

fn default_memory_kind() -> String {
    "fact".to_string()
}
fn default_time_precision() -> String {
    "unknown".to_string()
}
fn default_importance() -> f64 {
    0.5
}

fn default_memory_relation() -> String {
    "new".to_string()
}

fn default_confidence() -> f64 {
    0.7
}

#[derive(Debug, Serialize, Default, Clone)]
struct MemoryRecallMeta {
    domains: usize,
    topics: usize,
    memories: usize,
    estimated_tokens: usize,
    semantic: bool,
    mode: String,
    depth: String,
    breadth: usize,
    candidates: usize,
    selected_node_ids: Vec<i64>,
    expanded_node_ids: Vec<i64>,
    planned: bool,
    scores: Vec<MemoryRecallScore>,
}

#[derive(Debug, Serialize, Clone)]
struct MemoryRecallScore {
    node_id: i64,
    score: f64,
    reason: String,
}

#[derive(Debug)]
struct MemoryRecall {
    text: String,
    meta: MemoryRecallMeta,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MemoryRetrievalPlan {
    #[serde(default = "default_recall_goal")]
    goal: String,
    #[serde(default = "default_recall_depth")]
    depth: String,
    #[serde(default = "default_recall_breadth")]
    breadth: usize,
    #[serde(default)]
    cues: Vec<String>,
    #[serde(default)]
    exclusions: Vec<String>,
}

fn default_recall_goal() -> String {
    "回答当前问题".to_string()
}
fn default_recall_depth() -> String {
    "balanced".to_string()
}
fn default_recall_breadth() -> usize {
    3
}

#[derive(Debug, Deserialize)]
struct MemoryRecallPreviewRequest {
    query: String,
    budget_tokens: Option<usize>,
}

#[derive(Debug, Serialize)]
struct MemoryRecallEventItem {
    id: i64,
    query: String,
    mode: String,
    depth: String,
    breadth: i64,
    selected_node_ids: String,
    created_at: String,
}

#[derive(Debug, Serialize)]
struct MemoryExtractionSources {
    post_ids: Vec<i64>,
    photo_ids: Vec<i64>,
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
        warn!("PERSONAL_SITE_PASSWORD is not set. Temporary owner password: 123456");
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
        .route(
            "/api/locations",
            get(list_locations).post(extract_locations),
        )
        .route("/api/locations/{id}", get(get_location_detail))
        .route("/api/posts/{id}/locations", get(list_post_locations).post(add_post_location))
        .route("/api/posts/{id}/locations/{location_id}", delete(remove_post_location))
        .route("/api/analyze", post(analyze))
        .route("/api/llm/test", post(test_llm_connection))
        .route("/api/embeddings/test", post(test_embedding_connection))
        .route("/api/chat", post(chat))
        .route("/api/memories", get(list_memories).post(create_memory))
        .route("/api/memories/extract", post(extract_memories))
        .route("/api/memories/recall-preview", post(preview_memory_recall))
        .route("/api/memory-recall-events", get(list_memory_recall_events))
        .route(
            "/api/memory-extractions/sources",
            get(list_memory_extraction_sources),
        )
        .route(
            "/api/memories/{id}",
            put(update_memory).delete(delete_memory),
        )
        .route(
            "/api/memory-summaries",
            get(list_memory_summaries).post(create_memory_summary),
        )
        .route(
            "/api/memory-summaries/generate",
            post(generate_memory_summary),
        )
        .route(
            "/api/memory-summaries/{id}",
            put(update_memory_summary).delete(delete_memory_summary),
        )
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
            use_memory integer not null default 1,
            created_at text not null,
            updated_at text not null
        );

        create table if not exists memories (
            id integer primary key autoincrement,
            content text not null,
            normalized_content text not null,
            topic text not null default '',
            domain text not null default '',
            status text not null default 'pending',
            relation text not null default 'new',
            related_memory_id integer,
            source_session_id integer,
            source_fingerprint text not null default '',
            supersedes_id integer,
            mention_count integer not null default 1,
            confidence real not null default 0.7,
            last_mentioned_at text not null,
            valid_from text not null,
            occurred_at text not null,
            created_at text not null,
            updated_at text not null,
            embedding text not null default '',
            embedding_model text not null default ''
        );

        create index if not exists memories_status_idx on memories(status);
        create index if not exists memories_topic_idx on memories(topic);
        create index if not exists memories_domain_idx on memories(domain);
        create unique index if not exists memories_active_normalized_idx
            on memories(normalized_content) where status = 'active';

        create table if not exists memory_extractions (
            source_fingerprint text primary key,
            post_ids text not null default '[]',
            photo_ids text not null default '[]',
            created_at text not null
        );

        create table if not exists memory_summaries (
            id integer primary key autoincrement,
            kind text not null,
            title text not null,
            content text not null,
            source_memory_ids text not null default '[]',
            status text not null default 'pending',
            version integer not null default 1,
            created_at text not null,
            updated_at text not null
        );

        create index if not exists memory_summaries_status_idx on memory_summaries(status);
        create index if not exists memory_summaries_title_idx on memory_summaries(title);

        create table if not exists schema_migrations (
            version integer primary key,
            applied_at text not null
        );

        create table if not exists memory_nodes (
            id integer primary key,
            content text not null,
            normalized_content text not null,
            kind text not null default 'fact',
            topic text not null default '',
            domain text not null default '',
            status text not null default 'pending',
            relation text not null default 'new',
            related_memory_id integer,
            source_session_id integer,
            source_fingerprint text not null default '',
            supersedes_id integer,
            mention_count integer not null default 1,
            confidence real not null default 0.7,
            importance real not null default 0.5,
            emotion_weight real not null default 0.0,
            strength real not null default 1.0,
            last_mentioned_at text not null,
            last_activated_at text not null default '',
            valid_from text not null,
            occurred_at text not null,
            occurred_until text not null default '',
            time_precision text not null default 'unknown',
            created_at text not null,
            updated_at text not null,
            embedding text not null default '',
            embedding_model text not null default ''
        );
        create index if not exists memory_nodes_status_idx on memory_nodes(status);
        create index if not exists memory_nodes_topic_idx on memory_nodes(topic);
        create index if not exists memory_nodes_domain_idx on memory_nodes(domain);
        create index if not exists memory_nodes_occurred_at_idx on memory_nodes(occurred_at);
        create unique index if not exists memory_nodes_active_normalized_idx
            on memory_nodes(normalized_content) where status = 'active' and kind != 'schema';

        create table if not exists memory_sources (
            id integer primary key autoincrement,
            source_type text not null,
            source_id integer,
            source_key text not null default '',
            excerpt text not null default '',
            fingerprint text not null default '',
            created_at text not null,
            unique(source_type, source_key, fingerprint)
        );
        create table if not exists memory_node_sources (
            memory_id integer not null,
            source_id integer not null,
            primary key(memory_id, source_id),
            foreign key(memory_id) references memory_nodes(id) on delete cascade,
            foreign key(source_id) references memory_sources(id) on delete cascade
        );
        create table if not exists memory_cues (
            id integer primary key autoincrement,
            memory_id integer not null,
            cue_type text not null,
            value text not null,
            normalized_value text not null,
            specificity real not null default 0.5,
            created_at text not null,
            unique(memory_id, cue_type, normalized_value),
            foreign key(memory_id) references memory_nodes(id) on delete cascade
        );
        create index if not exists memory_cues_value_idx on memory_cues(normalized_value);
        create table if not exists memory_edges (
            source_id integer not null,
            target_id integer not null,
            relation text not null,
            weight real not null default 0.5,
            evidence_count integer not null default 1,
            status text not null default 'active',
            created_at text not null,
            updated_at text not null,
            primary key(source_id, target_id, relation),
            foreign key(source_id) references memory_nodes(id) on delete cascade,
            foreign key(target_id) references memory_nodes(id) on delete cascade
        );
        create table if not exists memory_recall_events (
            id integer primary key autoincrement,
            query text not null,
            mode text not null,
            depth text not null,
            breadth integer not null,
            candidate_scores text not null default '{}',
            selected_node_ids text not null default '[]',
            expanded_node_ids text not null default '[]',
            created_at text not null
        );

        create table if not exists locations (
            id integer primary key autoincrement,
            name text not null,
            latitude real not null,
            longitude real not null,
            created_at text not null,
            updated_at text not null
        );

        create table if not exists post_locations (
            post_id integer not null,
            location_id integer not null,
            primary key (post_id, location_id),
            foreign key (post_id) references posts(id) on delete cascade,
            foreign key (location_id) references locations(id) on delete cascade
        );

        create index if not exists post_locations_post_id_idx on post_locations(post_id);
        create index if not exists post_locations_location_id_idx on post_locations(location_id);
        create index if not exists locations_name_idx on locations(name);
        "#,
    )?;
    let _ = conn.execute("alter table photos add column latitude real", []);
    let _ = conn.execute("alter table photos add column longitude real", []);
    let _ = conn.execute(
        "alter table chat_sessions add column use_memory integer not null default 1",
        [],
    );
    let _ = conn.execute(
        "alter table memories add column source_fingerprint text not null default ''",
        [],
    );
    let _ = conn.execute(
        "alter table memories add column occurred_at text not null default ''",
        [],
    );
    let _ = conn.execute(
        "alter table memories add column embedding text not null default ''",
        [],
    );
    let _ = conn.execute(
        "alter table memories add column embedding_model text not null default ''",
        [],
    );
    conn.execute(
        "update memories set occurred_at = created_at where occurred_at = ''",
        [],
    )?;
    conn.execute(
        "create index if not exists memories_occurred_at_idx on memories(occurred_at)",
        [],
    )?;
    conn.execute(
        "create index if not exists memories_source_fingerprint_idx on memories(source_fingerprint)",
        [],
    )?;
    conn.execute(
        "update memories set domain = case lower(trim(domain))
           when 'knowledge' then '知识' when 'personal' then '个人'
           when 'profile' then '个人画像' when 'preference' then '偏好'
           when 'preferences' then '偏好' when 'experience' then '经历'
           when 'experiences' then '经历' when 'life' then '生活'
           when 'lifestyle' then '生活' when 'work' then '工作'
           when 'career' then '工作' when 'education' then '教育'
           when 'health' then '健康' when 'family' then '家庭'
           when 'relationship' then '人际关系' when 'relationships' then '人际关系'
           when 'technology' then '技术' when 'tech' then '技术'
           when 'travel' then '旅行' when 'finance' then '财务'
           when 'emotion' then '情绪' when 'emotions' then '情绪'
           when 'hobby' then '兴趣' when 'hobbies' then '兴趣'
           when 'general' then '其他' when 'other' then '其他'
           else domain end",
        [],
    )?;
    conn.execute(
        "update memories set topic = case lower(trim(topic))
           when 'childhood' then '童年' when 'family' then '家庭'
           when 'work' then '工作' when 'career' then '职业经历'
           when 'education' then '教育经历' when 'health' then '健康'
           when 'preference' then '个人偏好' when 'preferences' then '个人偏好'
           when 'travel' then '旅行经历' when 'relationship' then '人际关系'
           when 'technology' then '技术' when 'knowledge' then '知识'
           else topic end",
        [],
    )?;
    migrate_memory_graph(&conn)?;
    Ok(())
}

fn migrate_memory_graph(conn: &Connection) -> Result<()> {
    let applied: bool = conn.query_row(
        "select exists(select 1 from schema_migrations where version = 1)",
        [],
        |row| row.get(0),
    )?;
    if !applied {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
        "insert or ignore into memory_nodes
         (id, content, normalized_content, kind, topic, domain, status, relation,
          related_memory_id, source_session_id, source_fingerprint, supersedes_id,
          mention_count, confidence, importance, emotion_weight, strength,
          last_mentioned_at, last_activated_at, valid_from, occurred_at, time_precision,
          created_at, updated_at, embedding, embedding_model)
         select id, content, normalized_content,
          case when domain = '偏好' then 'preference' when domain = '经历' then 'episode' else 'fact' end,
          topic, domain, status, relation, related_memory_id, source_session_id,
          source_fingerprint, supersedes_id, mention_count, confidence, 0.5, 0.0,
          max(1.0, mention_count * 0.2), last_mentioned_at, last_mentioned_at,
          valid_from, occurred_at,
          case when length(occurred_at) = 4 then 'year' when length(occurred_at) = 10 then 'day' else 'unknown' end,
          created_at, updated_at, embedding, embedding_model from memories;
         insert or ignore into memory_nodes
         (id, content, normalized_content, kind, topic, domain, status, relation,
          mention_count, confidence, importance, emotion_weight, strength,
          last_mentioned_at, last_activated_at, valid_from, occurred_at, time_precision,
          created_at, updated_at)
         select 1000000000 + id, content, lower(replace(title, ' ', '')), 'schema',
          case when kind = 'topic' then title else '' end,
          case when kind = 'domain' then title else '' end,
          'pending', 'new', 1, 0.8, 0.7, 0.0, 1.0,
          updated_at, updated_at, created_at, created_at, 'unknown', created_at, updated_at
          from memory_summaries;
         insert into schema_migrations(version, applied_at) values(1, datetime('now'));"
      )?;
        tx.commit()?;
    }
    let sources_applied: bool = conn.query_row(
        "select exists(select 1 from schema_migrations where version = 2)",
        [],
        |row| row.get(0),
    )?;
    if !sources_applied {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "insert or ignore into memory_sources(source_type, source_id, source_key, excerpt, fingerprint, created_at)
             select case when source_session_id is null then 'legacy' else 'chat' end,
                    source_session_id, 'legacy:' || id, content, source_fingerprint, created_at
             from memory_nodes where id < 1000000000;
             insert or ignore into memory_node_sources(memory_id, source_id)
             select n.id, s.id from memory_nodes n join memory_sources s on s.source_key = 'legacy:' || n.id
             where n.id < 1000000000;
             insert or ignore into memory_edges(source_id, target_id, relation, weight, evidence_count, status, created_at, updated_at)
             select 1000000000 + ms.id, cast(j.value as integer), 'summarizes', 0.9, 1, 'active', ms.created_at, ms.updated_at
             from memory_summaries ms, json_each(ms.source_memory_ids) j
             where exists(select 1 from memory_nodes n where n.id = cast(j.value as integer));
             insert into schema_migrations(version, applied_at) values(2, datetime('now'));"
        )?;
        tx.commit()?;
    }
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
    if input.model.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请填写模型名"));
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
        .unwrap_or(if is_anthropic {
            "https://api.anthropic.com"
        } else {
            "https://api.openai.com"
        })
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
        let value: Value =
            serde_json::from_str(&body_text).unwrap_or_else(|_| json!({ "message": body_text }));
        if !status.is_success() {
            let msg = format!("LLM 返回错误：{}", extract_llm_error(&value));
            warn!("{msg} (HTTP {status}, 原始响应: {body_text})");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, msg));
        }
        answer = extract_llm_text(&value);
    } else {
        let endpoint = openai_chat_endpoint(base_url);
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
        let value: Value =
            serde_json::from_str(&body_text).unwrap_or_else(|_| json!({ "message": body_text }));
        if !status.is_success() {
            let msg = format!("LLM 返回错误：{}", extract_llm_error(&value));
            warn!("{msg} (HTTP {status}, 原始响应: {body_text})");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, msg));
        }
        answer = extract_llm_text(&value);
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

async fn extract_locations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ExtractLocationsRequest>,
) -> ApiResult<Json<Vec<LocationItem>>> {
    require_owner(&state, &headers)?;
    if input.amap_key.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请填写高德 Key"));
    }
    if input.model.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请填写模型名"));
    }
    if input.api_key.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请填写 LLM API Key"));
    }

    let conn = Connection::open(&state.db_path)?;
    let post = load_post(&conn, input.post_id)?;
    let prompt = input
        .prompt
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_LOCATION_PROMPT);
    let free_text = format!("标题：{}\n正文：\n{}", post.title, post.body);

    let answer = call_text_llm(
        &state,
        &input.api_key,
        input.base_url.as_deref().filter(|s| !s.trim().is_empty()),
        &input.model,
        input.provider.as_deref(),
        "你是地理信息提取助手。",
        &format!("{}\n\n{}", prompt, free_text),
        2048,
    )
    .await?;

    let names = parse_location_names(&answer)?;
    if names.is_empty() {
        return Ok(Json(vec![]));
    }

    let now = Utc::now().to_rfc3339();
    let mut locations = Vec::new();
    for name in names {
        let normalized = normalize_location_name(&name);
        if normalized.is_empty() {
            continue;
        }

        // 检查是否已有同名地点
        let existing: Option<i64> = conn
            .query_row(
                "select id from locations where lower(trim(name)) = lower(trim(?1)) limit 1",
                params![normalized],
                |row| row.get(0),
            )
            .optional()?;

        let location_id = if let Some(id) = existing {
            id
        } else {
            let (lat, lng) = amap_geocode(&state, &input.amap_key, &normalized).await?;
            conn.execute(
                "insert into locations (name, latitude, longitude, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5)",
                params![normalized, lat, lng, &now, &now],
            )?;
            conn.last_insert_rowid()
        };

        let _ = conn.execute(
            "insert or ignore into post_locations (post_id, location_id) values (?1, ?2)",
            params![post.id, location_id],
        );

        locations.push(load_location(&conn, location_id)?);
    }

    Ok(Json(locations))
}

async fn list_locations(
    State(state): State<AppState>,
    _headers: HeaderMap,
) -> ApiResult<Json<Vec<LocationItem>>> {
    let conn = Connection::open(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select id, name, latitude, longitude, created_at, updated_at from locations order by updated_at desc",
    )?;
    let rows = stmt
        .query_map([], location_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

async fn list_post_locations(
    State(state): State<AppState>,
    _headers: HeaderMap,
    AxumPath(post_id): AxumPath<i64>,
) -> ApiResult<Json<Vec<LocationItem>>> {
    let conn = Connection::open(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select l.id, l.name, l.latitude, l.longitude, l.created_at, l.updated_at from locations l join post_locations pl on l.id = pl.location_id where pl.post_id = ?1 order by l.updated_at desc",
    )?;
    let rows = stmt
        .query_map(params![post_id], location_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(rows))
}

async fn add_post_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(post_id): AxumPath<i64>,
    Json(input): Json<AddLocationRequest>,
) -> ApiResult<Json<LocationItem>> {
    require_owner(&state, &headers)?;
    let normalized = normalize_location_name(&input.name);
    if normalized.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "地点名称不能为空"));
    }

    let conn = Connection::open(&state.db_path)?;
    let _ = load_post(&conn, post_id)?;
    let now = Utc::now().to_rfc3339();

    let existing: Option<i64> = conn
        .query_row(
            "select id from locations where lower(trim(name)) = lower(trim(?1)) limit 1",
            params![normalized],
            |row| row.get(0),
        )
        .optional()?;

    let location_id = if let Some(id) = existing {
        id
    } else {
        conn.execute(
            "insert into locations (name, latitude, longitude, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5)",
            params![normalized, 0.0, 0.0, &now, &now],
        )?;
        conn.last_insert_rowid()
    };

    conn.execute(
        "insert or ignore into post_locations (post_id, location_id) values (?1, ?2)",
        params![post_id, location_id],
    )?;

    Ok(Json(load_location(&conn, location_id)?))
}

async fn remove_post_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((post_id, location_id)): AxumPath<(i64, i64)>,
) -> ApiResult<StatusCode> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "delete from post_locations where post_id = ?1 and location_id = ?2",
        params![post_id, location_id],
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_location_detail(
    State(state): State<AppState>,
    _headers: HeaderMap,
    AxumPath(location_id): AxumPath<i64>,
) -> ApiResult<Json<LocationDetail>> {
    let conn = Connection::open(&state.db_path)?;
    let location = load_location(&conn, location_id)?;

    let mut stmt = conn.prepare(
        "select p.id, p.title, p.body, p.kind, p.status, p.category, p.tags, p.created_at, p.updated_at from posts p join post_locations pl on p.id = pl.post_id where pl.location_id = ?1 order by p.updated_at desc",
    )?;
    let posts = stmt
        .query_map(params![location_id], post_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    // 把地点 GCJ-02 转 WGS-84 后计算附近照片
    let (wgs_lat, wgs_lng) = gcj02_to_wgs84(location.latitude, location.longitude);
    let mut stmt = conn.prepare(
        "select id, title, description, category, tags, filename, original_name, mime, latitude, longitude, created_at, updated_at from photos where latitude is not null and longitude is not null",
    )?;
    let all_photos = stmt
        .query_map([], photo_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let photos: Vec<PhotoItem> = all_photos
        .into_iter()
        .filter(|p| {
            let dist =
                haversine_distance(wgs_lat, wgs_lng, p.latitude.unwrap(), p.longitude.unwrap());
            dist < 1.0 // 1km
        })
        .collect();

    Ok(Json(LocationDetail {
        location,
        posts,
        photos,
    }))
}

async fn amap_geocode(state: &AppState, key: &str, address: &str) -> ApiResult<(f64, f64)> {
    let resp = state
        .http
        .get("https://restapi.amap.com/v3/geocode/geo")
        .query(&[("key", key), ("address", address), ("output", "JSON")])
        .header("User-Agent", "Hello.me/1.0")
        .send()
        .await
        .map_err(|err| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("高德地理编码请求失败：{}", err),
            )
        })?;
    let status = resp.status();
    let value: Value = resp.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("高德地理编码返回错误：{}", value),
        ));
    }
    if value.get("status").and_then(Value::as_str) != Some("1") {
        let info = value
            .get("info")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("高德地理编码失败：{}", info),
        ));
    }
    let geocodes = value
        .get("geocodes")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "高德地理编码结果为空"))?;
    let first = geocodes
        .first()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "高德地理编码结果为空"))?;
    let location = first
        .get("location")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "高德地理编码缺少坐标"))?;
    let parts: Vec<&str> = location.split(',').collect();
    if parts.len() != 2 {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "高德地理编码坐标格式错误",
        ));
    }
    let lng: f64 = parts[0]
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "高德经度解析失败"))?;
    let lat: f64 = parts[1]
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_GATEWAY, "高德纬度解析失败"))?;
    Ok((lat, lng))
}

fn parse_location_names(answer: &str) -> ApiResult<Vec<String>> {
    let text = answer
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let value: Value = serde_json::from_str(text)
        .or_else(|_| {
            // 尝试从文本中提取 JSON 数组
            let start = text.find('[').unwrap_or(0);
            let end = text.rfind(']').map(|i| i + 1).unwrap_or(text.len());
            serde_json::from_str(&text[start..end])
        })
        .map_err(|err| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("地点 JSON 解析失败：{}", err),
            )
        })?;
    let names = value
        .as_array()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "地点结果不是数组"))?
        .iter()
        .filter_map(|item| {
            if let Some(name) = item.get("name").and_then(Value::as_str) {
                return Some(name.trim().to_string());
            }
            if let Some(name) = item.as_str() {
                return Some(name.trim().to_string());
            }
            None
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    Ok(names)
}

fn normalize_location_name(name: &str) -> String {
    name.trim().replace('\n', " ").replace('\t', " ")
}

fn haversine_distance(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    const R: f64 = 6371.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlng = (lng2 - lng1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlng / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());
    R * c
}

// WGS-84 <-> GCJ-02 坐标转换
const PI: f64 = std::f64::consts::PI;
const A: f64 = 6378245.0;
const EE: f64 = 0.00669342162296594323;

fn gcj02_to_wgs84(lat: f64, lng: f64) -> (f64, f64) {
    if out_of_china(lat, lng) {
        return (lat, lng);
    }
    let (dlat, dlng) = delta(lat, lng);
    (lat - dlat, lng - dlng)
}

fn delta(lat: f64, lng: f64) -> (f64, f64) {
    let dlat = transform_lat(lng - 105.0, lat - 35.0);
    let dlng = transform_lng(lng - 105.0, lat - 35.0);
    let radlat = lat / 180.0 * PI;
    let magic = 1.0 - EE * radlat.sin().powi(2);
    let sqrtmagic = magic.sqrt();
    let dlat = dlat * 180.0 / ((A * (1.0 - EE)) / (magic * sqrtmagic) * PI);
    let dlng = dlng * 180.0 / (A / sqrtmagic * radlat.cos() * PI);
    (dlat, dlng)
}

fn transform_lat(x: f64, y: f64) -> f64 {
    let mut ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * x.abs().sqrt();
    ret += (20.0 * (6.0 * x * PI).sin() + 20.0 * (2.0 * x * PI).sin()) * 2.0 / 3.0;
    ret += (20.0 * (y * PI).sin() + 40.0 * (y / 3.0 * PI).sin()) * 2.0 / 3.0;
    ret += (160.0 * (y / 12.0 * PI).sin() + 320.0 * (y * PI / 30.0).sin()) * 2.0 / 3.0;
    ret
}

fn transform_lng(x: f64, y: f64) -> f64 {
    let mut ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * y.abs().sqrt();
    ret += (20.0 * (6.0 * x * PI).sin() + 20.0 * (2.0 * x * PI).sin()) * 2.0 / 3.0;
    ret += (20.0 * (x * PI).sin() + 40.0 * (x / 3.0 * PI).sin()) * 2.0 / 3.0;
    ret += (150.0 * (x / 12.0 * PI).sin() + 300.0 * (x / 30.0 * PI).sin()) * 2.0 / 3.0;
    ret
}

fn out_of_china(lat: f64, lng: f64) -> bool {
    lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

async fn test_llm_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LlmTestRequest>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &headers)?;
    let started = std::time::Instant::now();
    let answer = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        call_text_llm(
            &state,
            &input.api_key,
            input.base_url.as_deref(),
            &input.model,
            input.provider.as_deref(),
            "你是连通性测试助手。",
            "只回复 OK，不要添加其他内容。",
            256,
        ),
    )
    .await
    .map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "LLM 连接测试超时（20 秒）"))??;
    let elapsed_ms = started.elapsed().as_millis();
    if answer.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "LLM 已响应，但没有返回可读内容",
        ));
    }
    Ok(Json(json!({
        "ok": true,
        "model": input.model.trim(),
        "answer": answer.trim(),
        "elapsed_ms": elapsed_ms,
    })))
}

async fn test_embedding_connection(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<EmbeddingTestRequest>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &headers)?;
    if input.model.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "请填写 Embedding 模型名",
        ));
    }
    let started = std::time::Instant::now();
    let vectors = request_embeddings(
        &state,
        &input.api_key,
        input.base_url.as_deref(),
        input.provider.as_deref(),
        &input.model,
        &["Hello.me 语义记忆测试".to_string()],
    )
    .await?;
    let dimensions = vectors.first().map(Vec::len).unwrap_or_default();
    if dimensions == 0 {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Embedding 服务已响应，但没有返回向量",
        ));
    }
    Ok(Json(json!({
        "ok": true,
        "model": input.model.trim(),
        "dimensions": dimensions,
        "elapsed_ms": started.elapsed().as_millis(),
    })))
}

async fn chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ChatRequest>,
) -> ApiResult<Response> {
    require_owner(&state, &headers)?;
    if input.model.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请填写模型名"));
    }
    if input.messages.is_empty()
        || input
            .messages
            .last()
            .is_none_or(|message| message.content.trim().is_empty())
    {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请输入要发送的内容"));
    }

    let query_text = input
        .messages
        .last()
        .map(|message| message.content.as_str())
        .unwrap_or("");
    let llm_plan = if input.use_memory.unwrap_or(true) && should_use_llm_retrieval_plan(query_text)
    {
        plan_memory_retrieval(&state, &input, query_text).await.ok()
    } else {
        None
    };
    let query_embedding = if input.use_memory.unwrap_or(true) {
        if let Some(embedding_model) = input
            .embedding_model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
        {
            match ensure_memory_embeddings(
                &state,
                input.embedding_api_key.as_deref().unwrap_or(&input.api_key),
                input
                    .embedding_base_url
                    .as_deref()
                    .or(input.base_url.as_deref()),
                input
                    .embedding_provider
                    .as_deref()
                    .or(input.provider.as_deref()),
                embedding_model,
                query_text,
            )
            .await
            {
                Ok(vector) => Some(vector),
                Err(error) => {
                    warn!(error = %error.message, "semantic memory recall unavailable; using lexical recall");
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    let conn = Connection::open(&state.db_path)?;
    let mut recall = if input.use_memory.unwrap_or(true) {
        recall_memories(
            &conn,
            query_text,
            input.memory_budget_tokens.unwrap_or(800).clamp(400, 4000),
            query_embedding.as_deref(),
            input.embedding_model.as_deref(),
            llm_plan.as_ref(),
        )?
    } else {
        MemoryRecall {
            text: String::new(),
            meta: MemoryRecallMeta::default(),
        }
    };
    recall.meta.planned = llm_plan.is_some();
    let mut context_text = String::new();
    if !recall.text.is_empty() {
        context_text.push_str("\n[长期记忆]\n");
        context_text.push_str("以下日期是记忆中事实或经历的发生时间，不是本次对话时间。请结合先后顺序、变化和最近状态作答，不要把旧状态误当成当前状态。\n");
        context_text.push_str(&recall.text);
        context_text.push('\n');
    }
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
        .unwrap_or(if is_anthropic {
            "https://api.anthropic.com"
        } else {
            "https://api.openai.com"
        })
        .trim()
        .trim_end_matches('/');

    let stream = input.stream.unwrap_or(false);

    if is_anthropic {
        let endpoint = llm_endpoint(base_url, "/v1/messages");
        let system_text = "你是个人知识库里的对话助手。优先基于用户当前对话和选中的资料回答。长期记忆可能过时；如与当前对话冲突，以当前对话为准，并明确指出不确定性。";

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

        let resp = req.send().await.map_err(|err| {
            ApiError::new(StatusCode::BAD_GATEWAY, format!("LLM 请求失败：{err}"))
        })?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let value: Value =
                serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }));
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("LLM 返回错误：{}", extract_llm_error(&value)),
            ));
        }

        if stream {
            let (tx, rx): (mpsc::Sender<Result<Event, std::convert::Infallible>>, _) =
                mpsc::channel(32);
            let sse_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
            let memory_meta = serde_json::to_string(&json!({ "memory": recall.meta }))
                .unwrap_or_else(|_| "{}".to_string());

            tokio::spawn(async move {
                let _ = tx.send(Ok(Event::default().data(memory_meta))).await;
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
                                                let payload =
                                                    json!({ "delta": { "text": content } })
                                                        .to_string();
                                                let _ = tx
                                                    .send(Ok(Event::default().data(payload)))
                                                    .await;
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
            let answer = extract_llm_text(&value);
            Ok(Json(json!({ "answer": answer })).into_response())
        }
    } else {
        let endpoint = openai_chat_endpoint(base_url);

        let mut messages = vec![json!({
            "role": "system",
            "content": "你是个人知识库里的对话助手。优先基于用户当前对话和选中的资料回答。长期记忆可能过时；如与当前对话冲突，以当前对话为准，并明确指出不确定性。"
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
            let value: Value =
                serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }));
            let msg = format!("LLM 返回错误：{}", extract_llm_error(&value));
            warn!("{msg} (HTTP {status}, 原始响应: {text})");
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, msg));
        }

        if stream {
            let (tx, rx): (mpsc::Sender<Result<Event, std::convert::Infallible>>, _) =
                mpsc::channel(32);
            let sse_stream = tokio_stream::wrappers::ReceiverStream::new(rx);
            let memory_meta = serde_json::to_string(&json!({ "memory": recall.meta }))
                .unwrap_or_else(|_| "{}".to_string());

            tokio::spawn(async move {
                let _ = tx.send(Ok(Event::default().data(memory_meta))).await;
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
                                        if let Some(content) =
                                            json["choices"][0]["delta"]["content"].as_str()
                                        {
                                            if !content.is_empty() {
                                                let payload = json!({ "choices": [{ "delta": { "content": content } }] }).to_string();
                                                let _ = tx
                                                    .send(Ok(Event::default().data(payload)))
                                                    .await;
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
            let answer = extract_llm_text(&value);
            let usage = value.get("usage").cloned().unwrap_or(Value::Null);
            Ok(
                Json(json!({ "answer": answer, "usage": usage, "memory": recall.meta }))
                    .into_response(),
            )
        }
    }
}

async fn list_memories(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<MemoryItem>>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select id, content, normalized_content, topic, domain, status, relation,
                related_memory_id, source_session_id, supersedes_id, mention_count,
                confidence, last_mentioned_at, valid_from, occurred_at, created_at, updated_at,
                kind, time_precision, importance, emotion_weight, strength, last_activated_at
         from memory_nodes order by
           case status when 'pending' then 0 when 'active' then 1 when 'disabled' then 2 else 3 end,
           occurred_at desc, updated_at desc",
    )?;
    let mut items = stmt
        .query_map([], memory_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    hydrate_memory_items(&conn, &mut items)?;
    Ok(Json(items))
}

async fn preview_memory_recall(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<MemoryRecallPreviewRequest>,
) -> ApiResult<Json<Value>> {
    require_owner(&state, &headers)?;
    let query = required_trimmed(Some(&input.query), "请输入召回问题")?;
    let conn = Connection::open(&state.db_path)?;
    let plan = local_retrieval_plan(query);
    let recall = recall_memories(
        &conn,
        query,
        input.budget_tokens.unwrap_or(800).clamp(200, 4000),
        None,
        None,
        Some(&plan),
    )?;
    let nodes = recall
        .meta
        .selected_node_ids
        .iter()
        .filter_map(|id| load_memory(&conn, *id).ok())
        .collect::<Vec<_>>();
    Ok(Json(
        json!({ "plan": plan, "packet": recall.text, "meta": recall.meta, "nodes": nodes }),
    ))
}

async fn list_memory_recall_events(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<MemoryRecallEventItem>>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select id, query, mode, depth, breadth, selected_node_ids, created_at
         from memory_recall_events order by id desc limit 100",
    )?;
    let items = stmt
        .query_map([], |row| {
            Ok(MemoryRecallEventItem {
                id: row.get(0)?,
                query: row.get(1)?,
                mode: row.get(2)?,
                depth: row.get(3)?,
                breadth: row.get(4)?,
                selected_node_ids: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(items))
}

async fn create_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<MemoryInput>,
) -> ApiResult<Json<MemoryItem>> {
    require_owner(&state, &headers)?;
    let content = required_trimmed(input.content.as_deref(), "记忆内容不能为空")?;
    let status = input.status.as_deref().unwrap_or("pending");
    validate_memory_status(status)?;
    let now = Utc::now().to_rfc3339();
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "insert into memory_nodes
         (content, normalized_content, kind, topic, domain, status, relation, related_memory_id,
          source_session_id, mention_count, confidence, importance, emotion_weight, strength,
          last_mentioned_at, last_activated_at, valid_from, occurred_at, time_precision, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, 1.0, ?13, ?13, ?13, ?14, ?15, ?13, ?13)",
        params![
            content,
            normalize_memory_content(&content),
            input.kind.as_deref().unwrap_or("fact"),
            input.topic.as_deref().unwrap_or("").trim(),
            input.domain.as_deref().unwrap_or("").trim(),
            status,
            input.relation.as_deref().unwrap_or("new"),
            input.related_memory_id,
            input.source_session_id,
            input.confidence.unwrap_or(1.0).clamp(0.0, 1.0),
            input.importance.unwrap_or(0.5).clamp(0.0, 1.0),
            input.emotion_weight.unwrap_or(0.0).clamp(0.0, 1.0),
            now,
            input
                .occurred_at
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&now),
            input.time_precision.as_deref().unwrap_or("unknown"),
        ],
    )?;
    let id = conn.last_insert_rowid();
    replace_memory_cues(&conn, id, input.cues.as_deref().unwrap_or(&[]))?;
    attach_manual_source(&conn, id, content)?;
    if status == "active" {
        mark_summaries_stale(&conn, id)?;
    }
    Ok(Json(load_memory(&conn, id)?))
}

async fn update_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    Json(input): Json<MemoryInput>,
) -> ApiResult<Json<MemoryItem>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    let current = load_memory(&conn, id)?;
    let content = input
        .content
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&current.content)
        .to_string();
    let status = input.status.as_deref().unwrap_or(&current.status);
    let relation = input.relation.as_deref().unwrap_or(&current.relation);
    validate_memory_status(status)?;
    let now = Utc::now().to_rfc3339();

    if current.status == "pending" && status == "active" {
        match relation {
            "duplicate" => {
                conn.execute("delete from memory_nodes where id = ?1", params![id])?;
                return Err(ApiError::new(StatusCode::CONFLICT, "重复候选已忽略"));
            }
            "reinforce" => {
                if let Some(target_id) = current.related_memory_id {
                    conn.execute(
                        "update memory_nodes set mention_count = mention_count + 1,
                         strength = min(10.0, strength + 0.25), last_mentioned_at = ?1,
                         updated_at = ?1 where id = ?2 and status = 'active'",
                        params![now, target_id],
                    )?;
                    conn.execute(
                        "insert or ignore into memory_node_sources(memory_id, source_id)
                         select ?1, source_id from memory_node_sources where memory_id=?2",
                        params![target_id, id],
                    )?;
                    conn.execute(
                        "insert or ignore into memory_cues(memory_id, cue_type, value, normalized_value, specificity, created_at)
                         select ?1, cue_type, value, normalized_value, specificity, created_at from memory_cues where memory_id=?2",
                        params![target_id, id],
                    )?;
                    conn.execute("delete from memory_cues where memory_id=?1", params![id])?;
                    conn.execute(
                        "delete from memory_node_sources where memory_id=?1",
                        params![id],
                    )?;
                    conn.execute("delete from memory_nodes where id = ?1", params![id])?;
                    return Ok(Json(load_memory(&conn, target_id)?));
                }
            }
            "update" => {
                if let Some(target_id) = current.related_memory_id {
                    conn.execute(
                        "update memory_nodes set status = 'superseded', updated_at = ?1 where id = ?2",
                        params![now, target_id],
                    )?;
                    conn.execute(
                        "update memory_nodes set supersedes_id = ?1 where id = ?2",
                        params![target_id, id],
                    )?;
                    upsert_memory_edge(&conn, id, target_id, "updates", 1.0)?;
                    mark_summaries_stale(&conn, target_id)?;
                }
            }
            _ => {}
        }
    }

    conn.execute(
        "update memory_nodes set content = ?1, normalized_content = ?2, topic = ?3, domain = ?4,
         status = ?5, relation = ?6, related_memory_id = ?7, confidence = ?8,
         valid_from = case when status = 'pending' and ?5 = 'active' then ?9 else valid_from end,
         occurred_at = ?10, kind = ?11, time_precision = ?12, importance = ?13, emotion_weight = ?14,
         embedding = case when normalized_content != ?2 or topic != ?3 or domain != ?4 then '' else embedding end,
         embedding_model = case when normalized_content != ?2 or topic != ?3 or domain != ?4 then '' else embedding_model end,
         updated_at = ?9 where id = ?15",
        params![
            content,
            normalize_memory_content(&content),
            input.topic.as_deref().unwrap_or(&current.topic).trim(),
            input.domain.as_deref().unwrap_or(&current.domain).trim(),
            status,
            relation,
            input.related_memory_id.or(current.related_memory_id),
            input
                .confidence
                .unwrap_or(current.confidence)
                .clamp(0.0, 1.0),
            now,
            input
                .occurred_at
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&current.occurred_at),
            input.kind.as_deref().unwrap_or(&current.kind),
            input.time_precision.as_deref().unwrap_or(&current.time_precision),
            input.importance.unwrap_or(current.importance).clamp(0.0, 1.0),
            input.emotion_weight.unwrap_or(current.emotion_weight).clamp(0.0, 1.0),
            id,
        ],
    )?;
    if let Some(cues) = input.cues.as_deref() {
        replace_memory_cues(&conn, id, cues)?;
    }
    if current.status != status || current.content != content {
        mark_summaries_stale(&conn, id)?;
    }
    Ok(Json(load_memory(&conn, id)?))
}

async fn delete_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<StatusCode> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    mark_summaries_stale(&conn, id)?;
    conn.execute("delete from memory_cues where memory_id=?1", params![id])?;
    conn.execute(
        "delete from memory_node_sources where memory_id=?1",
        params![id],
    )?;
    conn.execute(
        "delete from memory_edges where source_id=?1 or target_id=?1",
        params![id],
    )?;
    conn.execute("delete from memory_nodes where id = ?1", params![id])?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_memory_extraction_sources(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<MemoryExtractionSources>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    Ok(Json(load_memory_extraction_sources(&conn)?))
}

fn load_memory_extraction_sources(conn: &Connection) -> ApiResult<MemoryExtractionSources> {
    let mut post_ids = HashSet::new();
    let mut photo_ids = HashSet::new();
    let mut stmt = conn.prepare("select post_ids, photo_ids from memory_extractions")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (posts, photos) = row?;
        post_ids.extend(serde_json::from_str::<Vec<i64>>(&posts).unwrap_or_default());
        photo_ids.extend(serde_json::from_str::<Vec<i64>>(&photos).unwrap_or_default());
    }
    let mut post_ids = post_ids.into_iter().collect::<Vec<_>>();
    let mut photo_ids = photo_ids.into_iter().collect::<Vec<_>>();
    post_ids.sort_unstable();
    photo_ids.sort_unstable();
    Ok(MemoryExtractionSources {
        post_ids,
        photo_ids,
    })
}

fn record_memory_extraction(
    conn: &Connection,
    source_fingerprint: &str,
    post_ids: &[i64],
    photo_ids: &[i64],
    created_at: &str,
) -> ApiResult<()> {
    conn.execute(
        "insert into memory_extractions (source_fingerprint, post_ids, photo_ids, created_at)
         values (?1, ?2, ?3, ?4)
         on conflict(source_fingerprint) do update set
           post_ids = excluded.post_ids, photo_ids = excluded.photo_ids",
        params![
            source_fingerprint,
            serde_json::to_string(post_ids).unwrap_or_else(|_| "[]".to_string()),
            serde_json::to_string(photo_ids).unwrap_or_else(|_| "[]".to_string()),
            created_at,
        ],
    )?;
    Ok(())
}

async fn extract_memories(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<MemoryExtractRequest>,
) -> ApiResult<Json<Vec<MemoryItem>>> {
    require_owner(&state, &headers)?;
    let has_free_text = input
        .free_text
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    if input.messages.is_empty()
        && input.post_ids.is_empty()
        && input.photo_ids.is_empty()
        && !has_free_text
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "没有可提取的问答或附件",
        ));
    }
    let conn = Connection::open(&state.db_path)?;
    let active = load_active_memory_catalog(&conn)?;
    let transcript = input
        .messages
        .iter()
        .filter(|message| !message.content.trim().is_empty())
        .map(|message| format!("{}: {}", message.role, message.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let mut attachment_parts = Vec::new();
    let mut source_dates = Vec::new();
    let mut post_dates = HashMap::new();
    if let Some(free_text) = input.free_text.as_deref() {
        if !free_text.trim().is_empty() {
            attachment_parts.push(format!("[指定片段]\n{}", free_text.trim()));
        }
    }
    for id in &input.post_ids {
        let post = load_post(&conn, *id)?;
        source_dates.push(post.updated_at.clone());
        post_dates.insert(post.id, post.updated_at.clone());
        attachment_parts.push(format!(
            "[{} #{}：{} / {} / 内容时间：{}]\n{}",
            kind_name_rust(&post.kind),
            post.id,
            post.title,
            post.category,
            post.updated_at,
            post.body
        ));
    }
    for id in &input.photo_ids {
        let photo = load_photo(&conn, *id)?;
        source_dates.push(photo.created_at.clone());
        attachment_parts.push(format!(
            "[照片：{} / 拍摄或收录时间：{}]\n说明：{}\n分类：{}\n标签：{}",
            if photo.title.trim().is_empty() {
                &photo.original_name
            } else {
                &photo.title
            },
            photo.created_at,
            photo.description,
            photo.category,
            photo.tags
        ));
    }
    let attachments = truncate_chars(&attachment_parts.join("\n\n"), 30_000);
    let source_fingerprint = memory_source_fingerprint(&transcript, &attachments);
    let extraction_time = Utc::now().to_rfc3339();
    let already_extracted: bool = conn.query_row(
        "select exists(
            select 1 from memory_nodes
            where source_fingerprint = ?1
              and status in ('pending', 'active', 'disabled', 'superseded')
         )",
        params![source_fingerprint],
        |row| row.get(0),
    )?;
    if already_extracted {
        record_memory_extraction(
            &conn,
            &source_fingerprint,
            &input.post_ids,
            &input.photo_ids,
            &extraction_time,
        )?;
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "这批问答或附件已经提取过记忆，请到记忆页审核或删除后再试",
        ));
    }
    let prompt = format!(
        "从下面选中的问答和附件资料中提取值得长期保存的稳定事实、偏好、经历或知识内容。\
         附件中的第一人称经历可以作为用户经历；普通资料内容应按其实际主题记录，不要擅自改写成用户偏好。\
         不要提取临时任务、猜测或助手自己的话。\n\
         每条记忆必须尽量填写 occurred_at，表示事实、经历或资料内容发生的时间。\
         优先识别正文中的明确日期、年份、年龄和“小时候”“上大学时”等相对时间；\
         可结合现有记忆中的出生年份、年龄、求学阶段等信息推断，但不要在依据不足时编造精确日期。\
         正文没有事件时间时，才使用对应文章或照片标注的内容时间；绝对不要使用本次提取时间。\
         只能确定年份时使用该年 01-01；完全无法判断时 occurred_at 填 null，交给用户审核。\
         kind 只能为 episode、fact、preference、person、place、life_stage；\
         time_precision 只能为 exact、day、month、year、period、unknown。\
         importance 和 emotion_weight 是 0 到 1。cues 是编码线索数组，\
         cue_type 使用 person、place、time、sensory、emotion、body、goal、topic、entity，\
         specificity 是线索独特性（0 到 1）。只提取原文有依据的线索。\
         topic 表示标签名，domain 表示分类名，两者都必须使用简洁自然的中文。\
         分类尽量复用知识、个人、偏好、经历、生活、工作、教育、健康、家庭、人际关系、技术、旅行、财务、情绪、兴趣、其他等稳定中文分类；\
         不要输出 knowledge、personal、preference 等英文分类或英文标签。\
         来自文章时同时填写 source_post_id；若内容综合自多篇文章，选择最直接支持该记忆的一篇。\
         对照现有记忆判断 relation，只能为 new、duplicate、reinforce、update、conflict。\n\
         related_memory_id 仅在关联已有记忆时填写。返回 JSON 数组，不要 Markdown：\n\
         [{{\"content\":\"...\",\"kind\":\"episode\",\"topic\":\"家乡记忆\",\"domain\":\"经历\",\"relation\":\"new\",\"related_memory_id\":null,\"confidence\":0.8,\"importance\":0.7,\"emotion_weight\":0.6,\"occurred_at\":\"2024-10-01T12:00:00Z\",\"time_precision\":\"exact\",\"cues\":[{{\"cue_type\":\"place\",\"value\":\"西湖\",\"specificity\":0.8}}],\"source_post_id\":12}}]\n\
         现有记忆：\n{}\n\n选中问答：\n{}\n\n附件资料：\n{}",
        active,
        if transcript.is_empty() { "无" } else { &transcript },
        if attachments.is_empty() { "无" } else { &attachments }
    );
    let raw = call_text_llm(
        &state,
        &input.api_key,
        input.base_url.as_deref(),
        &input.model,
        input.provider.as_deref(),
        "你是谨慎的长期记忆整理器。只输出合法 JSON。",
        &prompt,
        2200,
    )
    .await?;
    let candidates = parse_extracted_memories(&raw)?;
    record_memory_extraction(
        &conn,
        &source_fingerprint,
        &input.post_ids,
        &input.photo_ids,
        &extraction_time,
    )?;
    let now = extraction_time;
    let fallback_occurred_at = if source_dates.len() == 1 {
        source_dates.first().cloned()
    } else {
        None
    };
    let mut created = Vec::new();
    for candidate in candidates {
        let content = candidate.content.trim();
        if content.is_empty() {
            continue;
        }
        let normalized = normalize_memory_content(content);
        if normalized.is_empty() {
            continue;
        }
        let exact_existing: Option<(i64, String)> = conn
            .query_row(
                "select id, status from memory_nodes
                 where normalized_content = ?1 and status in ('pending', 'active')
                 order by case status when 'active' then 0 else 1 end limit 1",
                params![normalized],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if exact_existing
            .as_ref()
            .is_some_and(|(_, status)| status == "pending")
        {
            continue;
        }
        let exact_active_id = exact_existing
            .as_ref()
            .filter(|(_, status)| status == "active")
            .map(|(id, _)| *id);
        let occurred_at =
            extracted_memory_occurred_at(&candidate, &post_dates, fallback_occurred_at.as_deref());
        let relation = if exact_active_id.is_some() {
            "reinforce".to_string()
        } else if matches!(
            candidate.relation.as_str(),
            "new" | "duplicate" | "reinforce" | "update" | "conflict"
        ) {
            candidate.relation
        } else {
            "new".to_string()
        };
        let related_memory_id = exact_active_id.or(candidate.related_memory_id);
        conn.execute(
            "insert into memory_nodes
             (content, normalized_content, kind, topic, domain, status, relation, related_memory_id,
              source_session_id, source_fingerprint, mention_count, confidence, importance, emotion_weight,
              strength, last_mentioned_at, last_activated_at, valid_from, occurred_at, time_precision, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12,
                     1.0, ?13, ?13, ?13, ?14, ?15, ?13, ?13)",
            params![
                content,
                normalized,
                validate_memory_kind_or_default(&candidate.kind),
                localize_memory_label(candidate.topic.trim()),
                localize_memory_label(candidate.domain.trim()),
                relation,
                related_memory_id,
                input.session_id,
                source_fingerprint,
                candidate.confidence.clamp(0.0, 1.0),
                candidate.importance.clamp(0.0, 1.0),
                candidate.emotion_weight.clamp(0.0, 1.0),
                now,
                occurred_at,
                validate_time_precision_or_default(&candidate.time_precision),
            ],
        )?;
        let memory_id = conn.last_insert_rowid();
        replace_memory_cues(&conn, memory_id, &candidate.cues)?;
        attach_extraction_sources(&conn, memory_id, &input, content, &source_fingerprint)?;
        if let Some(related_id) = related_memory_id {
            let edge_relation = match relation.as_str() {
                "conflict" => "conflicts",
                "update" => "updates",
                "reinforce" => "reinforces",
                _ => "related",
            };
            upsert_memory_edge(&conn, memory_id, related_id, edge_relation, 0.8)?;
        }
        created.push(load_memory(&conn, memory_id)?);
    }
    let created_ids = created.iter().map(|item| item.id).collect::<Vec<_>>();
    for (index, left) in created_ids.iter().enumerate() {
        for right in created_ids.iter().skip(index + 1).take(12) {
            upsert_memory_edge(&conn, *left, *right, "co_occurs", 0.45)?;
            upsert_memory_edge(&conn, *right, *left, "co_occurs", 0.45)?;
        }
    }
    created = created_ids
        .into_iter()
        .filter_map(|id| load_memory(&conn, id).ok())
        .collect();
    Ok(Json(created))
}

async fn list_memory_summaries(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<MemorySummaryItem>>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    let mut stmt = conn.prepare(
        "select id, kind, title, content, source_memory_ids, status, version, created_at, updated_at
         from memory_summaries order by updated_at desc",
    )?;
    let items = stmt
        .query_map([], memory_summary_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Json(items))
}

async fn create_memory_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<MemorySummaryInput>,
) -> ApiResult<Json<MemorySummaryItem>> {
    require_owner(&state, &headers)?;
    let kind = input.kind.as_deref().unwrap_or("topic");
    validate_summary_kind(kind)?;
    let title = required_trimmed(input.title.as_deref(), "摘要标题不能为空")?;
    let content = required_trimmed(input.content.as_deref(), "摘要内容不能为空")?;
    let status = input.status.as_deref().unwrap_or("pending");
    validate_summary_status(status)?;
    let now = Utc::now().to_rfc3339();
    let conn = Connection::open(&state.db_path)?;
    conn.execute(
        "insert into memory_summaries
         (kind, title, content, source_memory_ids, status, version, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)",
        params![
            kind,
            title,
            content,
            serde_json::to_string(&input.source_memory_ids.unwrap_or_default())
                .unwrap_or_else(|_| "[]".to_string()),
            status,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    sync_summary_node(&conn, &load_memory_summary(&conn, id)?)?;
    Ok(Json(load_memory_summary(&conn, id)?))
}

async fn update_memory_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    Json(input): Json<MemorySummaryInput>,
) -> ApiResult<Json<MemorySummaryItem>> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    let current = load_memory_summary(&conn, id)?;
    let kind = input.kind.as_deref().unwrap_or(&current.kind);
    let status = input.status.as_deref().unwrap_or(&current.status);
    validate_summary_kind(kind)?;
    validate_summary_status(status)?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "update memory_summaries set kind = ?1, title = ?2, content = ?3,
         source_memory_ids = ?4, status = ?5, updated_at = ?6 where id = ?7",
        params![
            kind,
            input.title.as_deref().unwrap_or(&current.title).trim(),
            input.content.as_deref().unwrap_or(&current.content).trim(),
            input
                .source_memory_ids
                .map(|ids| serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string()))
                .unwrap_or(current.source_memory_ids),
            status,
            now,
            id,
        ],
    )?;
    if current.status != "active" && status == "active" {
        conn.execute(
            "update memory_summaries set status = 'disabled', updated_at = ?1
             where id != ?2 and kind = ?3 and title = ?4 and status = 'active'",
            params![
                now,
                id,
                kind,
                input.title.as_deref().unwrap_or(&current.title).trim()
            ],
        )?;
    }
    let summary = load_memory_summary(&conn, id)?;
    sync_summary_node(&conn, &summary)?;
    Ok(Json(summary))
}

async fn delete_memory_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
) -> ApiResult<StatusCode> {
    require_owner(&state, &headers)?;
    let conn = Connection::open(&state.db_path)?;
    conn.execute("delete from memory_summaries where id = ?1", params![id])?;
    let node_id = 1_000_000_000i64 + id;
    conn.execute(
        "delete from memory_edges where source_id=?1 or target_id=?1",
        params![node_id],
    )?;
    conn.execute("delete from memory_nodes where id = ?1", params![node_id])?;
    Ok(StatusCode::NO_CONTENT)
}

async fn generate_memory_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<MemorySummaryGenerateRequest>,
) -> ApiResult<Json<MemorySummaryItem>> {
    require_owner(&state, &headers)?;
    validate_summary_kind(&input.kind)?;
    let title = input.title.trim();
    if title.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请选择主题或领域"));
    }
    let sources = {
        let conn = Connection::open(&state.db_path)?;
        let column = if input.kind == "domain" {
            "domain"
        } else {
            "topic"
        };
        let sql = format!(
            "select id, content from memory_nodes where status = 'active' and kind != 'schema' and {column} = ?1 order by updated_at desc"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![title], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    if sources.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "没有可整理的有效原子记忆",
        ));
    }
    let max_tokens = if input.kind == "domain" { 300 } else { 500 };
    let prompt =
        format!(
        "根据以下原子记忆生成{}“{}”的稳定摘要。保留不确定性、变化和例外，不添加来源中没有的信息。\
         控制在约 {} tokens 内，只返回摘要正文。\n\n{}",
        if input.kind == "domain" { "领域画像" } else { "主题" },
        title,
        max_tokens,
        sources
            .iter()
            .map(|(id, content)| format!("#{id} {content}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let content = call_text_llm(
        &state,
        &input.api_key,
        input.base_url.as_deref(),
        &input.model,
        input.provider.as_deref(),
        "你是保守、可审计的记忆摘要器。",
        &prompt,
        max_tokens,
    )
    .await?;
    let conn = Connection::open(&state.db_path)?;
    let version: i64 = conn.query_row(
        "select coalesce(max(version), 0) + 1 from memory_summaries where kind = ?1 and title = ?2",
        params![input.kind, title],
        |row| row.get(0),
    )?;
    let now = Utc::now().to_rfc3339();
    let source_ids = sources.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    conn.execute(
        "insert into memory_summaries
         (kind, title, content, source_memory_ids, status, version, created_at, updated_at)
         values (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6)",
        params![
            input.kind,
            title,
            content.trim(),
            serde_json::to_string(&source_ids).unwrap_or_else(|_| "[]".to_string()),
            version,
            now,
        ],
    )?;
    let id = conn.last_insert_rowid();
    let summary = load_memory_summary(&conn, id)?;
    sync_summary_node(&conn, &summary)?;
    Ok(Json(summary))
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
        "insert into chat_sessions (title, messages, context_post_ids, context_photo_ids, context_free_text, use_memory, created_at, updated_at) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            input.title.as_deref().unwrap_or("新对话"),
            input.messages.as_deref().unwrap_or("[]"),
            input.context_post_ids.as_deref().unwrap_or("[]"),
            input.context_photo_ids.as_deref().unwrap_or("[]"),
            input.context_free_text.as_deref().unwrap_or(""),
            input.use_memory.unwrap_or(true),
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
        "update chat_sessions set title = coalesce(?1, title), messages = coalesce(?2, messages), context_post_ids = coalesce(?3, context_post_ids), context_photo_ids = coalesce(?4, context_photo_ids), context_free_text = coalesce(?5, context_free_text), use_memory = coalesce(?6, use_memory), updated_at = ?7 where id = ?8",
        params![
            input.title,
            input.messages,
            input.context_post_ids,
            input.context_photo_ids,
            input.context_free_text,
            input.use_memory,
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
        "select id, title, messages, context_post_ids, context_photo_ids, context_free_text, use_memory, created_at, updated_at from chat_sessions where id = ?1",
        params![id],
        |row| {
            Ok(ChatSessionItem {
                id: row.get(0)?,
                title: row.get(1)?,
                messages: row.get(2)?,
                context_post_ids: row.get(3)?,
                context_photo_ids: row.get(4)?,
                context_free_text: row.get(5)?,
                use_memory: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "会话不存在"))
}

fn memory_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        content: row.get(1)?,
        normalized_content: row.get(2)?,
        topic: row.get(3)?,
        domain: row.get(4)?,
        status: row.get(5)?,
        relation: row.get(6)?,
        related_memory_id: row.get(7)?,
        source_session_id: row.get(8)?,
        supersedes_id: row.get(9)?,
        mention_count: row.get(10)?,
        confidence: row.get(11)?,
        last_mentioned_at: row.get(12)?,
        valid_from: row.get(13)?,
        occurred_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        kind: row.get(17)?,
        time_precision: row.get(18)?,
        importance: row.get(19)?,
        emotion_weight: row.get(20)?,
        strength: row.get(21)?,
        last_activated_at: row.get(22)?,
        cues: vec![],
        sources: vec![],
        edges: vec![],
    })
}

fn memory_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemorySummaryItem> {
    Ok(MemorySummaryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        source_memory_ids: row.get(4)?,
        status: row.get(5)?,
        version: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn load_memory(conn: &Connection, id: i64) -> ApiResult<MemoryItem> {
    conn.query_row(
        "select id, content, normalized_content, topic, domain, status, relation,
                related_memory_id, source_session_id, supersedes_id, mention_count,
                confidence, last_mentioned_at, valid_from, occurred_at, created_at, updated_at,
                kind, time_precision, importance, emotion_weight, strength, last_activated_at
         from memory_nodes where id = ?1",
        params![id],
        memory_from_row,
    )
    .optional()?
    .map(|mut item| -> ApiResult<MemoryItem> {
        hydrate_memory_items(conn, std::slice::from_mut(&mut item))?;
        Ok(item)
    })
    .transpose()?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "记忆不存在"))
}

fn load_memory_summary(conn: &Connection, id: i64) -> ApiResult<MemorySummaryItem> {
    conn.query_row(
        "select id, kind, title, content, source_memory_ids, status, version, created_at, updated_at
         from memory_summaries where id = ?1",
        params![id],
        memory_summary_from_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "记忆摘要不存在"))
}

fn sync_summary_node(conn: &Connection, summary: &MemorySummaryItem) -> ApiResult<()> {
    let node_id = 1_000_000_000i64 + summary.id;
    let status = if summary.status == "active" {
        "active"
    } else if summary.status == "disabled" {
        "disabled"
    } else {
        "pending"
    };
    conn.execute(
        "insert into memory_nodes(id, content, normalized_content, kind, topic, domain, status, relation,
          mention_count, confidence, importance, emotion_weight, strength, last_mentioned_at, last_activated_at,
          valid_from, occurred_at, time_precision, created_at, updated_at)
         values(?1, ?2, ?3, 'schema', ?4, ?5, ?6, 'new', 1, 0.8, 0.7, 0.0, 1.0, ?7, ?7, ?8, ?8, 'unknown', ?8, ?7)
         on conflict(id) do update set content=excluded.content, normalized_content=excluded.normalized_content,
          topic=excluded.topic, domain=excluded.domain, status=excluded.status, updated_at=excluded.updated_at",
        params![node_id, summary.content, normalize_memory_content(&summary.content),
            if summary.kind == "topic" { &summary.title } else { "" },
            if summary.kind == "domain" { &summary.title } else { "" }, status, summary.updated_at, summary.created_at],
    )?;
    conn.execute(
        "delete from memory_edges where source_id=?1 and relation='summarizes'",
        params![node_id],
    )?;
    for source_id in
        serde_json::from_str::<Vec<i64>>(&summary.source_memory_ids).unwrap_or_default()
    {
        upsert_memory_edge(conn, node_id, source_id, "summarizes", 0.9)?;
        upsert_memory_edge(conn, source_id, node_id, "abstracted_by", 0.7)?;
    }
    Ok(())
}

fn hydrate_memory_items(conn: &Connection, items: &mut [MemoryItem]) -> ApiResult<()> {
    for item in items {
        let mut cue_stmt = conn.prepare(
            "select cue_type, value, specificity from memory_cues where memory_id = ?1 order by cue_type, value"
        )?;
        item.cues = cue_stmt
            .query_map(params![item.id], |row| {
                Ok(MemoryCue {
                    cue_type: row.get(0)?,
                    value: row.get(1)?,
                    specificity: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut source_stmt = conn.prepare(
            "select s.source_type, s.source_id, s.excerpt from memory_sources s
             join memory_node_sources ns on ns.source_id = s.id where ns.memory_id = ?1 order by s.id"
        )?;
        item.sources = source_stmt
            .query_map(params![item.id], |row| {
                Ok(MemorySource {
                    source_type: row.get(0)?,
                    source_id: row.get(1)?,
                    excerpt: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut edge_stmt = conn.prepare(
            "select target_id, relation, weight from memory_edges
             where source_id = ?1 and status = 'active' order by weight desc",
        )?;
        item.edges = edge_stmt
            .query_map(params![item.id], |row| {
                Ok(MemoryEdge {
                    target_id: row.get(0)?,
                    relation: row.get(1)?,
                    weight: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(())
}

fn replace_memory_cues(conn: &Connection, memory_id: i64, cues: &[MemoryCue]) -> ApiResult<()> {
    conn.execute(
        "delete from memory_cues where memory_id = ?1",
        params![memory_id],
    )?;
    let now = Utc::now().to_rfc3339();
    for cue in cues {
        let value = cue.value.trim();
        if value.is_empty() {
            continue;
        }
        conn.execute(
            "insert or ignore into memory_cues(memory_id, cue_type, value, normalized_value, specificity, created_at)
             values(?1, ?2, ?3, ?4, ?5, ?6)",
            params![memory_id, cue.cue_type.trim(), value, normalize_memory_content(value), cue.specificity.clamp(0.0, 1.0), now],
        )?;
    }
    Ok(())
}

fn attach_manual_source(conn: &Connection, memory_id: i64, excerpt: &str) -> ApiResult<()> {
    let now = Utc::now().to_rfc3339();
    let fingerprint = memory_source_fingerprint(excerpt, "manual");
    conn.execute(
        "insert or ignore into memory_sources(source_type, source_key, excerpt, fingerprint, created_at)
         values('manual', ?1, ?2, ?1, ?3)", params![fingerprint, excerpt, now],
    )?;
    let source_id: i64 = conn.query_row(
        "select id from memory_sources where source_type = 'manual' and source_key = ?1 and fingerprint = ?1",
        params![fingerprint], |row| row.get(0),
    )?;
    conn.execute(
        "insert or ignore into memory_node_sources(memory_id, source_id) values(?1, ?2)",
        params![memory_id, source_id],
    )?;
    Ok(())
}

fn upsert_memory_edge(
    conn: &Connection,
    source_id: i64,
    target_id: i64,
    relation: &str,
    weight: f64,
) -> ApiResult<()> {
    if source_id == target_id {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "insert into memory_edges(source_id, target_id, relation, weight, evidence_count, status, created_at, updated_at)
         values(?1, ?2, ?3, ?4, 1, 'active', ?5, ?5)
         on conflict(source_id, target_id, relation) do update set
           weight = min(1.0, memory_edges.weight + excluded.weight * 0.1),
           evidence_count = memory_edges.evidence_count + 1, status = 'active', updated_at = excluded.updated_at",
        params![source_id, target_id, relation, weight.clamp(0.0, 1.0), now],
    )?;
    Ok(())
}

fn required_trimmed<'a>(value: Option<&'a str>, message: &str) -> ApiResult<&'a str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, message))
}

fn validate_memory_status(status: &str) -> ApiResult<()> {
    if matches!(status, "pending" | "active" | "disabled" | "superseded") {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "记忆状态不合法"))
    }
}

fn validate_memory_kind_or_default(kind: &str) -> &str {
    match kind.trim() {
        "episode" | "fact" | "preference" | "person" | "place" | "life_stage" | "schema" => {
            kind.trim()
        }
        _ => "fact",
    }
}

fn validate_time_precision_or_default(precision: &str) -> &str {
    match precision.trim() {
        "exact" | "day" | "month" | "year" | "period" => precision.trim(),
        _ => "unknown",
    }
}

fn attach_extraction_sources(
    conn: &Connection,
    memory_id: i64,
    input: &MemoryExtractRequest,
    excerpt: &str,
    fingerprint: &str,
) -> ApiResult<()> {
    let now = Utc::now().to_rfc3339();
    let mut sources = Vec::new();
    for id in &input.post_ids {
        sources.push(("post", Some(*id), format!("post:{id}")));
    }
    for id in &input.photo_ids {
        sources.push(("photo", Some(*id), format!("photo:{id}")));
    }
    if let Some(id) = input.session_id {
        sources.push(("chat", Some(id), format!("chat:{id}")));
    }
    if sources.is_empty() {
        sources.push(("excerpt", None, fingerprint.to_string()));
    }
    for (source_type, source_id, source_key) in sources {
        conn.execute(
            "insert or ignore into memory_sources(source_type, source_id, source_key, excerpt, fingerprint, created_at)
             values(?1, ?2, ?3, ?4, ?5, ?6)",
            params![source_type, source_id, source_key, excerpt, fingerprint, now],
        )?;
        let source_row_id: i64 = conn.query_row(
            "select id from memory_sources where source_type = ?1 and source_key = ?2 and fingerprint = ?3",
            params![source_type, source_key, fingerprint], |row| row.get(0),
        )?;
        conn.execute(
            "insert or ignore into memory_node_sources(memory_id, source_id) values(?1, ?2)",
            params![memory_id, source_row_id],
        )?;
    }
    Ok(())
}

fn validate_summary_status(status: &str) -> ApiResult<()> {
    if matches!(status, "pending" | "active" | "stale" | "disabled") {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "摘要状态不合法"))
    }
}

fn validate_summary_kind(kind: &str) -> ApiResult<()> {
    if matches!(kind, "topic" | "domain") {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "摘要类型不合法"))
    }
}

fn normalize_memory_content(content: &str) -> String {
    content
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn localize_memory_label(value: &str) -> String {
    let value = value.trim();
    match value.to_ascii_lowercase().as_str() {
        "knowledge" => "知识",
        "personal" => "个人",
        "profile" => "个人画像",
        "preference" | "preferences" => "偏好",
        "experience" | "experiences" => "经历",
        "life" | "lifestyle" => "生活",
        "work" | "career" => "工作",
        "education" => "教育",
        "health" => "健康",
        "family" => "家庭",
        "relationship" | "relationships" => "人际关系",
        "technology" | "tech" => "技术",
        "travel" => "旅行",
        "finance" => "财务",
        "emotion" | "emotions" => "情绪",
        "hobby" | "hobbies" => "兴趣",
        "childhood" => "童年",
        "general" | "other" => "其他",
        _ => value,
    }
    .to_string()
}

fn memory_source_fingerprint(transcript: &str, attachments: &str) -> String {
    let source = format!(
        "messages:{}\nattachments:{}",
        normalize_memory_source(transcript),
        normalize_memory_source(attachments)
    );
    let mut hash = 0xcbf29ce484222325u64;
    for byte in source.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn normalize_memory_source(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn mark_summaries_stale(conn: &Connection, memory_id: i64) -> ApiResult<()> {
    let mut stmt =
        conn.prepare("select id, source_memory_ids from memory_summaries where status = 'active'")?;
    let summaries = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let now = Utc::now().to_rfc3339();
    for (id, raw_ids) in summaries {
        let source_ids = serde_json::from_str::<Vec<i64>>(&raw_ids).unwrap_or_default();
        if source_ids.contains(&memory_id) {
            conn.execute(
                "update memory_summaries set status = 'stale', updated_at = ?1 where id = ?2",
                params![now, id],
            )?;
            conn.execute(
                "update memory_nodes set status = 'pending', updated_at = ?1 where id = ?2",
                params![now, 1_000_000_000i64 + id],
            )?;
        }
    }
    Ok(())
}

fn load_active_memory_catalog(conn: &Connection) -> ApiResult<String> {
    let mut stmt = conn.prepare(
        "select id, content, topic, domain, status, occurred_at from memory_nodes
         where status in ('active', 'pending') order by occurred_at desc, updated_at desc",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(format!(
                "#{} [{} / {} / {} / 发生于 {}] {}",
                row.get::<_, i64>(0)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(1)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.join("\n"))
}

fn text_bigrams(text: &str) -> HashSet<String> {
    let normalized = normalize_memory_content(text);
    let chars = normalized.chars().collect::<Vec<_>>();
    if chars.len() < 2 {
        return (!normalized.is_empty())
            .then_some(normalized)
            .into_iter()
            .collect();
    }
    chars
        .windows(2)
        .map(|pair| pair.iter().collect::<String>())
        .collect()
}

fn relevance_score(query: &HashSet<String>, text: &str) -> f64 {
    if query.is_empty() {
        return 0.0;
    }
    let candidate = text_bigrams(text);
    let overlap = query.intersection(&candidate).count() as f64;
    overlap / query.len() as f64
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f64 {
    if left.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    let (mut dot, mut left_norm, mut right_norm) = (0.0f64, 0.0f64, 0.0f64);
    for (a, b) in left.iter().zip(right) {
        let (a, b) = (f64::from(*a), f64::from(*b));
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        dot / (left_norm.sqrt() * right_norm.sqrt())
    }
}

async fn ensure_memory_embeddings(
    state: &AppState,
    api_key: &str,
    base_url: Option<&str>,
    provider: Option<&str>,
    model: &str,
    query: &str,
) -> ApiResult<Vec<f32>> {
    let missing = {
        let conn = Connection::open(&state.db_path)?;
        let mut stmt = conn.prepare(
            "select id, content, topic, domain from memory_nodes
             where status = 'active' and (embedding = '' or embedding_model != ?1)",
        )?;
        let rows = stmt.query_map(params![model], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                format!(
                    "{} {} {}",
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(1)?
                ),
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut inputs = Vec::with_capacity(missing.len() + 1);
    inputs.push(query.to_string());
    inputs.extend(missing.iter().map(|(_, text)| text.clone()));

    let mut vectors =
        request_embeddings(state, api_key, base_url, provider, model, &inputs).await?;
    if vectors.len() != missing.len() + 1 {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Embedding 返回数量不匹配",
        ));
    }
    let query_vector = vectors.remove(0);
    if !missing.is_empty() {
        let conn = Connection::open(&state.db_path)?;
        for ((id, _), vector) in missing.iter().zip(vectors) {
            conn.execute(
                "update memory_nodes set embedding = ?1, embedding_model = ?2 where id = ?3",
                params![
                    serde_json::to_string(&vector).unwrap_or_else(|_| "[]".to_string()),
                    model,
                    id
                ],
            )?;
        }
    }
    Ok(query_vector)
}

async fn request_embeddings(
    state: &AppState,
    api_key: &str,
    base_url: Option<&str>,
    provider: Option<&str>,
    model: &str,
    inputs: &[String],
) -> ApiResult<Vec<Vec<f32>>> {
    let base_url = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://api.openai.com")
        .trim()
        .trim_end_matches('/');
    let is_ollama = provider == Some("ollama");
    let endpoint = embedding_endpoint(base_url, is_ollama);
    let response = with_llm_auth(state.http.post(endpoint), provider, api_key.trim())
        .json(&json!({ "model": model, "input": inputs }))
        .send()
        .await
        .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, format_reqwest_error(&error)))?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("Embedding 返回错误：{}", extract_llm_error(&value)),
        ));
    }
    let vectors = parse_embedding_vectors(&value, is_ollama)?;
    if vectors.is_empty() || vectors.iter().any(Vec::is_empty) {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "Embedding 服务没有返回有效向量",
        ));
    }
    Ok(vectors)
}

fn parse_embedding_vectors(value: &Value, is_ollama: bool) -> ApiResult<Vec<Vec<f32>>> {
    if is_ollama {
        return value
            .get("embeddings")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ApiError::new(StatusCode::BAD_GATEWAY, "Ollama Embedding 返回格式不正确")
            })?
            .iter()
            .map(parse_embedding_vector)
            .collect();
    }

    let mut vectors = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "Embedding 返回格式不正确"))?
        .iter()
        .map(|item| {
            let index = item.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            Ok((index, parse_embedding_vector(&item["embedding"])?))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    vectors.sort_by_key(|(index, _)| *index);
    Ok(vectors.into_iter().map(|(_, vector)| vector).collect())
}

fn parse_embedding_vector(value: &Value) -> ApiResult<Vec<f32>> {
    value
        .as_array()
        .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "Embedding 向量缺失"))?
        .iter()
        .map(|number| {
            number
                .as_f64()
                .map(|value| value as f32)
                .ok_or_else(|| ApiError::new(StatusCode::BAD_GATEWAY, "Embedding 向量包含无效数值"))
        })
        .collect()
}

fn embedding_endpoint(base_url: &str, is_ollama: bool) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let expected_path = if is_ollama {
        "/api/embed"
    } else {
        "/v1/embeddings"
    };
    if base.ends_with(expected_path) {
        base.to_string()
    } else {
        llm_endpoint(base, expected_path)
    }
}

fn recall_memories(
    conn: &Connection,
    query_text: &str,
    budget_tokens: usize,
    query_embedding: Option<&[f32]>,
    embedding_model: Option<&str>,
    plan: Option<&MemoryRetrievalPlan>,
) -> ApiResult<MemoryRecall> {
    let plan = plan
        .cloned()
        .unwrap_or_else(|| local_retrieval_plan(query_text));
    let search_text = format!("{} {} {}", query_text, plan.goal, plan.cues.join(" "));
    let query = text_bigrams(&search_text);
    let now = Utc::now();
    let mut stmt = conn.prepare(
        "select n.id, n.content, n.kind, n.topic, n.domain, n.occurred_at, n.confidence,
                n.importance, n.emotion_weight, n.strength, n.last_activated_at,
                n.embedding, n.embedding_model,
                coalesce((select group_concat(c.cue_type || ':' || c.value, ' ') from memory_cues c where c.memory_id=n.id), '')
         from memory_nodes n where n.status = 'active'"
    )?;
    let mut candidates = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            let content: String = row.get(1)?;
            let kind: String = row.get(2)?;
            let topic: String = row.get(3)?;
            let domain: String = row.get(4)?;
            let occurred_at: String = row.get(5)?;
            let confidence: f64 = row.get(6)?;
            let importance: f64 = row.get(7)?;
            let emotion: f64 = row.get(8)?;
            let strength: f64 = row.get(9)?;
            let activated: String = row.get(10)?;
            let raw_embedding: String = row.get(11)?;
            let stored_model: String = row.get(12)?;
            let cues: String = row.get(13)?;
            let lexical = relevance_score(&query, &format!("{domain} {topic} {content} {cues}"));
            let semantic =
                if query_embedding.is_some() && embedding_model == Some(stored_model.as_str()) {
                    serde_json::from_str::<Vec<f32>>(&raw_embedding)
                        .ok()
                        .and_then(|vector| query_embedding.map(|q| cosine_similarity(q, &vector)))
                        .unwrap_or(0.0)
                        .max(0.0)
                } else {
                    0.0
                };
            let age_days = DateTime::parse_from_rfc3339(&activated)
                .ok()
                .map(|date| (now - date.with_timezone(&Utc)).num_days().max(0) as f64)
                .unwrap_or(365.0);
            let accessibility = 1.0 / (1.0 + age_days / 180.0);
            let match_score = if query_embedding.is_some() {
                semantic * 0.58 + lexical * 0.42
            } else {
                lexical
            };
            let score = if match_score > 0.0 {
                match_score * 0.68
                    + confidence * 0.08
                    + importance * 0.09
                    + emotion * 0.05
                    + strength.min(10.0) / 10.0 * 0.05
                    + accessibility * 0.05
            } else {
                0.0
            };
            Ok((
                id,
                content,
                kind,
                topic,
                domain,
                occurred_at,
                cues,
                score,
                false,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    candidates.retain(|candidate| {
        candidate.7 > 0.0 && !plan.exclusions.iter().any(|x| candidate.1.contains(x))
    });
    candidates.sort_by(|a, b| b.7.total_cmp(&a.7));
    let seed_ids = candidates
        .iter()
        .take(8)
        .map(|item| item.0)
        .collect::<Vec<_>>();
    let mut expanded_ids = Vec::new();
    for seed_id in &seed_ids {
        let mut edge_stmt = conn.prepare(
            "select e.target_id, e.weight, n.content, n.kind, n.topic, n.domain, n.occurred_at,
                    coalesce((select group_concat(c.cue_type || ':' || c.value, ' ') from memory_cues c where c.memory_id=n.id), '')
             from memory_edges e join memory_nodes n on n.id=e.target_id
             where e.source_id=?1 and e.status='active' and e.weight>=0.35 and n.status='active'
             order by e.weight desc limit 6"
        )?;
        let expanded = edge_stmt
            .query_map(params![seed_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let seed_score = candidates
            .iter()
            .find(|item| item.0 == *seed_id)
            .map(|x| x.7)
            .unwrap_or(0.0);
        for (id, weight, content, kind, topic, domain, occurred, cues) in expanded {
            if candidates.iter().any(|item| item.0 == id) {
                continue;
            }
            expanded_ids.push(id);
            candidates.push((
                id,
                content,
                kind,
                topic,
                domain,
                occurred,
                cues,
                seed_score * weight * 0.72,
                true,
            ));
        }
    }
    candidates.sort_by(|a, b| b.7.total_cmp(&a.7));
    let char_budget = budget_tokens.saturating_mul(3);
    let mut used = 0usize;
    let mut lines = Vec::new();
    let mut meta = MemoryRecallMeta {
        semantic: query_embedding.is_some(),
        mode: if query_embedding.is_some() {
            "hybrid"
        } else {
            "lexical"
        }
        .to_string(),
        depth: plan.depth.clone(),
        breadth: plan.breadth,
        candidates: candidates.len(),
        planned: false,
        ..Default::default()
    };
    let mut seen_topics = HashSet::new();
    let mut selected = Vec::new();
    let mut timeline = Vec::new();
    for (id, content, kind, topic, domain, occurred_at, cues, score, expanded) in candidates {
        let group = if topic.is_empty() {
            domain.clone()
        } else {
            topic.clone()
        };
        if !seen_topics.contains(&group) && seen_topics.len() >= plan.breadth {
            continue;
        }
        let cue_text = if plan.depth == "deep" && !cues.is_empty() {
            format!("；线索：{cues}")
        } else {
            String::new()
        };
        let line = format!(
            "[记忆#{id}：{kind} / {domain} / {topic} / 发生于 {occurred_at}{cue_text}] {content}"
        );
        if used + line.chars().count() > char_budget {
            continue;
        }
        used += line.chars().count();
        seen_topics.insert(group);
        selected.push(id);
        meta.scores.push(MemoryRecallScore {
            node_id: id,
            score,
            reason: if expanded {
                "关联扩散"
            } else {
                "线索匹配"
            }
            .to_string(),
        });
        if kind == "schema" {
            meta.topics += 1;
        } else {
            meta.memories += 1;
        }
        if expanded {
            meta.expanded_node_ids.push(id);
        }
        timeline.push((occurred_at, line));
    }
    timeline.sort_by(|a, b| a.0.cmp(&b.0));
    if !timeline.is_empty() {
        lines.push("[记忆时间线（按发生时间从早到晚）]".to_string());
        lines.extend(timeline.into_iter().map(|(_, line)| line));
    }
    meta.domains = seen_topics.len();
    meta.selected_node_ids = selected.clone();
    meta.expanded_node_ids.sort_unstable();
    meta.expanded_node_ids.dedup();
    meta.estimated_tokens = (used + 2) / 3;
    record_recall_event(conn, query_text, &plan, &meta, &selected)?;
    Ok(MemoryRecall {
        text: lines.join("\n"),
        meta,
    })
}

fn local_retrieval_plan(query: &str) -> MemoryRetrievalPlan {
    let deep = ["具体", "细节", "当时", "感觉", "为什么", "回忆"]
        .iter()
        .any(|x| query.contains(x));
    let broad = ["这些年", "人生", "总体", "哪些", "所有", "变化"]
        .iter()
        .any(|x| query.contains(x));
    MemoryRetrievalPlan {
        goal: query.to_string(),
        depth: if deep {
            "deep"
        } else if broad {
            "gist"
        } else {
            "balanced"
        }
        .to_string(),
        breadth: if broad {
            5
        } else if deep {
            2
        } else {
            3
        },
        cues: vec![],
        exclusions: vec![],
    }
}

fn should_use_llm_retrieval_plan(query: &str) -> bool {
    query.chars().count() >= 45
        || [
            "回顾",
            "这些年",
            "为什么我",
            "有什么变化",
            "帮我想起",
            "结合以前",
            "人生阶段",
        ]
        .iter()
        .any(|term| query.contains(term))
}

async fn plan_memory_retrieval(
    state: &AppState,
    input: &ChatRequest,
    query: &str,
) -> ApiResult<MemoryRetrievalPlan> {
    let recent_context = input
        .messages
        .iter()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| format!("{}: {}", message.role, message.content.trim()))
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = format!(
        "为个人记忆检索生成计划。当前时间：{}。只输出 JSON：{{\"goal\":\"当前目标\",\"depth\":\"gist|balanced|deep\",\"breadth\":1到6,\"cues\":[\"人物、地点、时间、情绪、身体状态或目标线索\"],\"exclusions\":[\"排除项\"]}}。\n近期对话：\n{}\n当前问题：{}",
        Utc::now().to_rfc3339(), recent_context, query
    );
    let raw = call_text_llm(
        state,
        &input.api_key,
        input.base_url.as_deref(),
        &input.model,
        input.provider.as_deref(),
        "你是记忆检索控制器，不回答问题，只生成保守的检索计划。",
        &prompt,
        220,
    )
    .await?;
    let mut plan: MemoryRetrievalPlan =
        serde_json::from_str(strip_json_fence(&raw)).map_err(|error| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("检索计划格式错误：{error}"),
            )
        })?;
    if !matches!(plan.depth.as_str(), "gist" | "balanced" | "deep") {
        plan.depth = "balanced".to_string();
    }
    plan.breadth = plan.breadth.clamp(1, 6);
    plan.cues.truncate(12);
    plan.exclusions.truncate(8);
    Ok(plan)
}

fn record_recall_event(
    conn: &Connection,
    query: &str,
    plan: &MemoryRetrievalPlan,
    meta: &MemoryRecallMeta,
    selected: &[i64],
) -> ApiResult<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "insert into memory_recall_events(query, mode, depth, breadth, candidate_scores, selected_node_ids, expanded_node_ids, created_at)
         values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![query, meta.mode, plan.depth, plan.breadth as i64, serde_json::to_string(&meta.scores.iter().map(|item| json!({"node_id": item.node_id, "score": item.score, "reason": item.reason})).collect::<Vec<_>>()).unwrap_or_default(), serde_json::to_string(selected).unwrap_or_default(), serde_json::to_string(&meta.expanded_node_ids).unwrap_or_default(), now],
    )?;
    for id in selected {
        conn.execute("update memory_nodes set last_activated_at=?1, strength=min(10.0, strength+0.02) where id=?2", params![now, id])?;
    }
    for pair in selected.windows(2) {
        upsert_memory_edge(conn, pair[0], pair[1], "co_recalled", 0.25)?;
        upsert_memory_edge(conn, pair[1], pair[0], "co_recalled", 0.25)?;
    }
    Ok(())
}

fn strip_json_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    if !trimmed.starts_with("```") {
        return trimmed;
    }
    let after_first = trimmed
        .find('\n')
        .map(|index| &trimmed[index + 1..])
        .unwrap_or(trimmed);
    after_first
        .strip_suffix("```")
        .map(str::trim)
        .unwrap_or(after_first)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n[附件内容过长，已截断]");
    truncated
}

fn parse_extracted_memories(raw: &str) -> ApiResult<Vec<ExtractedMemory>> {
    serde_json::from_str(strip_json_fence(raw)).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("模型返回的记忆格式无法解析：{error}"),
        )
    })
}

fn extracted_memory_occurred_at(
    candidate: &ExtractedMemory,
    post_dates: &HashMap<i64, String>,
    fallback: Option<&str>,
) -> String {
    candidate
        .occurred_at
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            candidate
                .source_post_id
                .and_then(|id| post_dates.get(&id).cloned())
        })
        .or_else(|| fallback.map(str::to_string))
        .unwrap_or_default()
}

async fn call_text_llm(
    state: &AppState,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    provider: Option<&str>,
    system: &str,
    prompt: &str,
    max_tokens: usize,
) -> ApiResult<String> {
    if model.trim().is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "请填写模型名"));
    }
    let is_anthropic = provider == Some("anthropic");
    let base_url = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(if is_anthropic {
            "https://api.anthropic.com"
        } else {
            "https://api.openai.com"
        })
        .trim()
        .trim_end_matches('/');
    if is_anthropic {
        let response = state
            .http
            .post(llm_endpoint(base_url, "/v1/messages"))
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model.trim(),
                "system": system,
                "messages": [{ "role": "user", "content": prompt }],
                "max_tokens": max_tokens,
            }))
            .send()
            .await
            .map_err(|error| {
                ApiError::new(StatusCode::BAD_GATEWAY, format_reqwest_error(&error))
            })?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("LLM 返回错误：{}", extract_llm_error(&value)),
            ));
        }
        Ok(extract_llm_text(&value))
    } else {
        let mut payload = json!({
            "model": model.trim(),
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": prompt }
            ],
            "temperature": 0.1,
            "max_tokens": max_tokens,
        });
        apply_openai_compatible_provider_options(&mut payload, provider);
        let response = with_llm_auth(
            state.http.post(openai_chat_endpoint(base_url)),
            provider,
            api_key.trim(),
        )
        .json(&payload)
        .send()
        .await
        .map_err(|error| ApiError::new(StatusCode::BAD_GATEWAY, format_reqwest_error(&error)))?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("LLM 返回错误：{}", extract_llm_error(&value)),
            ));
        }
        Ok(extract_llm_text(&value))
    }
}

fn extract_llm_text(value: &Value) -> String {
    if let Some(text) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        return text.to_string();
    }

    if let Some(parts) = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_array)
    {
        let text = parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("");
        if !text.trim().is_empty() {
            return text;
        }
    }

    if let Some(parts) = value.get("content").and_then(Value::as_array) {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !text.trim().is_empty() {
            return text;
        }
    }

    for pointer in [
        "/choices/0/message/reasoning_content",
        "/choices/0/text",
        "/output_text",
        "/response",
        "/text",
    ] {
        if let Some(text) = value
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            return text.to_string();
        }
    }

    String::new()
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
            l.trim()
                .strip_prefix("<title>")
                .and_then(|s| s.strip_suffix("</title>"))
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
    if base.ends_with(&format!("/{normalized_path}")) {
        return base.to_string();
    }
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

fn openai_chat_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        return base.to_string();
    }
    let last_segment = base.rsplit('/').next().unwrap_or_default();
    if last_segment.strip_prefix('v').is_some_and(|version| {
        !version.is_empty() && version.chars().all(|char| char.is_ascii_digit())
    }) {
        format!("{base}/chat/completions")
    } else {
        llm_endpoint(base, "/v1/chat/completions")
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
    if api_key.trim().is_empty() {
        return request;
    }
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

fn load_location(conn: &Connection, id: i64) -> ApiResult<LocationItem> {
    conn.query_row(
        "select id, name, latitude, longitude, created_at, updated_at from locations where id = ?1",
        params![id],
        location_from_row,
    )
    .optional()?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "地点不存在"))
}

fn location_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocationItem> {
    Ok(LocationItem {
        id: row.get(0)?,
        name: row.get(1)?,
        latitude: row.get(2)?,
        longitude: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_schema(conn: &Connection) {
        conn.execute_batch(
            r#"
            create table memory_nodes (
                id integer primary key autoincrement,
                content text not null,
                normalized_content text not null,
                topic text not null default '',
                domain text not null default '',
                status text not null default 'pending',
                relation text not null default 'new',
                related_memory_id integer,
                source_session_id integer,
                supersedes_id integer,
                mention_count integer not null default 1,
                confidence real not null default 0.7,
                last_mentioned_at text not null,
                valid_from text not null,
                occurred_at text not null,
                created_at text not null,
                updated_at text not null,
                embedding text not null default '',
                embedding_model text not null default ''
                ,kind text not null default 'fact'
                ,importance real not null default 0.5
                ,emotion_weight real not null default 0
                ,strength real not null default 1
                ,last_activated_at text not null default 'now'
                ,occurred_until text not null default ''
                ,time_precision text not null default 'unknown'
            );
            create table memory_cues (id integer primary key, memory_id integer, cue_type text, value text, normalized_value text, specificity real, created_at text, unique(memory_id, cue_type, normalized_value));
            create table memory_sources (id integer primary key, source_type text, source_id integer, source_key text, excerpt text, fingerprint text, created_at text, unique(source_type, source_key, fingerprint));
            create table memory_node_sources (memory_id integer, source_id integer, primary key(memory_id, source_id));
            create table memory_edges (source_id integer, target_id integer, relation text, weight real, evidence_count integer, status text, created_at text, updated_at text, primary key(source_id,target_id,relation));
            create table memory_recall_events (id integer primary key, query text, mode text, depth text, breadth integer, candidate_scores text, selected_node_ids text, expanded_node_ids text, created_at text);
            create table memory_summaries (
                id integer primary key autoincrement,
                kind text not null,
                title text not null,
                content text not null,
                source_memory_ids text not null default '[]',
                status text not null default 'pending',
                version integer not null default 1,
                created_at text not null,
                updated_at text not null
            );
            create table memory_extractions (
                source_fingerprint text primary key,
                post_ids text not null default '[]',
                photo_ids text not null default '[]',
                created_at text not null
            );
            "#,
        )
        .unwrap();
    }

    fn insert_memory(conn: &Connection, content: &str, topic: &str, domain: &str) -> i64 {
        conn.execute(
            "insert into memory_nodes
             (content, normalized_content, topic, domain, status, relation, mention_count,
              confidence, last_mentioned_at, valid_from, occurred_at, created_at, updated_at)
             values (?1, ?2, ?3, ?4, 'active', 'new', 1, 1, 'now', 'now', 'now', 'now', 'now')",
            params![content, normalize_memory_content(content), topic, domain],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn normalizes_memory_for_exact_deduplication() {
        assert_eq!(
            normalize_memory_content(" 喜欢 Rust，和 SQLite! "),
            normalize_memory_content("喜欢Rust和SQLite")
        );
    }

    #[test]
    fn localizes_common_memory_labels() {
        assert_eq!(localize_memory_label("knowledge"), "知识");
        assert_eq!(localize_memory_label("Preferences"), "偏好");
        assert_eq!(localize_memory_label("家乡记忆"), "家乡记忆");
    }

    #[test]
    fn creates_stable_source_fingerprints() {
        let first =
            memory_source_fingerprint("user: 我喜欢简洁界面\nassistant: 明白", "[文章]\n正文");
        let same_with_spacing = memory_source_fingerprint(
            " user: 我喜欢简洁界面 \n\n assistant: 明白 ",
            " [文章]\n 正文 ",
        );
        let different =
            memory_source_fingerprint("user: 我喜欢深色界面\nassistant: 明白", "[文章]\n正文");
        assert_eq!(first, same_with_spacing);
        assert_ne!(first, different);
    }

    #[test]
    fn records_unique_extracted_attachment_sources() {
        let conn = Connection::open_in_memory().unwrap();
        memory_schema(&conn);
        record_memory_extraction(&conn, "one", &[3, 1], &[8], "now").unwrap();
        record_memory_extraction(&conn, "two", &[3, 5], &[9, 8], "now").unwrap();
        let sources = load_memory_extraction_sources(&conn).unwrap();
        assert_eq!(sources.post_ids, vec![1, 3, 5]);
        assert_eq!(sources.photo_ids, vec![8, 9]);
    }

    #[test]
    fn parses_fenced_candidate_json_and_rejects_invalid_json() {
        let parsed = parse_extracted_memories(
            "```json\n[{\"content\":\"偏好简洁界面\",\"topic\":\"UI\",\"domain\":\"交互\",\"occurred_at\":\"2024-10-01T12:00:00Z\",\"source_post_id\":12}]\n```",
        )
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].relation, "new");
        assert_eq!(
            parsed[0].occurred_at.as_deref(),
            Some("2024-10-01T12:00:00Z")
        );
        assert_eq!(parsed[0].source_post_id, Some(12));
        assert!(parse_extracted_memories("not json").is_err());
    }

    #[test]
    fn resolves_memory_time_from_event_before_source_fallback() {
        let post_dates = HashMap::from([(12, "2025-06-01T12:00:00Z".to_string())]);
        let event_candidate = ExtractedMemory {
            content: "八岁时第一次学游泳".to_string(),
            topic: String::new(),
            domain: String::new(),
            relation: default_memory_relation(),
            related_memory_id: None,
            confidence: 0.8,
            occurred_at: Some("2002-01-01T00:00:00Z".to_string()),
            source_post_id: Some(12),
            kind: default_memory_kind(),
            time_precision: default_time_precision(),
            importance: default_importance(),
            emotion_weight: 0.0,
            cues: vec![],
        };
        assert_eq!(
            extracted_memory_occurred_at(&event_candidate, &post_dates, None),
            "2002-01-01T00:00:00Z"
        );

        let source_candidate = ExtractedMemory {
            occurred_at: None,
            ..event_candidate
        };
        assert_eq!(
            extracted_memory_occurred_at(&source_candidate, &post_dates, None),
            "2025-06-01T12:00:00Z"
        );

        let unknown_candidate = ExtractedMemory {
            source_post_id: None,
            ..source_candidate
        };
        assert_eq!(
            extracted_memory_occurred_at(&unknown_candidate, &HashMap::new(), None),
            ""
        );
    }

    #[test]
    fn extracts_text_from_common_llm_response_shapes() {
        assert_eq!(
            extract_llm_text(&json!({
                "choices": [{ "message": { "content": "OK" } }]
            })),
            "OK"
        );
        assert_eq!(
            extract_llm_text(&json!({
                "choices": [{ "message": { "content": [
                    { "type": "text", "text": "O" },
                    { "type": "text", "text": "K" }
                ] } }]
            })),
            "OK"
        );
        assert_eq!(
            extract_llm_text(&json!({
                "content": [
                    { "type": "thinking", "thinking": "..." },
                    { "type": "text", "text": "OK" }
                ]
            })),
            "OK"
        );
        assert_eq!(
            extract_llm_text(&json!({
                "choices": [{ "message": { "content": null, "reasoning_content": "OK" } }]
            })),
            "OK"
        );
    }

    #[test]
    fn omits_authorization_header_when_api_key_is_empty() {
        let client = Client::new();
        let anonymous = with_llm_auth(client.get("http://localhost/embeddings"), None, "")
            .build()
            .unwrap();
        assert!(anonymous
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .is_none());

        let authenticated = with_llm_auth(
            client.get("http://localhost/embeddings"),
            None,
            "local-secret",
        )
        .build()
        .unwrap();
        assert_eq!(
            authenticated
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .unwrap(),
            "Bearer local-secret"
        );
    }

    #[test]
    fn parses_openai_and_ollama_embedding_responses() {
        let openai = parse_embedding_vectors(
            &json!({
                "data": [
                    { "index": 1, "embedding": [3.0, 4.0] },
                    { "index": 0, "embedding": [1.0, 2.0] }
                ]
            }),
            false,
        )
        .unwrap();
        assert_eq!(openai, vec![vec![1.0, 2.0], vec![3.0, 4.0]]);

        let ollama =
            parse_embedding_vectors(&json!({ "embeddings": [[1.0, 2.0], [3.0, 4.0]] }), true)
                .unwrap();
        assert_eq!(ollama, vec![vec![1.0, 2.0], vec![3.0, 4.0]]);
        assert_eq!(
            embedding_endpoint("http://localhost:11434", true),
            "http://localhost:11434/api/embed"
        );
        assert_eq!(
            embedding_endpoint("http://localhost:8080/api/embed", true),
            "http://localhost:8080/api/embed"
        );
        assert_eq!(
            embedding_endpoint("https://example.com/v1/embeddings", false),
            "https://example.com/v1/embeddings"
        );
    }

    #[test]
    fn resolves_openai_compatible_chat_endpoints() {
        assert_eq!(
            openai_chat_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_endpoint("https://open.bigmodel.cn/api/paas/v4"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        assert_eq!(
            openai_chat_endpoint("https://example.com/custom/chat/completions"),
            "https://example.com/custom/chat/completions"
        );
        assert_eq!(
            llm_endpoint("https://api.anthropic.com/v1/messages", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn marks_only_summaries_with_exact_source_id_stale() {
        let conn = Connection::open_in_memory().unwrap();
        memory_schema(&conn);
        conn.execute(
            "insert into memory_summaries
             (kind, title, content, source_memory_ids, status, version, created_at, updated_at)
             values ('topic', 'one', 'a', '[1]', 'active', 1, 'now', 'now'),
                    ('topic', 'eleven', 'b', '[11]', 'active', 1, 'now', 'now')",
            [],
        )
        .unwrap();
        mark_summaries_stale(&conn, 1).unwrap();
        let statuses = conn
            .prepare("select status from memory_summaries order by id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(statuses, vec!["stale", "active"]);
    }

    #[test]
    fn recall_excludes_stale_summaries_and_respects_budget() {
        let conn = Connection::open_in_memory().unwrap();
        memory_schema(&conn);
        let memory_id = insert_memory(&conn, "用户偏好低饱和且减少动画的界面", "UI 偏好", "交互");
        conn.execute(
            "insert into memory_summaries
             (kind, title, content, source_memory_ids, status, version, created_at, updated_at)
             values ('domain', '交互', '偏好安静简洁的交互', ?1, 'active', 1, 'now', 'now'),
                    ('topic', '旧摘要', '不应召回', ?1, 'stale', 1, 'now', 'now')",
            params![serde_json::to_string(&vec![memory_id]).unwrap()],
        )
        .unwrap();
        sync_summary_node(&conn, &load_memory_summary(&conn, 1).unwrap()).unwrap();
        sync_summary_node(&conn, &load_memory_summary(&conn, 2).unwrap()).unwrap();
        let recall = recall_memories(&conn, "交互界面动画怎么设计", 400, None, None, None).unwrap();
        assert!(recall.text.contains("安静简洁"));
        assert!(recall.text.contains("低饱和"));
        assert!(recall.text.contains("发生于 now"));
        assert!(!recall.text.contains("不应召回"));
        assert!(recall.meta.estimated_tokens <= 400);
    }

    #[test]
    fn semantic_recall_finds_related_memory_and_emits_chronological_timeline() {
        let conn = Connection::open_in_memory().unwrap();
        memory_schema(&conn);
        let earlier = insert_memory(&conn, "搬到上海生活", "人生经历", "生活");
        let later = insert_memory(&conn, "开始养一只猫", "人生经历", "生活");
        conn.execute(
            "update memory_nodes set occurred_at = '2020-01-01', embedding = '[1.0,0.0]', embedding_model = 'test' where id = ?1",
            params![earlier],
        )
        .unwrap();
        conn.execute(
            "update memory_nodes set occurred_at = '2023-01-01', embedding = '[0.8,0.2]', embedding_model = 'test' where id = ?1",
            params![later],
        )
        .unwrap();

        let recall = recall_memories(
            &conn,
            "故乡在哪里",
            400,
            Some(&[1.0, 0.0]),
            Some("test"),
            None,
        )
        .unwrap();
        assert!(recall.meta.semantic);
        assert!(recall.text.contains("2020-01-01"));
        assert!(recall.text.contains("2023-01-01"));
        assert!(recall.text.find("2020-01-01") < recall.text.find("2023-01-01"));
    }

    #[test]
    fn recall_completes_patterns_through_strong_edges_and_records_activation() {
        let conn = Connection::open_in_memory().unwrap();
        memory_schema(&conn);
        let seed = insert_memory(&conn, "雨夜在西湖边散步", "西湖", "经历");
        let detail = insert_memory(&conn, "车窗上有雾，正在播放一首离别的歌", "旧歌", "情绪");
        upsert_memory_edge(&conn, seed, detail, "co_occurs", 0.9).unwrap();
        let recall = recall_memories(&conn, "西湖雨夜", 400, None, None, None).unwrap();
        assert!(recall.text.contains("雨夜在西湖"));
        assert!(recall.text.contains("车窗上有雾"));
        assert!(recall.meta.expanded_node_ids.contains(&detail));
        let activated: String = conn
            .query_row(
                "select last_activated_at from memory_nodes where id=?1",
                params![detail],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(activated, "now");
    }
}
