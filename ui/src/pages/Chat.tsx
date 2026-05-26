import { useEffect, useMemo, useRef, useState } from "react";
import {
  listPosts,
  listPhotos,
  listChatSessions,
  createChatSession,
  updateChatSession,
  deleteChatSession,
  getChatSession,
  chatStream,
} from "../api";
import type { PostItem, PhotoItem, ChatSessionSummary, ChatMessage } from "../types";
import Select from "../components/Select";
import { useToast } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { currentModel, loadActiveLlmProfile } from "../llmSettings";

function renderMarkdown(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listOpen = false;
  let listType = "";
  const closeList = () => {
    if (listOpen) { html += `</${listType}>`; listOpen = false; listType = ""; }
  };
  const openList = (type: string) => {
    if (listOpen && listType !== type) closeList();
    if (!listOpen) { html += `<${type}>`; listOpen = true; listType = type; }
  };
  const escape = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" } as any)[c]);
  const inline = (v: string) => escape(v).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    const b = line.match(/^[-*]\s+(.+)$/);
    if (b) { openList("ul"); html += `<li>${inline(b[1])}</li>`; continue; }
    const o = line.match(/^\d+\.\s+(.+)$/);
    if (o) { openList("ol"); html += `<li>${inline(o[1])}</li>`; continue; }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

function contextLimitForModel(model: string) {
  const custom = localStorage.getItem("contextLimit");
  if (custom) {
    const parsed = parseInt(custom, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  if (model.includes("gpt-4o") || model.includes("claude-3-5") || model.includes("claude-3-5-sonnet")) return 128000;
  if (model.includes("mimo-v2")) return 262144;
  if (model.includes("gpt-4") || model.includes("claude-3")) return 8192;
  if (model.includes("gpt-3.5") || model.includes("qwen") || model.includes("glm")) return 4096;
  return 4096;
}

function estimateTextTokens(text: string) {
  return Math.ceil(text.length / 3.5);
}

type PostPickerItem =
  | { type: "year"; year: string }
  | { type: "post"; post: PostItem };

function postYear(post: PostItem) {
  const date = new Date(post.updated_at || post.created_at);
  if (Number.isNaN(date.getTime())) return "未注明年份";
  return String(date.getFullYear());
}

const SYSTEM_PROMPT_TOKEN_ESTIMATE = 60;
const IMAGE_TOKEN_ESTIMATE = 512;

function pinChatShell() {
  const pin = () => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.getElementById("chatView")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.querySelector(".chat-panel")?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  };
  pin();
  requestAnimationFrame(pin);
}

export default function ChatPage() {
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatting, setChatting] = useState(false);
  const [input, setInput] = useState("");
  const [freeText, setFreeText] = useState("");
  const [selectedPostIds, setSelectedPostIds] = useState<number[]>([]);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<number[]>([]);
  const [sentPostIds, setSentPostIds] = useState<number[]>([]);
  const [sentPhotoIds, setSentPhotoIds] = useState<number[]>([]);
  const [llmProfile] = useState(() => loadActiveLlmProfile());
  const [chatUsage, setChatUsage] = useState({ promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model: "" });
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const { show: showToast, element: toastElement } = useToast();
  const { confirm: confirmDialog, element: confirmElement } = useConfirm();
  const [postsExpanded, setPostsExpanded] = useState(false);
  const [photosExpanded, setPhotosExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const model = currentModel(llmProfile);

  useEffect(() => {
    listPosts().then(setPosts).catch(() => {});
    listPhotos().then(setPhotos).catch(() => {});
    loadSessions();
    pinChatShell();
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      const container = document.querySelector(".chat-messages") as HTMLElement | null;
      if (container) {
        const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
        if (nearBottom) {
          messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
        }
      }
    }
  }, [messages]);

  const loadSessions = async () => {
    try { setSessions(await listChatSessions()); } catch {}
  };

  const handleNewSession = () => {
    setCurrentSessionId(null);
    setMessages([]);
    setSelectedPostIds([]);
    setSelectedPhotoIds([]);
    setSentPostIds([]);
    setSentPhotoIds([]);
    setFreeText("");
    setChatUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model: "" });
    pinChatShell();
  };

  const handleSwitchSession = async (id: number) => {
    try {
      const session = await getChatSession(id);
      setCurrentSessionId(session.id);
      const nextMessages = JSON.parse(session.messages || "[]");
      const nextPostIds = JSON.parse(session.context_post_ids || "[]");
      const nextPhotoIds = JSON.parse(session.context_photo_ids || "[]");
      setMessages(nextMessages);
      setSelectedPostIds(nextPostIds);
      setSelectedPhotoIds(nextPhotoIds);
      setSentPostIds(nextMessages.length > 0 ? nextPostIds : []);
      setSentPhotoIds(nextMessages.length > 0 ? nextPhotoIds : []);
      setFreeText(session.context_free_text || "");
      setChatUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model: "" });
      pinChatShell();
    } catch (err: any) { showToast(err.message); }
  };

  const handleSaveSession = async (msgs: ChatMessage[], contextPostIdsForSave = selectedPostIds, contextPhotoIdsForSave = selectedPhotoIds) => {
    const messagesJson = JSON.stringify(msgs);
    const contextPostIds = JSON.stringify(contextPostIdsForSave);
    const contextPhotoIds = JSON.stringify(contextPhotoIdsForSave);
    const firstUser = msgs.find((m) => m.role === "user");
    const title = sessions.find((s) => s.id === currentSessionId)?.title || (firstUser ? firstUser.content.slice(0, 20) : "新对话");
    try {
      if (currentSessionId) {
        await updateChatSession(currentSessionId, { title, messages: messagesJson, context_post_ids: contextPostIds, context_photo_ids: contextPhotoIds, context_free_text: freeText });
      } else {
        const result = await createChatSession({ title, messages: messagesJson, context_post_ids: contextPostIds, context_photo_ids: contextPhotoIds, context_free_text: freeText });
        setCurrentSessionId(result.id);
        setSessions((prev) => [{ id: result.id, title, created_at: result.created_at, updated_at: result.updated_at }, ...prev]);
      }
      await loadSessions();
    } catch (err: any) { showToast("保存会话失败: " + err.message); }
  };

  const handleSend = async () => {
    const content = input.trim();
    if (!content) { showToast("请输入对话内容"); return; }
    if (!llmProfile.apiKey.trim() || !model.trim()) { showToast("先在 LLM 设置里填写 API Key 和模型"); return; }

    const newMsgs: ChatMessage[] = [...messages, { role: "user", content }];
    const outgoingPostIds = [...selectedPostIds];
    const outgoingPhotoIds = [...selectedPhotoIds];
    setMessages(newMsgs);
    setInput("");
    setChatting(true);

    let assistantContent = "";

    try {
      await chatStream({
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl,
        model,
        provider: llmProfile.providerId || undefined,
        post_ids: outgoingPostIds,
        photo_ids: outgoingPhotoIds,
        free_text: freeText || undefined,
        messages: newMsgs,
      }, (delta) => {
        assistantContent += delta;
        setMessages((prev) => {
          const next = [...prev];
          if (next.length > 0 && next[next.length - 1].role === "assistant") {
            next[next.length - 1] = { role: "assistant", content: assistantContent };
          } else {
            next.push({ role: "assistant", content: assistantContent });
          }
          return next;
        });
      });

      const assistantMsgs: ChatMessage[] = [...newMsgs, { role: "assistant", content: assistantContent }];
      const nextSentPostIds = Array.from(new Set([...sentPostIds, ...outgoingPostIds]));
      const nextSentPhotoIds = Array.from(new Set([...sentPhotoIds, ...outgoingPhotoIds]));
      setMessages(assistantMsgs);
      setSelectedPostIds((prev) => Array.from(new Set([...prev, ...outgoingPostIds])));
      setSelectedPhotoIds((prev) => Array.from(new Set([...prev, ...outgoingPhotoIds])));
      setSentPostIds(nextSentPostIds);
      setSentPhotoIds(nextSentPhotoIds);
      setChatUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model });
      await handleSaveSession(assistantMsgs, nextSentPostIds, nextSentPhotoIds);
    } catch (err: any) {
      showToast(err.message);
      setMessages((prev) => {
        const next = [...prev];
        if (next.length > 0 && next[next.length - 1].role === "assistant") {
          next[next.length - 1] = { role: "assistant", content: assistantContent || "生成失败" };
        }
        return next;
      });
    } finally {
      setChatting(false);
    }
  };

  const handleRename = async () => {
    if (!currentSessionId || !renameTitle.trim()) return;
    try {
      await updateChatSession(currentSessionId, { title: renameTitle.trim() });
      setSessions((prev) => prev.map((s) => s.id === currentSessionId ? { ...s, title: renameTitle.trim() } : s));
      setRenameOpen(false);
      showToast("会话已重命名");
    } catch (err: any) { showToast(err.message); }
  };

  const handleDeleteSession = async () => {
    if (!currentSessionId) return;
    if (!(await confirmDialog("确定删除这个会话？"))) return;
    try {
      await deleteChatSession(currentSessionId);
      setSessions((prev) => prev.filter((s) => s.id !== currentSessionId));
      handleNewSession();
    } catch (err: any) { showToast(err.message); }
  };

  const estimatedTokens = useMemo(() => {
    if (!model) return 0;
    let total = SYSTEM_PROMPT_TOKEN_ESTIMATE;
    if (freeText) total += estimateTextTokens(freeText) + 12;
    for (const id of selectedPostIds) {
      const post = posts.find((p) => p.id === id);
      if (post) total += estimateTextTokens(post.title) + estimateTextTokens(post.body) + 24;
    }
    total += selectedPhotoIds.length * IMAGE_TOKEN_ESTIMATE;
    for (const msg of messages) total += estimateTextTokens(msg.content) + 8;
    total += estimateTextTokens(input);
    return total;
  }, [model, freeText, selectedPostIds, selectedPhotoIds, posts, messages, input]);

  const limit = contextLimitForModel(model);
  const used = chatUsage.confirmed && chatUsage.model === model ? Math.max(chatUsage.totalTokens, estimatedTokens) : estimatedTokens;
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
  const tokenState = ratio > 0.95 ? "danger" : ratio > 0.8 ? "warn" : "safe";

  const contextSummary = useMemo(() => {
    const parts: string[] = [];
    for (const id of selectedPostIds) {
      const post = posts.find((p) => p.id === id);
      if (post) parts.push(`📄 ${post.title}`);
    }
    for (const id of selectedPhotoIds) {
      const photo = photos.find((p) => p.id === id);
      if (photo) parts.push(`🖼️ ${photo.title || photo.original_name}`);
    }
    if (freeText) parts.push("📝 指定片段");
    return parts;
  }, [selectedPostIds, selectedPhotoIds, posts, photos, freeText]);
  const groupedPostPickerItems = useMemo<PostPickerItem[]>(() => {
    const items: PostPickerItem[] = [];
    let currentYear = "";
    for (const post of posts) {
      const year = postYear(post);
      if (year !== currentYear) {
        items.push({ type: "year", year });
        currentYear = year;
      }
      items.push({ type: "post", post });
    }
    return items;
  }, [posts]);
  const allPostsSelected = posts.length > 0 && posts.every((post) => selectedPostIds.includes(post.id));
  const allPhotosSelected = photos.length > 0 && photos.every((photo) => selectedPhotoIds.includes(photo.id));
  const togglePostSelection = (postId: number, checked: boolean) => {
    if (!checked && sentPostIds.includes(postId)) return;
    setSelectedPostIds((prev) => checked ? Array.from(new Set([...prev, postId])) : prev.filter((id) => id !== postId));
  };
  const togglePhotoSelection = (photoId: number, checked: boolean) => {
    if (!checked && sentPhotoIds.includes(photoId)) return;
    setSelectedPhotoIds((prev) => checked ? Array.from(new Set([...prev, photoId])) : prev.filter((id) => id !== photoId));
  };
  const toggleAllPosts = () => {
    setSelectedPostIds((prev) => {
      const sent = prev.filter((id) => sentPostIds.includes(id));
      return allPostsSelected ? sent : Array.from(new Set([...sent, ...posts.map((p) => p.id)]));
    });
  };
  const toggleAllPhotos = () => {
    setSelectedPhotoIds((prev) => {
      const sent = prev.filter((id) => sentPhotoIds.includes(id));
      return allPhotosSelected ? sent : Array.from(new Set([...sent, ...photos.map((p) => p.id)]));
    });
  };

  return (
    <section className="view active" id="chatView">
      <div className="chat-layout">
        <section className="chat-context">
          <h2>对话上下文</h2>
          <div className="field chat-free-field">
            <label>指定片段</label>
            <textarea placeholder="可补充本次对话的临时上下文" rows={5} value={freeText} onChange={(e) => setFreeText(e.target.value)} />
          </div>

          <div className="chat-picker-section">
            <div className="chat-picker-head">
              <h3>选择文字</h3>
              <div>
                <button
                  type="button"
                  className="small-button"
                  disabled={posts.length === 0}
                  onClick={toggleAllPosts}
                >
                  {allPostsSelected ? "清空" : "全选"}
                </button>
                <button type="button" className="small-button" onClick={() => setPostsExpanded((value) => !value)}>
                  {postsExpanded ? "收起" : "展开"}
                </button>
              </div>
            </div>
            <div className={`check-list chat-check-list ${postsExpanded ? "expanded" : ""}`}>
              {posts.length === 0 && <div className="empty compact">暂无文字</div>}
              {groupedPostPickerItems.map((item) => (
                item.type === "year" ? (
                  <div key={`year-${item.year}`} className="check-year-divider" aria-hidden="true">
                    {item.year}
                  </div>
                ) : (
                  <label key={item.post.id} className="check-item">
                    <input
                      type="checkbox"
                      checked={selectedPostIds.includes(item.post.id)}
                      disabled={sentPostIds.includes(item.post.id)}
                      onChange={(e) => {
                        togglePostSelection(item.post.id, e.target.checked);
                      }}
                    />
                    <span>{kindName(item.post.kind)} · {item.post.title}</span>
                  </label>
                )
              ))}
            </div>
          </div>

          <div className="chat-picker-section">
            <div className="chat-picker-head">
              <h3>选择照片</h3>
              <div>
                <button
                  type="button"
                  className="small-button"
                  disabled={photos.length === 0}
                  onClick={toggleAllPhotos}
                >
                  {allPhotosSelected ? "清空" : "全选"}
                </button>
                <button type="button" className="small-button" onClick={() => setPhotosExpanded((value) => !value)}>
                  {photosExpanded ? "收起" : "展开"}
                </button>
              </div>
            </div>
            <div className={`check-list chat-check-list photo-check-list ${photosExpanded ? "expanded" : ""}`}>
              {photos.length === 0 && <div className="empty compact">暂无照片</div>}
              {photos.map((photo) => (
                <label key={photo.id} className="check-item">
                  <input
                    type="checkbox"
                    checked={selectedPhotoIds.includes(photo.id)}
                    disabled={sentPhotoIds.includes(photo.id)}
                    onChange={(e) => {
                      togglePhotoSelection(photo.id, e.target.checked);
                    }}
                  />
                  <img src={photo.thumbnail_url || photo.url} alt="" className="check-thumb" loading="lazy" />
                  <span>{photo.title || photo.original_name}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="chat-panel">
          <div className="chat-toolbar">
            <Select
              value={currentSessionId ? String(currentSessionId) : ""}
              ariaLabel="会话"
              onChange={(value) => {
                const id = Number(value);
                if (id) handleSwitchSession(id); else handleNewSession();
              }}
              options={[
                { value: "", label: "新对话" },
                ...sessions.map((s) => ({ value: String(s.id), label: s.title })),
              ]}
            />
            <button disabled={!currentSessionId} onClick={() => { const s = sessions.find((x) => x.id === currentSessionId); setRenameTitle(s?.title || ""); setRenameOpen(true); }}>重命名</button>
            <button disabled={!currentSessionId} onClick={handleDeleteSession}>删除</button>
            <button onClick={handleNewSession}>新对话</button>
          </div>

          <div className="chat-messages">
            {messages.length === 0 && !chatting && <div className="empty compact">选择上下文后开始提问</div>}
            {messages.map((msg, i) => (
              <article key={i} className={`chat-message ${msg.role}`}>
                <div className="chat-avatar">{msg.role === "assistant" ? "AI" : "我"}</div>
                <div className="chat-bubble">
                  <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                </div>
              </article>
            ))}
            {chatting && !(messages.length > 0 && messages[messages.length - 1].role === "assistant" && messages[messages.length - 1].content.trim().length > 0) && (
              <article className="chat-message assistant">
                <div className="chat-avatar">AI</div>
                <div className="chat-bubble loading">正在输入...</div>
              </article>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="chat-form" onSubmit={(e) => e.preventDefault()}>
            <div className="context-summary chat-context-bar">
              {contextSummary.map((c, i) => <span key={i} className="pill">{c}</span>)}
            </div>
            <div className="chat-token-meter" data-state={tokenState}>
              <div className="token-meter-head">
                <span className="token-meter-label">上下文</span>
                <span className="token-meter-numbers"><span className="token-meter-used">{used}</span><span className="token-meter-sep"> / </span><span className="token-meter-limit">{limit >= 1000000 ? `${(limit / 1000000).toFixed(2)}M` : limit}</span></span>
                <span className="token-meter-percent">{(ratio * 100).toFixed(2)}%</span>
                <span className="token-meter-source">{chatUsage.confirmed && chatUsage.model === model ? "实际" : "估算"}</span>
              </div>
              <div className="token-meter-track"><div className="token-meter-fill" style={{ width: `${Math.max(ratio * 100, used > 0 ? 1.5 : 0)}%` }} /></div>
            </div>
            <textarea
              className="chat-input"
              placeholder="基于选中的内容提问"
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (e.shiftKey) {
                  e.stopPropagation();
                  return;
                }
                e.preventDefault();
                handleSend();
              }}
            />
          </form>
        </section>
      </div>

      {renameOpen && (
        <dialog open className="rename-dialog">
          <section className="dialog-body">
            <h3>重命名会话</h3>
            <input value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} autoFocus />
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setRenameOpen(false)}>取消</button>
              <button className="primary" onClick={handleRename}>保存</button>
            </div>
          </section>
        </dialog>
      )}

      {confirmElement}
      {toastElement}
    </section>
  );
}

function kindName(kind: string) {
  return { article: "文章", thought: "想法", note: "随手写" }[kind] || kind;
}
