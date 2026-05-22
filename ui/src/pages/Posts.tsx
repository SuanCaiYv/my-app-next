import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { listPosts, createPost, updatePost, deletePost, analyze } from "../api";
import type { PostItem } from "../types";
import Select from "../components/Select";
import { useToast } from "../hooks/useToast";

function kindName(kind: string) {
  return { article: "文章", thought: "想法", note: "随手写" }[kind] || kind;
}
function statusName(status: string) {
  return status === "published" ? "发布" : "草稿";
}
function statusPillClass(status: string) {
  return status === "published" ? "pill-status-published" : "pill-status-draft";
}

function tagList(tags: string) {
  return tags
    .split(/[,，、\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeCategory(value: string) {
  return value.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean)[0] || "";
}

function normalizeTags(value: string) {
  return Array.from(new Set(tagList(value))).join(", ");
}

function formatDateTimeText(value: string) {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDateTimeText(value: string) {
  const normalized = value
    .trim()
    .replace(/[年月]/g, "-")
    .replace(/日/g, " ")
    .replace(/[./]/g, "-")
    .replace(/T/g, " ")
    .replace(/\s+/g, " ");
  const parts = normalized.match(/\d+/g)?.map(Number) || [];
  if (parts.length < 3) return null;
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export default function PostsPage({
  search,
  categoryFilter,
  kindFilter,
  newPostTrigger,
  operationCard,
}: {
  search: string;
  categoryFilter: string;
  kindFilter: string;
  newPostTrigger?: number;
  operationCard?: React.ReactNode;
}) {
  useAuth();
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewPost, setViewPost] = useState<PostItem | null>(null);
  const [editPost, setEditPost] = useState<PostItem | null>(null);
  const { show: showToast, element: toastElement } = useToast();
  const handledNewPostTrigger = useRef(newPostTrigger || 0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPosts();
      setPosts(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (newPostTrigger && newPostTrigger > handledNewPostTrigger.current) {
      handledNewPostTrigger.current = newPostTrigger;
      setEditPost({ id: 0, title: "", body: "", kind: "article", status: "draft", category: "", tags: "", created_at: "", updated_at: "" } as PostItem);
    }
  }, [newPostTrigger]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return posts.filter((p) => {
      const hay = `${p.title} ${p.body} ${p.category} ${p.tags}`.toLowerCase();
      return (!q || hay.includes(q)) && (!categoryFilter || p.category === categoryFilter) && (!kindFilter || p.kind === kindFilter);
    });
  }, [posts, search, categoryFilter, kindFilter]);


  const handleSave = async (post: Partial<PostItem> & { updated_at?: string }) => {
    try {
      if (editPost?.id) {
        await updatePost(editPost.id, post);
      } else {
        await createPost(post);
      }
      setEditPost(null);
      await load();
      showToast("已保存");
    } catch (err: any) {
      showToast(err.message);
    }
  };

  const handleDelete = async () => {
    if (!editPost?.id || !confirm("确定删除这条内容？")) return;
    try {
      await deletePost(editPost.id);
      setEditPost(null);
      await load();
      showToast("已删除");
    } catch (err: any) {
      showToast(err.message);
    }
  };

  const handleGenerateTitle = async (body: string, category: string, tags: string) => {
    const apiKey = localStorage.getItem("apiKey") || "";
    const model = localStorage.getItem("model") || "";
    const baseUrl = localStorage.getItem("baseUrl") || "";
    const provider = localStorage.getItem("llmProvider") || "";
    if (!apiKey.trim() || !model.trim()) {
      showToast("先在 LLM 分析页填写 API Key 和模型");
      return "";
    }
    try {
      const data = await analyze({
        api_key: apiKey,
        base_url: baseUrl || undefined,
        model,
        provider: provider || undefined,
        prompt: "请为下面这篇个人文章或随手想法生成一个中文标题。标题要自然、具体、有记忆点，不要夸张，不要使用书名号，不要解释，只返回一个标题，最多 18 个中文字符。",
        free_text: `分类：${category || "未分类"}\n标签：${tags || "无"}\n正文：\n${body}`,
        post_ids: [],
        photo_ids: [],
        save: false,
      });
      return data.answer.trim().replace(/^["'""''《》]+|["'""''《》]+$/g, "").split("\n")[0].replace(/^标题[:：]\s*/, "").trim();
    } catch (err: any) {
      showToast(err.message);
      return "";
    }
  };

  return (
    <section className="view active" id="postsView">
      <div id="postList" className="list">
        {operationCard}
        {loading ? (
          <div className="empty">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="empty">还没有可浏览的文字</div>
        ) : (
          filtered.map((post) => (
            <article
              key={post.id}
              className="post-card"
              tabIndex={0}
              onClick={() => setViewPost(post)}
              onKeyDown={(e) => e.key === "Enter" && setViewPost(post)}
            >
              <div className="post-head">
                <div>
                  <h2 className="post-title">{post.title}</h2>
                  <div className="meta">
                    <span className="pill pill-kind">{kindName(post.kind)}</span>
                    <span className={`pill pill-status ${statusPillClass(post.status)}`}>{statusName(post.status)}</span>
                    {post.category && <span className="pill pill-category">{post.category}</span>}
                    {tagList(post.tags).map((tag) => <span key={tag} className="pill pill-tags">{tag}</span>)}
                    <span className="meta-date">{formatDateTimeText(post.updated_at)}</span>
                  </div>
                </div>
              </div>
              <div className="body preview">{post.body}</div>
            </article>
          ))
        )}
      </div>

      <PostViewDialog post={viewPost} onClose={() => setViewPost(null)} onEdit={() => { setEditPost(viewPost); setViewPost(null); }} />
      <PostEditDialog
        post={editPost}
        onClose={() => setEditPost(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        onGenerateTitle={handleGenerateTitle}
      />

      {toastElement}
    </section>
  );
}

function PostViewDialog({ post, onClose, onEdit }: { post: PostItem | null; onClose: () => void; onEdit: () => void }) {
  const { role } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (post) {
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [post]);

  if (!post) return null;

  return (
    <dialog ref={dialogRef} className="post-view-dialog" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="dialog-body wide reader">
        <header className="reader-head">
          <div>
            <h2>{post.title}</h2>
            <div className="meta">
              <span className="pill pill-kind">{kindName(post.kind)}</span>
              <span className={`pill pill-status ${statusPillClass(post.status)}`}>{statusName(post.status)}</span>
              {post.category && <span className="pill pill-category">{post.category}</span>}
              {tagList(post.tags).map((tag) => <span key={tag} className="pill pill-tags">{tag}</span>)}
              <span>{formatDateTimeText(post.updated_at)}</span>
            </div>
          </div>
          <div className="head-actions">
            {role === "owner" && <button className="primary" onClick={onEdit}>编辑</button>}
            <button className="secondary" onClick={onClose}>关闭</button>
          </div>
        </header>
        <div className="reader-body">{post.body}</div>
      </section>
    </dialog>
  );
}

function PostEditDialog({
  post,
  onClose,
  onSave,
  onDelete,
  onGenerateTitle,
}: {
  post: PostItem | null;
  onClose: () => void;
  onSave: (p: Partial<PostItem> & { updated_at?: string }) => Promise<void> | void;
  onDelete: () => void;
  onGenerateTitle: (body: string, category: string, tags: string) => Promise<string>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<PostItem["kind"]>("article");
  const [status, setStatus] = useState<PostItem["status"]>("draft");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [updatedAtText, setUpdatedAtText] = useState(formatDateTimeText(new Date().toISOString()));
  const [generating, setGenerating] = useState(false);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (post) {
      setTitle(post.title);
      setBody(post.body);
      setKind(post.kind);
      setStatus(post.status);
      setCategory(post.category);
      setTags(post.tags);
      setUpdatedAtText(formatDateTimeText(post.updated_at || new Date().toISOString()));
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [post]);

  const handleSave = async () => {
    if (savingRef.current) return;
    const parsedUpdatedAt = parseDateTimeText(updatedAtText);
    if (!parsedUpdatedAt) {
      alert("时间格式无法识别");
      return;
    }
    savingRef.current = true;
    try {
      await onSave({
        title,
        body,
        kind,
        status,
        category: normalizeCategory(category),
        tags: normalizeTags(tags),
        updated_at: parsedUpdatedAt.toISOString(),
      });
    } finally {
      savingRef.current = false;
    }
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent) => {
    if (generating) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSave();
    }
  };

  const handleGenerate = async () => {
    if (!body.trim()) {
      alert("先写一点内容");
      return;
    }
    setGenerating(true);
    const t = await onGenerateTitle(body, category, tags);
    if (t) setTitle(t);
    setGenerating(false);
  };

  if (!post) return null;

  return (
    <dialog
      ref={dialogRef}
      className="post-dialog"
      onClose={onClose}
      onCancel={(e) => {
        if (generating) { e.preventDefault(); return; }
        e.preventDefault();
        void handleSave();
      }}
      onClick={(e) => {
        if (generating) return;
        if (e.target === e.currentTarget) {
          if (!title.trim() && !body.trim()) {
            onClose();
          } else {
            void handleSave();
          }
        }
      }}
    >
      <section className="dialog-body post-editor">
        <form onSubmit={(event) => { event.preventDefault(); void handleSave(); }} onKeyDown={handleEditorKeyDown}>
          <div className="post-editor-meta">
            <div className="field post-editor-title">
              <label>标题</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </div>
            <button className="post-editor-ai" type="button" onClick={handleGenerate} disabled={generating}>
              {generating ? "..." : "AI"}
            </button>
            <div className="field post-editor-category">
              <label>分类</label>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                onBlur={() => setCategory((value) => normalizeCategory(value))}
                placeholder="分类"
              />
            </div>
            <div className="field post-editor-tags">
              <label>标签</label>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                onBlur={() => setTags((value) => normalizeTags(value))}
                placeholder="标签，多个用逗号分隔"
              />
            </div>
            <div className="field post-editor-kind">
              <label>类型</label>
              <Select
                value={kind}
                ariaLabel="类型"
                onChange={(value) => setKind(value as PostItem["kind"])}
                options={[
                  { value: "article", label: "文章" },
                  { value: "thought", label: "想法" },
                  { value: "note", label: "随手写" },
                ]}
              />
            </div>
            <div className="field post-editor-status">
              <label>状态</label>
              <Select
                value={status}
                ariaLabel="状态"
                onChange={(value) => setStatus(value as PostItem["status"])}
                options={[
                  { value: "draft", label: "草稿" },
                  { value: "published", label: "发布" },
                ]}
              />
            </div>
            <div className="field post-editor-date-field">
              <label>更新时间</label>
              <input
                className="post-editor-date"
                value={updatedAtText}
                onChange={(e) => setUpdatedAtText(e.target.value)}
                onBlur={() => {
                  const parsed = parseDateTimeText(updatedAtText);
                  if (parsed) setUpdatedAtText(formatDateTimeText(parsed.toISOString()));
                }}
                placeholder="2026-5-12 20:29"
              />
            </div>
            {post.id > 0 ? (
              <button className="danger post-editor-delete" type="button" onClick={onDelete} aria-label="删除" title="删除">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M6 6l1 15h10l1-15" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              </button>
            ) : (
              <button className="secondary post-editor-cancel" type="button" onClick={onClose}>取消</button>
            )}
          </div>
          <label className="post-editor-body-label">正文</label>
          <textarea className="post-editor-body" value={body} onChange={(e) => setBody(e.target.value)} />
        </form>
      </section>
    </dialog>
  );
}
