import { useEffect, useImperativeHandle, useMemo, useState, useCallback, useRef, forwardRef } from "react";
import { useAuth } from "../context/AuthContext";
import { listPosts, createPost, updatePost, deletePost, analyze } from "../api";
import type { PostItem } from "../types";
import Select from "../components/Select";
import { useToast } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { currentModel, DEFAULT_TITLE_PROMPT, loadActiveLlmProfile } from "../llmSettings";

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

type ScrollSnapshot = {
  windowY: number;
  documentTop: number;
  mainTop: number;
  listTop: number;
};

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
  const { confirm: confirmDialog, element: confirmElement } = useConfirm();
  const handledNewPostTrigger = useRef(newPostTrigger || 0);
  const listRef = useRef<HTMLDivElement>(null);

  const captureScroll = useCallback((): ScrollSnapshot => {
    const main = document.querySelector("main");
    const scrollingElement = document.scrollingElement || document.documentElement;
    return {
      windowY: window.scrollY,
      documentTop: scrollingElement.scrollTop,
      mainTop: main?.scrollTop || 0,
      listTop: listRef.current?.scrollTop || 0,
    };
  }, []);

  const restoreScroll = useCallback((snapshot: ScrollSnapshot) => {
    const apply = () => {
      const main = document.querySelector("main");
      const scrollingElement = document.scrollingElement || document.documentElement;
      scrollingElement.scrollTop = snapshot.documentTop;
      if (main) main.scrollTop = snapshot.mainTop;
      if (listRef.current) listRef.current.scrollTop = snapshot.listTop;
      window.scrollTo(window.scrollX, snapshot.windowY);
    };

    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
  }, []);

  const load = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    try {
      const data = await listPosts();
      setPosts(data);
    } finally {
      if (showLoading) setLoading(false);
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
    const scrollSnapshot = captureScroll();
    try {
      if (editPost?.id) {
        await updatePost(editPost.id, post);
      } else {
        await createPost(post);
      }
      setEditPost(null);
      await load({ showLoading: false });
      restoreScroll(scrollSnapshot);
      showToast("已保存");
    } catch (err: any) {
      showToast(err.message);
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!editPost?.id) return;
    if (!(await confirmDialog("确定删除这条内容？"))) return;
    try {
      await deletePost(editPost.id);
      setEditPost(null);
      await load();
      showToast("已删除");
    } catch (err: any) {
      showToast(err.message);
    }
  };

  const handleViewSave = async (id: number, post: Partial<PostItem> & { updated_at?: string }) => {
    const scrollSnapshot = captureScroll();
    try {
      const updated = await updatePost(id, post);
      setViewPost(updated);
      await load({ showLoading: false });
      restoreScroll(scrollSnapshot);
      showToast("已保存");
    } catch (err: any) {
      showToast(err.message);
      throw err;
    }
  };

  const handleViewDelete = async (id: number) => {
    if (!(await confirmDialog("确定删除这条内容？"))) return;
    try {
      await deletePost(id);
      setViewPost(null);
      await load();
      showToast("已删除");
    } catch (err: any) {
      showToast(err.message);
    }
  };

  const handleGenerateTitle = async (body: string, category: string, tags: string) => {
    const llmProfile = loadActiveLlmProfile();
    const model = currentModel(llmProfile);
    if (!llmProfile.apiKey.trim() || !model.trim()) {
      showToast("先在 LLM 分析页填写 API Key 和模型");
      return "";
    }
    try {
      const data = await analyze({
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl || undefined,
        model,
        provider: llmProfile.providerId || undefined,
        prompt: llmProfile.titlePrompt.trim() || DEFAULT_TITLE_PROMPT,
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
      <div id="postList" className="list" ref={listRef}>
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

      <PostViewDialog
        post={viewPost}
        onClose={() => setViewPost(null)}
        onSave={handleViewSave}
        onDelete={handleViewDelete}
        onGenerateTitle={handleGenerateTitle}
      />
      <PostEditDialog
        post={editPost}
        onClose={() => setEditPost(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        onGenerateTitle={handleGenerateTitle}
      />

      {confirmElement}
      {toastElement}
    </section>
  );
}

function PostViewDialog({
  post,
  onClose,
  onSave,
  onDelete,
  onGenerateTitle,
}: {
  post: PostItem | null;
  onClose: () => void;
  onSave: (id: number, p: Partial<PostItem> & { updated_at?: string }) => Promise<void> | void;
  onDelete: (id: number) => Promise<void> | void;
  onGenerateTitle: (body: string, category: string, tags: string) => Promise<string>;
}) {
  const { role } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const editTimerRef = useRef<number | null>(null);
  const activePostIdRef = useRef<number | null>(null);
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editClosing, setEditClosing] = useState(false);
  const editorRef = useRef<{ save: () => Promise<void> }>(null);

  useEffect(() => {
    if (post) {
      const isNewPost = activePostIdRef.current !== post.id;
      activePostIdRef.current = post.id;
      setClosing(false);
      if (isNewPost) {
        setEditing(false);
        setEditClosing(false);
      }
      dialogRef.current?.showModal();
    } else {
      activePostIdRef.current = null;
      dialogRef.current?.close();
    }
  }, [post]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    if (editTimerRef.current !== null) {
      window.clearTimeout(editTimerRef.current);
    }
  }, []);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
      closeTimerRef.current = null;
    }, 180);
  };

  const enterEdit = () => {
    setEditClosing(false);
    setEditing(true);
  };

  const exitEdit = () => {
    if (editClosing) return;
    setEditClosing(true);
    editTimerRef.current = window.setTimeout(() => {
      setEditing(false);
      setEditClosing(false);
      editTimerRef.current = null;
    }, 180);
  };

  if (!post) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`post-view-dialog${editing ? " editing" : ""}${editClosing ? " edit-closing" : ""}${closing ? " closing" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        if (editing) {
          exitEdit();
        } else {
          requestClose();
        }
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        if (editing) {
          void editorRef.current?.save().then(() => requestClose());
        } else {
          requestClose();
        }
      }}
    >
      <section className={`dialog-body ${editing ? "post-editor post-editor-in-reader" : "wide reader"}`}>
        {editing ? (
          <PostViewEditor
            ref={editorRef}
            post={post}
            onSave={async (payload) => {
              await onSave(post.id, payload);
              exitEdit();
            }}
            onDelete={() => onDelete(post.id)}
            onGenerateTitle={onGenerateTitle}
          />
        ) : (
        <>
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
            {role === "owner" && <button className="primary" onClick={enterEdit}>编辑</button>}
            <button className="secondary" onClick={requestClose}>关闭</button>
          </div>
        </header>
        <TypewriterBody text={post.body} animationKey={post.id} />
        </>
        )}
      </section>
    </dialog>
  );
}

function TypewriterBody({ text, animationKey }: { text: string; animationKey: number }) {
  const characters = useMemo(() => {
    if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
      return Array.from(segmenter.segment(text), ({ segment }) => segment);
    }
    return Array.from(text);
  }, [text]);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setVisibleCount(characters.length);
      return;
    }

    let index = 0;
    let timer: number | undefined;
    setVisibleCount(0);

    const tick = () => {
      index += 1;
      setVisibleCount(index);
      if (index >= characters.length) return;

      const char = characters[index - 1];
      const delay = /[。！？!?；;\n]/.test(char) ? 130 : /[，,、：:]/.test(char) ? 70 : 18;
      timer = window.setTimeout(tick, delay);
    };

    timer = window.setTimeout(tick, 120);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [animationKey, characters]);

  return (
    <div className="reader-body typewriter-body" aria-label={text}>
      <span aria-hidden="true">
        {characters.slice(0, visibleCount).map((char, index) => (
          <span
            key={`${animationKey}-${index}`}
            className={`typewriter-char${index === visibleCount - 1 ? " is-new" : ""}`}
          >
            {char}
          </span>
        ))}
        {visibleCount < characters.length && <span className="typewriter-caret" />}
      </span>
    </div>
  );
}

interface PostViewEditorHandle {
  save: () => Promise<void>;
}

const PostViewEditor = forwardRef<PostViewEditorHandle, {
  post: PostItem;
  onSave: (p: Partial<PostItem> & { updated_at?: string }) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onGenerateTitle: (body: string, category: string, tags: string) => Promise<string>;
}>(function PostViewEditor({
  post,
  onSave,
  onDelete,
  onGenerateTitle,
}, ref) {
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [kind, setKind] = useState<PostItem["kind"]>(post.kind);
  const [status, setStatus] = useState<PostItem["status"]>(post.status);
  const [category, setCategory] = useState(post.category);
  const [tags, setTags] = useState(post.tags);
  const [updatedAtText, setUpdatedAtText] = useState(formatDateTimeText(post.updated_at || new Date().toISOString()));
  const [generating, setGenerating] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    setTitle(post.title);
    setBody(post.body);
    setKind(post.kind);
    setStatus(post.status);
    setCategory(post.category);
    setTags(post.tags);
    setUpdatedAtText(formatDateTimeText(post.updated_at || new Date().toISOString()));
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

  useImperativeHandle(ref, () => ({ save: handleSave }));

  const handleGenerate = async () => {
    if (!body.trim()) {
      alert("先写一点内容");
      return;
    }
    setGenerating(true);
    const nextTitle = await onGenerateTitle(body, category, tags);
    if (nextTitle) setTitle(nextTitle);
    setGenerating(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (generating) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSave();
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void handleSave(); }} onKeyDown={handleKeyDown}>
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
        <button className="danger post-editor-delete" type="button" onClick={onDelete} aria-label="删除" title="删除">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M6 6l1 15h10l1-15" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
          </svg>
        </button>
      </div>
      <label className="post-editor-body-label">正文</label>
      <textarea className="post-editor-body" value={body} onChange={(e) => setBody(e.target.value)} />
    </form>
  );
});

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
  const [closing, setClosing] = useState(false);
  const savingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (post) {
      setClosing(false);
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

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
  }, []);

  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      onClose();
      closeTimerRef.current = null;
    }, 180);
  };

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
      className={`post-dialog${closing ? " closing" : ""}`}
      onCancel={(e) => {
        if (generating) { e.preventDefault(); return; }
        e.preventDefault();
        void handleSave();
      }}
      onClick={(e) => {
        if (generating) return;
        if (e.target === e.currentTarget) {
          if (!title.trim() && !body.trim()) {
            requestClose();
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
              <button className="secondary post-editor-cancel" type="button" onClick={requestClose}>取消</button>
            )}
          </div>
          <label className="post-editor-body-label">正文</label>
          <textarea className="post-editor-body" value={body} onChange={(e) => setBody(e.target.value)} />
        </form>
      </section>
    </dialog>
  );
}
