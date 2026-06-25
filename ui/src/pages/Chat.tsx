import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  listPosts,
  listPhotos,
  listChatSessions,
  createChatSession,
  updateChatSession,
  deleteChatSession,
  getChatSession,
  chatStream,
  extractMemories,
  listMemories,
  listMemoryExtractionSources,
} from "../api";
import type { PostItem, PhotoItem, ChatSessionSummary, ChatMessage, MemoryItem, MemoryRecallMeta } from "../types";
import Select from "../components/Select";
import { useToast } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { currentModel, loadActiveLlmProfile, requestProvider } from "../llmSettings";
import { loadEmbeddingSettings } from "../embeddingSettings";
import { PostViewDialog } from "./Posts";

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

type ContextSummaryItem =
  | { type: "post"; id: number; label: string; extracted: boolean }
  | { type: "photo"; id: number; label: string; extracted: boolean }
  | { type: "text"; label: string };

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
  const [embeddingSettings] = useState(() => loadEmbeddingSettings());
  const [chatUsage, setChatUsage] = useState({ promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model: "" });
  const [useMemory, setUseMemory] = useState(true);
  const [activeMemories, setActiveMemories] = useState<MemoryItem[]>([]);
  const [memoryRecall, setMemoryRecall] = useState<MemoryRecallMeta>({ domains: 0, topics: 0, memories: 0, estimated_tokens: 0, semantic: false });
  const [extractingMemory, setExtractingMemory] = useState(false);
  const [selectedMemoryTurns, setSelectedMemoryTurns] = useState<number[]>([]);
  const [extractedSources, setExtractedSources] = useState<{ post_ids: number[]; photo_ids: number[] }>({ post_ids: [], photo_ids: [] });
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [previewPost, setPreviewPost] = useState<PostItem | null>(null);
  const { show: showToast, element: toastElement } = useToast();
  const { confirm: confirmDialog, element: confirmElement } = useConfirm();
  const [postsExpanded, setPostsExpanded] = useState(false);
  const [photosExpanded, setPhotosExpanded] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  const model = currentModel(llmProfile);

  useEffect(() => {
    listPosts().then(setPosts).catch(() => {});
    listPhotos().then(setPhotos).catch(() => {});
    listMemories().then((items) => setActiveMemories(items.filter((item) => item.status === "active"))).catch(() => {});
    listMemoryExtractionSources().then(setExtractedSources).catch(() => {});
    loadSessions();
    pinChatShell();
  }, []);

  useLayoutEffect(() => {
    if (shouldStickToBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    }
  }, [messages]);

  const loadSessions = async () => {
    try { setSessions(await listChatSessions()); } catch {}
  };

  const handleNewSession = () => {
    shouldStickToBottomRef.current = true;
    setCurrentSessionId(null);
    setMessages([]);
    setSelectedPostIds([]);
    setSelectedPhotoIds([]);
    setSentPostIds([]);
    setSentPhotoIds([]);
    setFreeText("");
    setChatUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model: "" });
    setUseMemory(true);
    setMemoryRecall({ domains: 0, topics: 0, memories: 0, estimated_tokens: 0, semantic: false });
    setSelectedMemoryTurns([]);
    pinChatShell();
  };

  const handleSwitchSession = async (id: number) => {
    try {
      shouldStickToBottomRef.current = true;
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
      setUseMemory(session.use_memory !== false);
      setMemoryRecall({ domains: 0, topics: 0, memories: 0, estimated_tokens: 0, semantic: false });
      setSelectedMemoryTurns([]);
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
        await updateChatSession(currentSessionId, { title, messages: messagesJson, context_post_ids: contextPostIds, context_photo_ids: contextPhotoIds, context_free_text: freeText, use_memory: useMemory });
      } else {
        const result = await createChatSession({ title, messages: messagesJson, context_post_ids: contextPostIds, context_photo_ids: contextPhotoIds, context_free_text: freeText, use_memory: useMemory });
        setCurrentSessionId(result.id);
        setSessions((prev) => [{ id: result.id, title, created_at: result.created_at, updated_at: result.updated_at }, ...prev]);
      }
      await loadSessions();
    } catch (err: any) { showToast("保存会话失败: " + err.message); }
  };

  const handleSend = async () => {
    const content = input.trim();
    if (!content) { showToast("请输入对话内容"); return; }
    if (!model.trim()) { showToast("先在 LLM 设置里填写模型"); return; }

    const newMsgs: ChatMessage[] = [...messages, { role: "user", content }];
    const outgoingPostIds = [...selectedPostIds];
    const outgoingPhotoIds = [...selectedPhotoIds];
    shouldStickToBottomRef.current = true;
    setMessages(newMsgs);
    setInput("");
    setChatting(true);
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    let assistantContent = "";

    try {
      const memoryBudget = Math.max(400, Math.min(4000, Math.floor(contextLimitForModel(model) * 0.15)));
      const semanticMemoryEnabled = Boolean(
        embeddingSettings.baseUrl.trim()
        && embeddingSettings.model.trim(),
      );
      await chatStream({
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl,
        model,
        provider: requestProvider(llmProfile),
        post_ids: outgoingPostIds,
        photo_ids: outgoingPhotoIds,
        free_text: freeText || undefined,
        messages: newMsgs,
        use_memory: useMemory,
        memory_budget_tokens: memoryBudget,
        embedding_model: semanticMemoryEnabled ? embeddingSettings.model.trim() : undefined,
        embedding_api_key: semanticMemoryEnabled ? embeddingSettings.apiKey.trim() : undefined,
        embedding_base_url: semanticMemoryEnabled ? embeddingSettings.baseUrl.trim() : undefined,
        embedding_provider: semanticMemoryEnabled ? embeddingSettings.providerId : undefined,
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
      }, setMemoryRecall, abortControllerRef.current.signal);

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
      if (err.name !== "AbortError") {
        showToast(err.message);
      }
      setMessages((prev) => {
        const next = [...prev];
        if (next.length > 0 && next[next.length - 1].role === "assistant") {
          next[next.length - 1] = { role: "assistant", content: assistantContent || (err.name === "AbortError" ? "已停止" : "生成失败") };
        }
        return next;
      });
    } finally {
      setChatting(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
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

  const handleExtractMemory = async () => {
    const hasAttachments = selectedPostIds.length > 0 || selectedPhotoIds.length > 0 || Boolean(freeText.trim());
    if (selectedMemoryTurns.length === 0 && !hasAttachments) {
      showToast("请勾选问答，或先添加文章、照片、指定片段");
      return;
    }
    if (!model.trim()) {
      showToast("先在 LLM 设置里填写模型");
      return;
    }
    setExtractingMemory(true);
    try {
      const selectedMessages = selectedMemoryTurns.flatMap((userIndex) => {
        const turn = [messages[userIndex]];
        const assistantReply = messages[userIndex + 1];
        if (assistantReply?.role === "assistant") turn.push(assistantReply);
        return turn.filter(Boolean);
      });
      const candidates = await extractMemories({
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl,
        model,
        provider: requestProvider(llmProfile),
        session_id: currentSessionId,
        messages: selectedMessages,
        post_ids: selectedPostIds,
        photo_ids: selectedPhotoIds,
        free_text: freeText.trim() || undefined,
      });
      setExtractedSources((current) => ({
        post_ids: Array.from(new Set([...current.post_ids, ...selectedPostIds])),
        photo_ids: Array.from(new Set([...current.photo_ids, ...selectedPhotoIds])),
      }));
      setSelectedMemoryTurns([]);
      showToast(candidates.length ? `已生成 ${candidates.length} 条待确认记忆` : "没有发现适合长期保存的内容");
    } catch (error: any) {
      listMemoryExtractionSources().then(setExtractedSources).catch(() => {});
      showToast(error.message);
    } finally {
      setExtractingMemory(false);
    }
  };

  const toggleMemoryTurn = (messageIndex: number) => {
    setSelectedMemoryTurns((current) => (
      current.includes(messageIndex)
        ? current.filter((index) => index !== messageIndex)
        : [...current, messageIndex]
    ));
  };
  const hasMemoryExtractionAttachments = selectedPostIds.length > 0
    || selectedPhotoIds.length > 0
    || Boolean(freeText.trim());

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
    if (useMemory) {
      total += memoryRecall.estimated_tokens || activeMemories.reduce((sum, item) => sum + estimateTextTokens(item.content) + 8, 0);
    }
    total += estimateTextTokens(input);
    return total;
  }, [model, freeText, selectedPostIds, selectedPhotoIds, posts, messages, input, useMemory, memoryRecall, activeMemories]);

  const limit = contextLimitForModel(model);
  const used = chatUsage.confirmed && chatUsage.model === model ? Math.max(chatUsage.totalTokens, estimatedTokens) : estimatedTokens;
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
  const tokenState = ratio > 0.95 ? "danger" : ratio > 0.8 ? "warn" : "safe";
  const tokenColor = tokenState === "danger" ? "bg-red-500" : tokenState === "warn" ? "bg-amber-500" : "bg-[#2f7d79]";

  const contextSummary = useMemo(() => {
    const parts: ContextSummaryItem[] = [];
    for (const id of selectedPostIds) {
      const post = posts.find((p) => p.id === id);
      if (post) parts.push({ type: "post", id, label: post.title, extracted: extractedSources.post_ids.includes(id) });
    }
    for (const id of selectedPhotoIds) {
      const photo = photos.find((p) => p.id === id);
      if (photo) parts.push({ type: "photo", id, label: photo.title || photo.original_name, extracted: extractedSources.photo_ids.includes(id) });
    }
    if (freeText) parts.push({ type: "text", label: "指定片段" });
    return parts;
  }, [selectedPostIds, selectedPhotoIds, posts, photos, freeText, extractedSources]);
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
    <section className="view active bg-[#F8F9FA]" id="chatView">
      <div className="mx-auto grid h-full w-full grid-cols-[minmax(320px,0.9fr)_minmax(0,1.1fr)] gap-6">
        {/* Left sidebar */}
        <section className="flex h-full flex-col gap-5 overflow-hidden rounded-3xl border border-black/[0.04] bg-white/70 p-5 shadow-sm backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-[#1A1A1A]">对话上下文</h2>
            <div className="flex items-center gap-2 rounded-full border border-black/[0.06] bg-white/60 p-1">
              <label className="relative flex cursor-pointer items-center gap-2 rounded-full px-2 py-1.5 text-[13px] font-medium text-[#4A4A4A] hover:bg-black/[0.03] transition-colors" title="开启后，聊天会按当前问题召回已确认的记忆作为背景资料">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={useMemory}
                  onChange={(event) => {
                    setUseMemory(event.target.checked);
                    if (currentSessionId) {
                      updateChatSession(currentSessionId, { use_memory: event.target.checked }).catch((error) => showToast(error.message));
                    }
                  }}
                />
                <span className="h-[18px] w-8 rounded-full bg-[#E5E5EA] transition-colors peer-checked:bg-[#2f7d79] relative"><span className="absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-[14px]" /></span>
                <span>使用记忆</span>
              </label>
              <button
                className="plain rounded-full px-3 py-1.5 text-[13px] font-medium text-[#4A4A4A] transition-colors hover:bg-black/[0.03] disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={extractingMemory || (selectedMemoryTurns.length === 0 && !hasMemoryExtractionAttachments)}
                onClick={handleExtractMemory}
              >
                {extractingMemory
                  ? "提取中..."
                  : selectedMemoryTurns.length > 0
                    ? `提取已选 ${selectedMemoryTurns.length}${hasMemoryExtractionAttachments ? " + 附件" : ""}`
                    : "提取附件"}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[13px] font-medium text-[#8E8E93]">指定片段</label>
            <textarea
              className="min-h-[96px] w-full resize-none rounded-2xl border border-black/[0.06] bg-white/60 p-3.5 text-[15px] leading-relaxed text-[#1A1A1A] placeholder:text-[#8E8E93] focus:border-[#2f7d79]/40 focus:bg-white focus:outline-none focus:ring-4 focus:ring-[#2f7d79]/10 transition-all"
              placeholder="可补充本次对话的临时上下文"
              rows={4}
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
            />
          </div>

          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[15px] font-semibold text-[#1A1A1A]">选择文字</h3>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="plain rounded-lg px-2.5 py-1 text-[13px] font-medium text-[#8E8E93] transition-colors hover:bg-black/[0.04] hover:text-[#4A4A4A] disabled:opacity-40"
                  disabled={posts.length === 0}
                  onClick={toggleAllPosts}
                >
                  {allPostsSelected ? "清空" : "全选"}
                </button>
                <button type="button" className="plain rounded-lg px-2.5 py-1 text-[13px] font-medium text-[#8E8E93] transition-colors hover:bg-black/[0.04] hover:text-[#4A4A4A]" onClick={() => setPostsExpanded((value) => !value)}>
                  {postsExpanded ? "收起" : "展开"}
                </button>
              </div>
            </div>
            <div className={`w-full flex min-h-0 flex-col gap-1 overflow-y-auto rounded-2xl border border-black/[0.05] bg-white/50 p-3 transition-all ${postsExpanded ? "flex-1" : "max-h-[180px]"}`}>
              {posts.length === 0 && <div className="py-6 text-center text-[13px] font-medium text-[#8E8E93]">暂无文字</div>}
              {groupedPostPickerItems.map((item) => (
                item.type === "year" ? (
                  <div key={`year-${item.year}`} className="w-full pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-[#8E8E93]/80" aria-hidden="true">
                    {item.year}
                  </div>
                ) : (
                  <div key={item.post.id} className="group relative flex w-full items-center rounded-xl px-2 py-2 transition-colors hover:bg-black/[0.03]">
                    <input
                      type="checkbox"
                      className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded border-[#C7C7CC] text-[#2f7d79] opacity-0 transition-opacity group-hover:opacity-100 focus:ring-[#2f7d79]/20 checked:opacity-100 disabled:opacity-30"
                      aria-label={`选择${item.post.title}`}
                      checked={selectedPostIds.includes(item.post.id)}
                      disabled={sentPostIds.includes(item.post.id)}
                      onChange={(e) => {
                        togglePostSelection(item.post.id, e.target.checked);
                      }}
                    />
                    <button
                      type="button"
                      className="plain ml-7 min-w-0 flex-1 rounded-lg px-1 py-1 text-left text-[14px] leading-snug text-[#4A4A4A] transition-colors hover:text-[#1A1A1A]"
                      title="选择/取消选择"
                      onClick={() => togglePostSelection(item.post.id, !selectedPostIds.includes(item.post.id))}
                    >
                      <span className="block truncate font-medium text-[#1A1A1A]">{item.post.title}</span>
                      <span className="block text-[12px] text-[#8E8E93]">{kindName(item.post.kind)} · {postYear(item.post)}</span>
                    </button>
                  </div>
                )
              ))}
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[15px] font-semibold text-[#1A1A1A]">选择照片</h3>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="plain rounded-lg px-2.5 py-1 text-[13px] font-medium text-[#8E8E93] transition-colors hover:bg-black/[0.04] hover:text-[#4A4A4A] disabled:opacity-40"
                  disabled={photos.length === 0}
                  onClick={toggleAllPhotos}
                >
                  {allPhotosSelected ? "清空" : "全选"}
                </button>
                <button type="button" className="plain rounded-lg px-2.5 py-1 text-[13px] font-medium text-[#8E8E93] transition-colors hover:bg-black/[0.04] hover:text-[#4A4A4A]" onClick={() => setPhotosExpanded((value) => !value)}>
                  {photosExpanded ? "收起" : "展开"}
                </button>
              </div>
            </div>
            <div className={`w-full flex min-h-0 flex-col gap-1 overflow-y-auto rounded-2xl border border-black/[0.05] bg-white/50 p-3 transition-all ${photosExpanded ? "flex-1" : "max-h-[180px]"}`}>
              {photos.length === 0 && <div className="py-6 text-center text-[13px] font-medium text-[#8E8E93]">暂无照片</div>}
              {photos.map((photo) => (
                <label key={photo.id} className="group relative flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-black/[0.03]">
                  <input
                    type="checkbox"
                    className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded border-[#C7C7CC] text-[#2f7d79] opacity-0 transition-opacity group-hover:opacity-100 focus:ring-[#2f7d79]/20 checked:opacity-100 disabled:opacity-30"
                    checked={selectedPhotoIds.includes(photo.id)}
                    disabled={sentPhotoIds.includes(photo.id)}
                    onChange={(e) => {
                      togglePhotoSelection(photo.id, e.target.checked);
                    }}
                  />
                  <img src={photo.thumbnail_url || photo.url} alt="" className="ml-7 h-9 w-9 flex-shrink-0 rounded-lg object-cover" loading="lazy" />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-[#4A4A4A]">{photo.title || photo.original_name}</span>
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* Right panel */}
        <section className="chat-panel relative flex h-full flex-col overflow-hidden rounded-3xl border border-black/[0.04] bg-white/60 shadow-sm backdrop-blur-xl">
          <div className="flex items-center gap-3 border-b border-black/[0.04] px-5 py-3">
            <div className="min-w-0 flex-1">
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
            </div>
            <div className="flex items-center gap-1.5">
              <button className="plain rounded-lg px-3 py-2 text-[13px] font-medium text-[#4A4A4A] transition-colors hover:bg-black/[0.04] disabled:opacity-40" disabled={!currentSessionId} onClick={() => { const s = sessions.find((x) => x.id === currentSessionId); setRenameTitle(s?.title || ""); setRenameOpen(true); }}>重命名</button>
              <button className="plain rounded-lg px-3 py-2 text-[13px] font-medium text-[#4A4A4A] transition-colors hover:bg-black/[0.04] disabled:opacity-40" disabled={!currentSessionId} onClick={handleDeleteSession}>删除</button>
              <button className="plain rounded-lg bg-[#1A1A1A] px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-black/80" onClick={handleNewSession}>新对话</button>
            </div>
          </div>

          <div
            className="chat-messages relative flex-1 overflow-y-auto px-5 py-5"
            ref={messagesRef}
            onScroll={() => {
              const container = messagesRef.current;
              if (!container) return;
              const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
              shouldStickToBottomRef.current = distanceFromBottom < 48;
            }}
          >
            {messages.length === 0 && !chatting && (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <div className="mb-3 text-4xl">✨</div>
                <p className="text-[15px] font-medium text-[#8E8E93]">选择上下文后开始提问</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <article key={i} className={`mb-6 flex ${msg.role === "user" ? "flex-row-reverse" : "flex-row"} items-start gap-3`}>
                <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${msg.role === "assistant" ? "bg-[#326f88]" : "bg-[#2f7d79]"}`}>
                  {msg.role === "assistant" ? "AI" : "我"}
                </div>
                <div className={`flex min-w-0 flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[85%]`}>
                  {msg.role === "user" ? (
                    <div
                      className={`group relative rounded-2xl rounded-tr-sm bg-[#F2F2F7] px-4 py-3 text-[15px] leading-relaxed text-[#1A1A1A] cursor-pointer ${selectedMemoryTurns.includes(i) ? "ring-2 ring-[#2f7d79]/20" : ""}`}
                      title="双击选中此问答以提取记忆"
                      onDoubleClick={() => toggleMemoryTurn(i)}
                    >
                      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                      {selectedMemoryTurns.includes(i) && (
                        <span className="absolute -left-1.5 -top-1.5 h-2.5 w-2.5 rounded-full bg-[#2f7d79] ring-2 ring-white" aria-hidden="true" />
                      )}
                    </div>
                  ) : (
                    <div className="markdown w-full text-[15px] leading-7 text-[#1A1A1A]">
                      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                    </div>
                  )}
                </div>
              </article>
            ))}
            {chatting && !(messages.length > 0 && messages[messages.length - 1].role === "assistant" && messages[messages.length - 1].content.trim().length > 0) && (
              <article className="mb-6 flex flex-row items-start gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#326f88] text-[11px] font-bold text-white">AI</div>
                <div className="mt-1.5 text-[14px] text-[#8E8E93]">正在输入...</div>
              </article>
            )}
            <div ref={messagesEndRef} />
            <div className="sticky bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white/60 to-transparent pointer-events-none" />
          </div>

          <form className="relative z-10 flex flex-col gap-2 px-5 pt-0 pb-3" onSubmit={(e) => e.preventDefault()}>
            {/* Context attachments + token meter above input box */}
            <div className="flex flex-col gap-2 px-1">
              {(contextSummary.length > 0 || useMemory) && (
                <div className="flex flex-nowrap gap-1.5 overflow-x-auto pb-1 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
                  {contextSummary.map((item) => item.type === "post" ? (
                    <button
                      key={`post-${item.id}`}
                      type="button"
                      className={`plain inline-flex max-w-[200px] items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors ${item.extracted ? "border-[#2f7d79]/30 bg-[#2f7d79]/8 text-[#1f605e]" : "border-black/[0.06] bg-black/[0.03] text-[#4A4A4A] hover:bg-black/[0.05]"}`}
                      title={item.extracted ? "预览文章 · 已提取记忆" : "预览文章"}
                      onClick={() => setPreviewPost(posts.find((post) => post.id === item.id) || null)}
                    >
                      <span className="truncate">{item.label}</span>
                      {item.extracted && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#2f7d79]" />}
                    </button>
                  ) : (
                    <span
                      key={`${item.type}-${item.type === "photo" ? item.id : item.label}`}
                      className={`inline-flex max-w-[200px] items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] ${item.type === "photo" && item.extracted ? "border-[#2f7d79]/30 bg-[#2f7d79]/8 text-[#1f605e]" : "border-black/[0.06] bg-black/[0.03] text-[#4A4A4A]"}`}
                      title={item.type === "photo" && item.extracted ? "已提取记忆" : undefined}
                    >
                      <span className="truncate">{item.label}</span>
                      {item.type === "photo" && item.extracted && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#2f7d79]" />}
                    </span>
                  ))}
                  {useMemory && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-[#2f7d79]/20 bg-[#2f7d79]/8 px-2.5 py-1 text-[12px] text-[#1f605e]">
                      长期记忆 · {memoryRecall.memories} 条
                      {memoryRecall.mode ? ` · ${memoryRecall.mode}` : memoryRecall.semantic ? " · 语义" : " · 关键词"}
                      {memoryRecall.depth ? ` · ${memoryRecall.depth}` : ""}
                      {(memoryRecall.expanded_node_ids?.length || 0) > 0 ? ` · 联想 ${memoryRecall.expanded_node_ids?.length}` : ""}
                      {memoryRecall.planned ? " · 已规划" : ""}
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-nowrap items-center justify-end gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.08]">
                  <div className={`h-full ${tokenColor} transition-all duration-300`} style={{ width: `${Math.max(ratio * 100, used > 0 ? 1.5 : 0)}%` }} />
                </div>
                <span className="whitespace-nowrap text-[11px] font-medium text-[#8E8E93]">
                  <span className="text-[#1A1A1A]">{used}</span> / {limit >= 1000000 ? `${(limit / 1000000).toFixed(2)}M` : limit} · {(ratio * 100).toFixed(2)}%
                </span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${chatUsage.confirmed && chatUsage.model === model ? "bg-[#2f7d79]/10 text-[#1f605e]" : "bg-black/[0.04] text-[#8E8E93]"}`}>
                  {chatUsage.confirmed && chatUsage.model === model ? "实际" : "估算"}
                </span>
              </div>
            </div>

            {/* Floating input box */}
            <div className="relative">
              <textarea
                className="min-h-[96px] w-full resize-none rounded-2xl bg-white px-4 py-3.5 pr-12 text-[15px] leading-relaxed text-[#1A1A1A] placeholder:text-[#8E8E93] shadow-sm focus:outline-none transition-all"
                placeholder="基于选中的内容提问"
                rows={3}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (e.nativeEvent.isComposing) return;
                  if (e.shiftKey) {
                    e.stopPropagation();
                    return;
                  }
                  e.preventDefault();
                  handleSend();
                }}
              />
              {chatting ? (
                <button
                  type="button"
                  className="plain absolute right-3 bottom-3 flex h-8 w-8 items-center justify-center rounded-full bg-[#1A1A1A] text-white shadow-sm transition-transform hover:scale-105 active:scale-95"
                  onClick={handleStop}
                  aria-label="停止"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="plain absolute right-3 bottom-3 flex h-8 w-8 items-center justify-center rounded-full bg-[#1A1A1A] text-white shadow-sm transition-transform hover:scale-105 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
                  disabled={!input.trim()}
                  onClick={handleSend}
                  aria-label="发送"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                </button>
              )}
            </div>
          </form>
        </section>
      </div>

      <PostViewDialog post={previewPost} onClose={() => setPreviewPost(null)} />

      {renameOpen && (
        <dialog
          open
          className="rename-dialog"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setRenameOpen(false);
            }
          }}
        >          <section className="dialog-body">
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
