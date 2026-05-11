# Hello.me · Personal Studio

一个本地优先的个人知识库 / 内容管理桌面应用。Rust + Axum 后端 + 原生 JS SPA，外壳由 Tauri 2 打包成 macOS / Windows 原生应用。内置 OpenAI 兼容的 LLM 接入，可以对你的文字与照片做总结、提问、生成标题。

## 功能

- **文字**：文章 / 想法 / 随手写三种类型，支持分类、标签、草稿/发布状态、时间编辑
- **照片**：上传图片、记录标题/分类/标签/说明,自动从 EXIF 中提取 GPS
- **地图**:基于 Leaflet 在地图上展示带定位的照片
- **对话**:把选中的文章和照片作为上下文,与任意 OpenAI 兼容模型进行多轮对话,支持多会话切换
- **LLM 分析**:对所选内容批量调用模型,生成总结/扩展问题,历史记录可回看
- **Token 进度条**:聊天面板实时显示「已用/上下文上限」,接 API 后自动用 `usage.total_tokens` 校准,内置常见模型上下文表
- **访客 / 主人模式**:默认是访客视图,点击左上角 logo 七次唤起密码登录,获得编辑权限

## 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | Rust · Axum 0.8 · Tokio · rusqlite (bundled SQLite) |
| 前端 | 原生 HTML / CSS / JS · Leaflet · 无构建步骤 |
| LLM | reqwest 调用任意 OpenAI 兼容接口 (GPT / DeepSeek / Qwen ...) |
| 桌面外壳 | Tauri 2 (DMG / NSIS) |
| 其它 | kamadak-exif · image · chrono · uuid |

## 本地开发

### 仅跑后端 (浏览器调试前端)

```bash
cargo run
# 默认监听 http://127.0.0.1:3000
```

环境变量:

- `PERSONAL_SITE_PASSWORD`:主人登录密码,默认 `change-me`

### 跑桌面应用 (Tauri)

先装一次 Tauri CLI:

```bash
cargo install tauri-cli --version "^2"
```

然后:

```bash
cd src-tauri
cargo tauri dev
```

桌面应用会启一个内嵌 Axum 服务监听 `127.0.0.1:34867`,WebView 加载该地址。

## 打包

### macOS DMG

```bash
./scripts/build-dmg.sh
# 或
cd src-tauri && cargo tauri build --bundles dmg
```

产物路径:`src-tauri/target/release/bundle/dmg/`

> 未签名的 DMG 在别的 Mac 上首次打开会提示「已损坏」,这是 Gatekeeper 行为,不是真的损坏。临时绕过:
> ```bash
> xattr -d com.apple.quarantine /Applications/Hello.me.app
> ```
> 长期方案需要 Apple Developer 账号签名 + 公证。

### Windows NSIS 安装包

不建议在 macOS 上交叉编译,推荐用 GitHub Actions(见下),或在 Windows 上:

```bash
cd src-tauri
cargo tauri build --bundles nsis
```

产物路径:`src-tauri/target/release/bundle/nsis/`

### GitHub Actions

仓库自带 `.github/workflows/build.yml`,矩阵同时跑 macOS + Windows:

- 推送到 `main` 或手动触发:打包 DMG + EXE 作为 workflow artifact(临时 24h)
- 推送 `v*` tag:同样的产物会自动附到对应的 GitHub Release

打 tag 触发 release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

如果 tag 在某次代码修复之前就推出去了,删 tag 重新打即可:

```bash
git tag -d v0.1.0
git push origin --delete v0.1.0
git tag v0.1.0
git push origin v0.1.0
```

## 数据存放位置

桌面应用使用系统数据目录:

- macOS:`~/Library/Application Support/me.hello.personal-studio/data/`
- Windows:`%APPDATA%\me.hello.personal-studio\data\`

包含 `app.db`(SQLite)与 `uploads/`(照片原文件)。

直接 `cargo run` 时,数据存在仓库根目录的 `data/`。

## 接入 LLM

进入「LLM」标签页,填:

- API Key
- 模型(下拉里有 GPT-4.1 / 4o / DeepSeek V4 / DeepSeek Chat / Qwen-Plus 等预设,也可自定义)
- Base URL(默认 OpenAI,DeepSeek 改 `https://api.deepseek.com` 等)

配置存在本地浏览器 storage,不上传到任何地方。聊天和分析都通过本地后端代理转发,后端不持久化 key。

## 目录结构

```
src/                Rust 后端(单文件 lib.rs ~ 900 行)
src-tauri/          Tauri 桌面外壳与配置
static/             前端 SPA(index.html / app.js / styles.css)
scripts/            构建脚本
.github/workflows/  CI 配置
PACKAGING.md        打包细节
CLAUDE.md           给 Claude Code 的项目说明
```

## 鸣谢

- [Tauri](https://tauri.app/) · [Axum](https://github.com/tokio-rs/axum) · [Leaflet](https://leafletjs.com/)

## License

未指定。当前是个人项目,使用前请自行评估。
