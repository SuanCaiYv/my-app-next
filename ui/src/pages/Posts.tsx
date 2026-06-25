import { useEffect, useImperativeHandle, useMemo, useState, useCallback, useRef, forwardRef } from "react";
import { useAuth } from "../context/AuthContext";
import { useLoading } from "../context/LoadingContext";
import { listPosts, createPost, updatePost, deletePost, analyze, extractLocations, listPostLocations, addPostLocation, removePostLocation } from "../api";
import type { LocationItem, PostItem } from "../types";
import Select from "../components/Select";
import { useToast } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { currentModel, DEFAULT_LOCATION_PROMPT, DEFAULT_TAGS_PROMPT, DEFAULT_TITLE_PROMPT, loadActiveLlmProfile, requestProvider } from "../llmSettings";
import { formatDateTimeText, parseDateTimeText } from "../utils/dateTime";

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

// ── Tag / Category color palette ──────────────────────────────
const TAG_PALETTE = [
  { bg: "#e8e0f0", border: "#c4b5d9", text: "#5c4a7a" }, // lavender
  { bg: "#dce8ef", border: "#b3cdd9", text: "#3e6577" }, // steel blue
  { bg: "#e6ede4", border: "#bfcfb8", text: "#4a6343" }, // sage
  { bg: "#f0e4d8", border: "#d9c4a8", text: "#7a5e3a" }, // sand
  { bg: "#e0e8ec", border: "#b8ccd4", text: "#46606a" }, // slate
  { bg: "#ece4dc", border: "#d4c4b4", text: "#6a5a4a" }, // warm gray
  { bg: "#e4e8e0", border: "#c0c8b8", text: "#525e4a" }, // olive mist
  { bg: "#e8e4ec", border: "#ccc0d4", text: "#5e526a" }, // mauve
  { bg: "#dce4e8", border: "#b4c4cc", text: "#4a5e66" }, // denim
  { bg: "#ece0e0", border: "#d4b8b8", text: "#6a4a4a" }, // rose ash
  { bg: "#e0ece4", border: "#b8d4c0", text: "#4a6652" }, // mint
  { bg: "#e8e8dc", border: "#d0d0b4", text: "#5e5e44" }, // flax
  { bg: "#dce0ec", border: "#b4bcd4", text: "#4a5066" }, // periwinkle
  { bg: "#ece8e0", border: "#d4ccb4", text: "#665e44" }, // wheat
  { bg: "#e0e0ec", border: "#b8b8d4", text: "#505066" }, // iris
  { bg: "#e4ece0", border: "#c0d4b8", text: "#52664a" }, // fern
  { bg: "#ece0e8", border: "#d4b8cc", text: "#664a5e" }, // heather
  { bg: "#e0ece8", border: "#b8d4cc", text: "#4a665e" }, // teal mist
  { bg: "#e8e0e0", border: "#d0b8b8", text: "#5e4a4a" }, // ash rose
  { bg: "#e0e4ec", border: "#b8c0d4", text: "#4a5266" }, // cornflower
  { bg: "#ece4e8", border: "#d4c0cc", text: "#66525e" }, // thistle
  { bg: "#e4e0ec", border: "#c0b8d4", text: "#524a66" }, // wisteria
  { bg: "#e8ece0", border: "#ccd4b8", text: "#5e664a" }, // moss
  { bg: "#e0e8e4", border: "#b8d0c0", text: "#4a5e52" }, // jade mist
  { bg: "#ecece0", border: "#d4d4b4", text: "#666644" }, // oat
  { bg: "#e4e0e8", border: "#c0b8d0", text: "#524a5e" }, // plum mist
  { bg: "#e0ece0", border: "#b8d4b8", text: "#4a664a" }, // celadon
  { bg: "#e8e4e0", border: "#d0c0b4", text: "#5e524a" }, // stone
  { bg: "#e4ece8", border: "#c0d4cc", text: "#52665e" }, // seafoam
  { bg: "#ece4e4", border: "#d4c0c0", text: "#665252" }, // blush
];

let tagColorMap: Record<string, (typeof TAG_PALETTE)[number]> = {};
try { tagColorMap = JSON.parse(localStorage.getItem("tagColorMap") || "{}"); } catch {}

function saveTagColorMap() {
  localStorage.setItem("tagColorMap", JSON.stringify(tagColorMap));
}

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function getTagColor(name: string) {
  const key = name.trim().toLowerCase();
  if (!key) return TAG_PALETTE[0];
  if (tagColorMap[key]) return tagColorMap[key];
  const idx = hashStr(key) % TAG_PALETTE.length;
  tagColorMap[key] = TAG_PALETTE[idx];
  saveTagColorMap();
  return tagColorMap[key];
}

function normalizeCategory(value: string) {
  return value.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean)[0] || "";
}

function normalizeTags(value: string) {
  return Array.from(new Set(tagList(value))).join(", ");
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
  tagFilter,
  onCategoryFilterChange,
  onKindFilterChange,
  onTagFilterChange,
  newPostTrigger,
  operationCard,
}: {
  search: string;
  categoryFilter: string;
  kindFilter: string;
  tagFilter: string;
  onCategoryFilterChange?: (value: string) => void;
  onKindFilterChange?: (value: string) => void;
  onTagFilterChange?: (value: string) => void;
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
      const tags = tagList(p.tags);
      return (!q || hay.includes(q)) && (!categoryFilter || p.category === categoryFilter) && (!kindFilter || p.kind === kindFilter) && (!tagFilter || tags.includes(tagFilter));
    });
  }, [posts, search, categoryFilter, kindFilter, tagFilter]);

  const existingTags = useMemo(() => {
    const set = new Set<string>();
    posts.forEach((p) => tagList(p.tags).forEach((t) => set.add(t)));
    return Array.from(set);
  }, [posts]);


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

  const handleExtractLocations = async (postId: number) => {
    const llmProfile = loadActiveLlmProfile();
    const model = currentModel(llmProfile);
    if (!model.trim()) {
      showToast("先在 LLM 分析页填写模型");
      return [];
    }
    const amapKey = localStorage.getItem("amapKey") || "";
    if (!amapKey.trim()) {
      showToast("先在设置页填写高德 Key");
      return [];
    }
    try {
      const locations = await extractLocations({
        post_id: postId,
        amap_key: amapKey,
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl || undefined,
        model,
        provider: requestProvider(llmProfile),
        prompt: llmProfile.locationPrompt.trim() || DEFAULT_LOCATION_PROMPT,
      });
      showToast(`提取到 ${locations.length} 个地点`);
      return locations;
    } catch (err: any) {
      showToast(err.message);
      return [];
    }
  };

  const handleGenerateTags = async (body: string, category: string, title: string) => {
    const llmProfile = loadActiveLlmProfile();
    const model = currentModel(llmProfile);
    if (!model.trim()) {
      showToast("先在 LLM 分析页填写模型");
      return "";
    }
    try {
      const data = await analyze({
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl || undefined,
        model,
        provider: requestProvider(llmProfile),
        prompt: llmProfile.tagsPrompt.trim() || DEFAULT_TAGS_PROMPT,
        free_text: `标题：${title || "无标题"}\n分类：${category || "未分类"}\n已有标签：${existingTags.join("、") || "无"}\n正文：\n${body}`,
        post_ids: [],
        photo_ids: [],
        save: false,
      });
      const tags = data.answer
        .split(/[,，、\n]+/)
        .map((t) => t.trim().replace(/^["'""''《》]+|["'""''《》]+$/g, ""))
        .filter(Boolean);
      return Array.from(new Set(tags)).join(", ");
    } catch (err: any) {
      showToast(err.message);
      return "";
    }
  };

  const handleGenerateTitle = async (body: string, category: string, tags: string) => {
    const llmProfile = loadActiveLlmProfile();
    const model = currentModel(llmProfile);
    if (!model.trim()) {
      showToast("先在 LLM 分析页填写模型");
      return "";
    }
    try {
      const data = await analyze({
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl || undefined,
        model,
        provider: requestProvider(llmProfile),
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

  const applyKindFilter = (kind: string) => {
    onKindFilterChange?.(kind);
  };
  const applyCategoryFilter = (category: string) => {
    onCategoryFilterChange?.(category);
  };
  const applyTagFilter = (tag: string) => {
    onTagFilterChange?.(tagFilter === tag ? "" : tag);
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
                    <span className="pill pill-kind clickable" onClick={(e) => { e.stopPropagation(); applyKindFilter(post.kind); }}>{kindName(post.kind)}</span>
                    <span className={`pill pill-status ${statusPillClass(post.status)}`}>{statusName(post.status)}</span>
                    {post.category && (() => { const c = getTagColor(post.category); return <span className="pill pill-category clickable" style={{ background: c.bg, borderColor: c.border, color: c.text }} onClick={(e) => { e.stopPropagation(); applyCategoryFilter(post.category); }}>{post.category}</span>; })()}
                    {tagList(post.tags).length > 0 && <span className="tags-row">{tagList(post.tags).map((tag) => { const c = getTagColor(tag); return <span key={tag} className="pill pill-tag clickable" style={{ background: c.bg, borderColor: c.border, color: c.text }} onClick={(e) => { e.stopPropagation(); applyTagFilter(tag); }}>{tag}</span>; })}</span>}
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
        onGenerateTags={handleGenerateTags}
        onExtractLocations={handleExtractLocations}
      />
      <PostEditDialog
        post={editPost}
        onClose={() => setEditPost(null)}
        onSave={handleSave}
        onDelete={handleDelete}
        onGenerateTitle={handleGenerateTitle}
        onGenerateTags={handleGenerateTags}
        onExtractLocations={handleExtractLocations}
      />

      {confirmElement}
      {toastElement}
    </section>
  );
}

export function PostViewDialog({
  post,
  onClose,
  onSave,
  onDelete,
  onGenerateTitle,
  onGenerateTags,
  onExtractLocations,
}: {
  post: PostItem | null;
  onClose: () => void;
  onSave?: (id: number, p: Partial<PostItem> & { updated_at?: string }) => Promise<void> | void;
  onDelete?: (id: number) => Promise<void> | void;
  onGenerateTitle?: (body: string, category: string, tags: string) => Promise<string>;
  onGenerateTags?: (body: string, category: string, title: string) => Promise<string>;
  onExtractLocations?: (postId: number) => Promise<LocationItem[]>;
}) {
  const { role } = useAuth();
  const { loading } = useLoading();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const editTimerRef = useRef<number | null>(null);
  const activePostIdRef = useRef<number | null>(null);
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editClosing, setEditClosing] = useState(false);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const editorRef = useRef<{ save: () => Promise<void> }>(null);
  const editorActions = onSave && onDelete && onGenerateTitle && onGenerateTags && onExtractLocations
    ? { onSave, onDelete, onGenerateTitle, onGenerateTags, onExtractLocations }
    : null;

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

  useEffect(() => {
    if (post) {
      listPostLocations(post.id).then(setLocations).catch(() => {});
    } else {
      setLocations([]);
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
    if (!editorActions) return;
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
        if (loading) return;
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
        {editing && editorActions ? (
          <PostViewEditor
            ref={editorRef}
            post={post}
            onSave={async (payload) => {
              await editorActions.onSave(post.id, payload);
              exitEdit();
            }}
            onDelete={() => editorActions.onDelete(post.id)}
            onGenerateTitle={editorActions.onGenerateTitle}
            onGenerateTags={editorActions.onGenerateTags}
            onExtractLocations={editorActions.onExtractLocations}
          />
        ) : (
        <>
        <header className="reader-head">
          <div>
            <h2>{post.title}</h2>
            <div className="meta">
              <span className="pill pill-kind">{kindName(post.kind)}</span>
              <span className={`pill pill-status ${statusPillClass(post.status)}`}>{statusName(post.status)}</span>
              {post.category && (() => { const c = getTagColor(post.category); return <span className="pill pill-category" style={{ background: c.bg, borderColor: c.border, color: c.text }}>{post.category}</span>; })()}
              {tagList(post.tags).length > 0 && <span className="tags-row">{tagList(post.tags).map((tag) => { const c = getTagColor(tag); return <span key={tag} className="pill pill-tag" style={{ background: c.bg, borderColor: c.border, color: c.text }}>{tag}</span>; })}</span>}
              {locations.length > 0 && (
                <div className="reader-locations">
                  {locations.map((loc) => (
                    <span key={loc.id} className="pill pill-location">{loc.name}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="head-actions">
            <div className="reader-head-buttons">
              {role === "owner" && editorActions && <button className="primary" onClick={enterEdit}>编辑</button>}
              <button className="secondary" onClick={requestClose}>关闭</button>
            </div>
            <span className="reader-head-time">{formatDateTimeText(post.updated_at)}</span>
          </div>
        </header>
        <TypewriterBody key={post.id} text={post.body} animationKey={post.id} />
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
  const holdingRef = useRef(false);
  const holdStartedAtRef = useRef(0);

  const stopAcceleration = useCallback(() => {
    holdingRef.current = false;
    holdStartedAtRef.current = 0;
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", stopAcceleration);
    window.addEventListener("pointercancel", stopAcceleration);
    window.addEventListener("blur", stopAcceleration);
    return () => {
      window.removeEventListener("pointerup", stopAcceleration);
      window.removeEventListener("pointercancel", stopAcceleration);
      window.removeEventListener("blur", stopAcceleration);
    };
  }, [stopAcceleration]);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setVisibleCount(characters.length);
      return;
    }

    let index = 0;
    let frame: number | undefined;
    let lastFrameAt = performance.now();
    let remainingDelay = 140;
    setVisibleCount(0);

    const tick = (now: number) => {
      const elapsed = Math.min(now - lastFrameAt, 100);
      lastFrameAt = now;
      const accelerationSteps = holdingRef.current
        ? Math.floor((now - holdStartedAtRef.current) / 500)
        : 0;
      const speed = 2 ** Math.max(0, accelerationSteps);
      remainingDelay -= elapsed * speed;

      let changed = false;
      while (remainingDelay <= 0 && index < characters.length) {
        const char = characters[index];
        index += 1;
        changed = true;
        remainingDelay += /[。！？!?；;\n]/.test(char) ? 110 : /[，,、：:]/.test(char) ? 55 : 24;
      }
      if (changed) setVisibleCount(index);
      if (index < characters.length) frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      stopAcceleration();
    };
  }, [animationKey, characters, stopAcceleration]);

  return (
    <div
      className={`reader-body typewriter-body${visibleCount < characters.length ? " is-animating" : ""}`}
      aria-label={text}
      onPointerDown={(event) => {
        if (event.button !== 0 || visibleCount >= characters.length) return;
        holdingRef.current = true;
        holdStartedAtRef.current = performance.now();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={stopAcceleration}
      onPointerCancel={stopAcceleration}
      onLostPointerCapture={stopAcceleration}
      onContextMenu={(event) => {
        if (visibleCount < characters.length) event.preventDefault();
      }}
    >
      <span className="typewriter-measure" aria-hidden="true">{text || " "}</span>
      <span className="typewriter-visible" aria-hidden="true">
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

interface EditorFormProps {
  post: PostItem;
  onSave: (p: Partial<PostItem> & { updated_at?: string }) => Promise<void> | void;
  onDelete?: () => void | Promise<void>;
  onCancel?: () => void;
  onGenerateTitle: (body: string, category: string, tags: string) => Promise<string>;
  onGenerateTags?: (body: string, category: string, title: string) => Promise<string>;
  onExtractLocations?: (postId: number) => Promise<LocationItem[]>;
}

export interface EditorFormHandle {
  save: () => Promise<void>;
}

const EditorForm = forwardRef<EditorFormHandle, EditorFormProps>(function EditorForm({
  post,
  onSave,
  onDelete,
  onCancel,
  onGenerateTitle,
  onGenerateTags,
  onExtractLocations,
}, ref) {
  const { setLoading } = useLoading();
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [kind, setKind] = useState<PostItem["kind"]>(post.kind);
  const [status, setStatus] = useState<PostItem["status"]>(post.status);
  const [category, setCategory] = useState(post.category);
  const [tagItems, setTagItems] = useState<string[]>(tagList(post.tags || ""));
  const [tagInput, setTagInput] = useState("");
  const [updatedAtText, setUpdatedAtText] = useState(formatDateTimeText(post.updated_at || new Date().toISOString()));
  const [generating, setGenerating] = useState(false);
  const [generatingTags, setGeneratingTags] = useState(false);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [extractingLocations, setExtractingLocations] = useState(false);
  const [locationInput, setLocationInput] = useState("");
  const savingRef = useRef(false);

  useEffect(() => {
    setTitle(post.title);
    setBody(post.body);
    setKind(post.kind);
    setStatus(post.status);
    setCategory(post.category);
    setTagItems(tagList(post.tags || ""));
    setTagInput("");
    setLocationInput("");
    setUpdatedAtText(formatDateTimeText(post.updated_at || new Date().toISOString()));
    setLocations([]);
  }, [post]);

  useEffect(() => {
    if (onExtractLocations && post.id > 0) {
      listPostLocations(post.id).then(setLocations).catch(() => {});
    } else {
      setLocations([]);
    }
  }, [post.id, onExtractLocations]);

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
        tags: tagItems.join(", "),
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
    setLoading(true, "正在生成标题...");
    try {
      const nextTitle = await onGenerateTitle(body, category, tagItems.join(", "));
      if (nextTitle) setTitle(nextTitle);
    } finally {
      setGenerating(false);
      setLoading(false);
    }
  };

  const handleGenerateTags = async () => {
    if (!onGenerateTags) return;
    if (!body.trim()) {
      alert("先写一点内容");
      return;
    }
    setGeneratingTags(true);
    setLoading(true, "正在生成标签...");
    try {
      const nextTags = await onGenerateTags(body, category, title);
      console.log("AI tags raw:", nextTags);
      const tags = tagList(normalizeTags(nextTags || ""));
      console.log("AI tags parsed:", tags);
      if (tags.length > 0) setTagItems(tags);
    } catch (err: unknown) {
      console.error("AI tags error:", err);
    } finally {
      setGeneratingTags(false);
      setLoading(false);
    }
  };

  const handleExtract = async () => {
    if (!onExtractLocations || post.id <= 0) return;
    if (!body.trim()) {
      alert("先写一点内容");
      return;
    }
    setExtractingLocations(true);
    setLoading(true, "正在提取地点...");
    try {
      const extracted = await onExtractLocations(post.id);
      if (extracted.length > 0) setLocations(extracted);
    } finally {
      setExtractingLocations(false);
      setLoading(false);
    }
  };

  const addLocation = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (post.id <= 0) return;
    try {
      const location = await addPostLocation(post.id, trimmed);
      setLocations((prev) => {
        if (prev.some((l) => l.id === location.id)) return prev;
        return [location, ...prev];
      });
      setLocationInput("");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "添加地点失败");
    }
  };

  const handleRemoveLocation = async (locationId: number) => {
    if (post.id <= 0) return;
    try {
      await removePostLocation(post.id, locationId);
      setLocations((prev) => prev.filter((l) => l.id !== locationId));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "删除地点失败");
    }
  };

  const handleLocationKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addLocation(locationInput);
    }
  };

  const handleLocationBlur = () => {
    void addLocation(locationInput);
  };

  const addTag = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setTagItems((prev) => Array.from(new Set([...prev, trimmed])));
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    setTagItems((prev) => prev.filter((t) => t !== tag));
  };

  const handleTagKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addTag(tagInput);
    }
  };

  const handleTagBlur = () => {
    addTag(tagInput);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (generating || generatingTags || extractingLocations) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSave();
    }
  };

  return (
    <form className="editor-form" onSubmit={(event) => { event.preventDefault(); void handleSave(); }} onKeyDown={handleKeyDown}>
      <div className="editor-header">
        <input
          className="editor-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="请输入标题..."
          autoFocus
        />
        <div className="editor-actions">
          <button className="post-editor-ai plain" type="button" onClick={handleGenerate} disabled={generating}>
            {generating ? "..." : "AI"}
          </button>
          {onDelete && (
            <button className="danger post-editor-delete plain" type="button" onClick={onDelete} aria-label="删除" title="删除">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="M6 6l1 15h10l1-15" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          )}
          {onExtractLocations && (
            <button type="button" className="editor-extract-locations" onClick={handleExtract} disabled={extractingLocations}>
              <span>📍</span>
              <span>{extractingLocations ? "..." : "提取地点"}</span>
            </button>
          )}
          {onCancel && (
            <button className="secondary post-editor-cancel plain" type="button" onClick={onCancel}>取消</button>
          )}
        </div>
      </div>

      <textarea
        className="editor-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="请输入正文内容..."
      />

      {onExtractLocations && (
        <div className="editor-location-bar">
          <div className="editor-location-list">
            {locations.map((loc) => (
              <span key={loc.id} className="pill pill-location">
                {loc.name}
                <button
                  type="button"
                  className="plain location-remove"
                  onClick={() => handleRemoveLocation(loc.id)}
                  aria-label={`删除 ${loc.name}`}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              className="location-input"
              value={locationInput}
              onChange={(e) => setLocationInput(e.target.value)}
              onKeyDown={handleLocationKeyDown}
              onBlur={handleLocationBlur}
              placeholder={locations.length === 0 ? "添加地点" : ""}
            />
          </div>
        </div>
      )}

      <div className="editor-footer">
        <div className="editor-field">
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            onBlur={() => setCategory((value) => normalizeCategory(value))}
            placeholder="分类"
          />
        </div>
        <div className="editor-field editor-tags">
          <div className="editor-tags-row">
            {tagItems.map((tag) => (
              <span key={tag} className="editor-tag-pill">
                {tag}
                <button type="button" onClick={() => removeTag(tag)} aria-label={`删除 ${tag}`}>×</button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={handleTagBlur}
              placeholder={tagItems.length === 0 ? "标签，回车添加" : ""}
            />
          </div>
          {onGenerateTags && (
            <button className="editor-ai-tags plain" type="button" onClick={handleGenerateTags} disabled={generatingTags} aria-label="生成标签" title="生成标签">
              {generatingTags ? "..." : "AI"}
            </button>
          )}
        </div>
        <div className="editor-field">
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
        <div className="editor-field">
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
        <div className="editor-field">
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
      </div>
    </form>
  );
});

const PostViewEditor = forwardRef<PostViewEditorHandle, {
  post: PostItem;
  onSave: (p: Partial<PostItem> & { updated_at?: string }) => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onGenerateTitle: (body: string, category: string, tags: string) => Promise<string>;
  onGenerateTags?: (body: string, category: string, title: string) => Promise<string>;
  onExtractLocations?: (postId: number) => Promise<LocationItem[]>;
}>(function PostViewEditor(props, ref) {
  const formRef = useRef<EditorFormHandle>(null);
  useImperativeHandle(ref, () => ({
    save: () => formRef.current?.save() || Promise.resolve(),
  }));
  return <EditorForm ref={formRef} {...props} />;
});

function PostEditDialog({
  post,
  onClose,
  onSave,
  onDelete,
  onGenerateTitle,
  onGenerateTags,
  onExtractLocations,
}: {
  post: PostItem | null;
  onClose: () => void;
  onSave: (p: Partial<PostItem> & { updated_at?: string }) => Promise<void> | void;
  onDelete: () => void;
  onGenerateTitle: (body: string, category: string, tags: string) => Promise<string>;
  onGenerateTags?: (body: string, category: string, title: string) => Promise<string>;
  onExtractLocations?: (postId: number) => Promise<LocationItem[]>;
}) {
  const { loading } = useLoading();
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (post) {
      setClosing(false);
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

  if (!post) return null;

  return (
    <dialog
      ref={dialogRef}
      className={`post-dialog${closing ? " closing" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        if (loading) return;
        requestClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          requestClose();
        }
      }}
    >
      <section className="dialog-body post-editor">
        <EditorForm
          post={post}
          onSave={async (payload) => {
            await onSave(payload);
            requestClose();
          }}
          onDelete={onDelete}
          onCancel={post.id > 0 ? undefined : requestClose}
          onGenerateTitle={onGenerateTitle}
          onGenerateTags={onGenerateTags}
          onExtractLocations={onExtractLocations}
        />
      </section>
    </dialog>
  );
}
