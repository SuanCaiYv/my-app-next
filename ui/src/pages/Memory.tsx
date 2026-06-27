import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  createMemory,
  deleteMemory,
  deleteMemorySummary,
  generateMemorySummary,
  listMemories,
  listMemorySummaries,
  updateMemory,
  updateMemorySummary,
  previewMemoryRecall,
  listMemoryRecallEvents,
} from "../api";
import { currentModel, loadActiveLlmProfile, requestProvider, type LlmProfile } from "../llmSettings";
import type { MemoryItem, MemorySummaryItem, MemoryRecallEvent, MemoryRecallPreview } from "../types";
import Select from "../components/Select";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { formatDateTimeText, parseDateTimeText } from "../utils/dateTime";

const memoryStatusLabels: Record<string, string> = {
  pending: "待确认",
  active: "有效",
  disabled: "已停用",
  superseded: "历史版本",
};

const relationLabels: Record<string, string> = {
  new: "新增",
  duplicate: "重复",
  reinforce: "再次确认",
  update: "更新",
  conflict: "冲突",
};

function parseCueDraft(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf(":");
    return separator > 0
      ? { cue_type: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim(), specificity: 0.7 }
      : { cue_type: "topic", value: line, specificity: 0.5 };
  }).filter((cue) => cue.value);
}

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function formatDateOnly(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function formatMemoryInput(value: string) {
  return isDateOnly(value) ? formatDateOnly(value) : formatDateTimeText(value);
}

function parseMemoryTime(value: string) {
  const parsed = parseDateTimeText(value);
  if (!parsed) return null;
  const parts = value.match(/\d+/g) || [];
  if (parts.length <= 3) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, "0");
    const day = String(parsed.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return parsed.toISOString();
}

function formatMemoryTime(value: string) {
  if (isDateOnly(value)) return formatDateOnly(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [summaries, setSummaries] = useState<MemorySummaryItem[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [topic, setTopic] = useState("");
  const [domain, setDomain] = useState("");
  const [draft, setDraft] = useState({
    content: "",
    topic: "",
    domain: "",
    kind: "fact",
    importance: 0.5,
    emotion_weight: 0,
    cues_text: "",
    occurred_at: formatDateTimeText(new Date().toISOString()),
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<MemoryItem | null>(null);
  const [reviewAction, setReviewAction] = useState<"activate" | "replace" | null>(null);
  const [editDraft, setEditDraft] = useState({ content: "", topic: "", domain: "", occurred_at: "", kind: "fact", importance: 0.5, emotion_weight: 0, cues_text: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [summaryKind, setSummaryKind] = useState<"topic" | "domain">("topic");
  const [summaryTitle, setSummaryTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"review" | "network" | "schemas" | "history">("network");
  const [recallQuery, setRecallQuery] = useState("");
  const [recallPreview, setRecallPreview] = useState<MemoryRecallPreview | null>(null);
  const [recallEvents, setRecallEvents] = useState<MemoryRecallEvent[]>([]);
  const [recalling, setRecalling] = useState(false);
  const createDialogRef = useRef<HTMLDialogElement>(null);
  const editDialogRef = useRef<HTMLDialogElement>(null);
  const [llmProfile, setLlmProfile] = useState<LlmProfile | null>(null);
  const { show: showToast, element: toastElement } = useToast();
  const { confirm, element: confirmElement } = useConfirm();

  useEffect(() => {
    loadActiveLlmProfile().then(setLlmProfile).catch(() => {});
  }, []);

  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败";

  const reload = async () => {
    const [nextMemories, nextSummaries, nextEvents] = await Promise.all([
      listMemories(),
      listMemorySummaries(),
      listMemoryRecallEvents(),
    ]);
    setMemories(nextMemories);
    setSummaries(nextSummaries);
    setRecallEvents(nextEvents);
  };

  useEffect(() => {
    void Promise.all([listMemories(), listMemorySummaries(), listMemoryRecallEvents()])
      .then(([nextMemories, nextSummaries, nextEvents]) => {
        setMemories(nextMemories);
        setSummaries(nextSummaries);
        setRecallEvents(nextEvents);
      })
      .catch((error: unknown) => showToast(errorMessage(error)));
  }, [showToast]);

  useEffect(() => {
    const dialog = createDialogRef.current;
    if (!dialog) return;
    if (createOpen && !dialog.open) dialog.showModal();
    if (!createOpen && dialog.open) dialog.close();
  }, [createOpen]);

  useEffect(() => {
    const dialog = editDialogRef.current;
    if (!dialog) return;
    if (editingMemory && !dialog.open) dialog.showModal();
    if (!editingMemory && dialog.open) dialog.close();
  }, [editingMemory]);

  const topics = useMemo(
    () => Array.from(new Set(memories.map((item) => item.topic).filter(Boolean))).sort(),
    [memories],
  );
  const domains = useMemo(
    () => Array.from(new Set(memories.map((item) => item.domain).filter(Boolean))).sort(),
    [memories],
  );
  const topicCounts = useMemo(() => {
    const counts = new Map<string, number>();
    memories.filter((item) => item.status === "active" && item.topic).forEach((item) => {
      counts.set(item.topic, (counts.get(item.topic) || 0) + 1);
    });
    return counts;
  }, [memories]);
  const filtered = memories.filter((item) => {
    const haystack = `${item.content} ${item.topic} ${item.domain}`.toLowerCase();
    const tabMatch = workspaceTab === "review" ? item.status === "pending"
      : workspaceTab === "network" ? item.kind !== "schema"
      : workspaceTab === "schemas" ? item.kind === "schema"
      : false;
    return tabMatch && (!search || haystack.includes(search.toLowerCase()))
      && (!status || item.status === status)
      && (!topic || item.topic === topic)
      && (!domain || item.domain === domain);
  });

  const runRecallPreview = async () => {
    if (!recallQuery.trim()) return;
    setRecalling(true);
    try {
      setRecallPreview(await previewMemoryRecall(recallQuery.trim()));
      setRecallEvents(await listMemoryRecallEvents());
    } catch (error: unknown) { showToast(errorMessage(error)); }
    finally { setRecalling(false); }
  };

  const patchMemory = async (item: MemoryItem, patch: Record<string, unknown>) => {
    try {
      await updateMemory(item.id, patch);
      await reload();
    } catch (error: unknown) {
      showToast(errorMessage(error));
    }
  };

  const openEditMemory = (item: MemoryItem, action: "activate" | "replace" | null = null) => {
    setEditDraft({
      content: item.content,
      topic: item.topic,
      domain: item.domain,
      occurred_at: item.occurred_at ? formatMemoryInput(item.occurred_at) : "",
      kind: item.kind,
      importance: item.importance,
      emotion_weight: item.emotion_weight,
      cues_text: item.cues.map((cue) => `${cue.cue_type}:${cue.value}`).join("\n"),
    });
    setReviewAction(action);
    setEditingMemory(item);
  };

  const saveMemoryEdit = async () => {
    if (!editingMemory || !editDraft.content.trim()) return;
    const occurredAt = parseMemoryTime(editDraft.occurred_at);
    if (!occurredAt) {
      showToast("记忆时间格式无法识别");
      return;
    }
    setSavingEdit(true);
    try {
      await updateMemory(editingMemory.id, {
        content: editDraft.content.trim(),
        topic: editDraft.topic.trim(),
        domain: editDraft.domain.trim(),
        occurred_at: occurredAt,
        kind: editDraft.kind,
        importance: editDraft.importance,
        emotion_weight: editDraft.emotion_weight,
        cues: parseCueDraft(editDraft.cues_text),
        ...(reviewAction ? {
          status: "active",
          ...(reviewAction === "replace" ? { relation: "update" } : {}),
        } : {}),
      });
      setEditingMemory(null);
      setReviewAction(null);
      await reload();
      showToast(reviewAction ? "记忆时间已确认并启用" : "记忆已更新");
    } catch (error: unknown) {
      showToast(errorMessage(error));
    } finally {
      setSavingEdit(false);
    }
  };

  const addMemory = async () => {
    if (!draft.content.trim()) return;
    const occurredAt = parseMemoryTime(draft.occurred_at);
    if (!occurredAt) {
      showToast("记忆时间格式无法识别");
      return;
    }
    try {
      await createMemory({
        ...draft,
        cues: parseCueDraft(draft.cues_text),
        occurred_at: occurredAt,
        status: "active",
      });
      setDraft({
        content: "",
        topic: "",
        domain: "",
        kind: "fact",
        importance: 0.5,
        emotion_weight: 0,
        cues_text: "",
        occurred_at: formatDateTimeText(new Date().toISOString()),
      });
      setCreateOpen(false);
      await reload();
      showToast("记忆已添加");
    } catch (error: unknown) {
      showToast(errorMessage(error));
    }
  };

  const removeMemory = async (item: MemoryItem) => {
    if (!(await confirm("确定删除这条记忆？"))) return;
    try {
      await deleteMemory(item.id);
      await reload();
    } catch (error: unknown) {
      showToast(errorMessage(error));
    }
  };

  const generateSummary = async () => {
    if (!llmProfile) {
      showToast("正在加载 LLM 配置");
      return;
    }
    if (!summaryTitle || !currentModel(llmProfile).trim()) {
      showToast("请选择标签或分类，并先配置 LLM 模型");
      return;
    }
    setBusy(true);
    try {
      await generateMemorySummary({
        api_key: llmProfile.apiKey,
        base_url: llmProfile.baseUrl,
        model: currentModel(llmProfile),
        provider: requestProvider(llmProfile),
        kind: summaryKind,
        title: summaryTitle,
      });
      await reload();
      showToast("摘要候选已生成");
    } catch (error: unknown) {
      showToast(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="view active memory-view">
      <header className="memory-head">
        <div>
          <h1>长期记忆</h1>
          <p>保留稳定事实，按分类和标签整理，在对话中按需召回。</p>
        </div>
        <div className="memory-head-actions">
          <div className="memory-stats" aria-label="记忆统计">
            <span><strong>{memories.filter((item) => item.status === "pending").length}</strong> 待确认</span>
            <span><strong>{memories.filter((item) => item.status === "active").length}</strong> 有效</span>
            <span><strong>{summaries.filter((item) => item.status === "stale").length}</strong> 待整理</span>
          </div>
          <button className="primary memory-add-button" onClick={() => setCreateOpen(true)}>新增记忆</button>
        </div>
      </header>

      <nav className="memory-workspace-tabs" aria-label="记忆工作台">
        {([
          ["review", `待审核 ${memories.filter((item) => item.status === "pending").length}`],
          ["network", "记忆网络"], ["schemas", "巩固图式"], ["history", "召回记录"],
        ] as const).map(([value, label]) => (
          <button key={value} className={workspaceTab === value ? "active" : ""} onClick={() => setWorkspaceTab(value)}>{label}</button>
        ))}
      </nav>

      {workspaceTab === "network" && (
        <section className="recall-preview surface">
          <div>
            <span className="memory-eyebrow">受控重建</span>
            <h2>召回预览</h2>
            <p>输入一个问题，查看检索粒度、扩散节点和最终注入模型的回忆包。</p>
          </div>
          <div className="recall-preview-form">
            <input value={recallQuery} onChange={(event) => setRecallQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runRecallPreview(); }} placeholder="例如：那次雨夜去西湖是什么感觉？" />
            <button className="primary" disabled={recalling || !recallQuery.trim()} onClick={runRecallPreview}>{recalling ? "检索中…" : "模拟召回"}</button>
          </div>
          {recallPreview && (
            <div className="recall-preview-result">
              <div className="memory-meta">
                <span>{recallPreview.meta.mode}</span><span>{recallPreview.plan.depth}</span>
                <span>广度 {recallPreview.plan.breadth}</span><span>{recallPreview.meta.candidates || 0} 个候选</span>
                <span>{recallPreview.meta.expanded_node_ids?.length || 0} 个扩散节点</span>
              </div>
              <pre>{recallPreview.packet || "没有找到可访问的记忆"}</pre>
              <div className="recall-score-list">
                {recallPreview.meta.scores?.map((score) => (
                  <span className="pill" key={score.node_id}>
                    #{score.node_id} · {score.reason} · 总 {(score.score * 100).toFixed(1)}
                    {score.semantic_score !== undefined && ` · 语 ${(score.semantic_score * 100).toFixed(1)}`}
                    {score.lexical_score !== undefined && ` · 词 ${(score.lexical_score * 100).toFixed(1)}`}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {workspaceTab === "history" && (
        <section className="recall-history memory-list">
          {recallEvents.map((event) => (
            <article className="memory-card surface" key={event.id}>
              <div className="memory-card-head"><strong>{event.query}</strong><span className="pill">{event.mode}</span><span className="pill">{event.depth}</span></div>
              <div className="memory-meta"><span>广度 {event.breadth}</span><span>节点 {JSON.parse(event.selected_node_ids || "[]").join("、") || "无"}</span><span>{formatMemoryTime(event.created_at)}</span></div>
            </article>
          ))}
          {recallEvents.length === 0 && <div className="memory-empty"><h2>还没有召回记录</h2><p>聊天或召回预览后会在这里留下可审计记录。</p></div>}
        </section>
      )}

      {workspaceTab !== "history" && <div className="memory-grid">
        <section className="memory-main">
          <div className="memory-filters">
            <input placeholder="搜索内容、标签或分类" value={search} onChange={(event) => setSearch(event.target.value)} />
            <Select value={status} ariaLabel="状态" onChange={setStatus} options={[
              { value: "", label: "全部状态" },
              ...Object.entries(memoryStatusLabels).map(([value, label]) => ({ value, label })),
            ]} />
            <Select value={domain} ariaLabel="分类" onChange={setDomain} options={[
              { value: "", label: "全部分类" },
              ...domains.map((value) => ({ value, label: value })),
            ]} />
            <Select value={topic} ariaLabel="标签" onChange={setTopic} options={[
              { value: "", label: "全部标签" },
              ...topics.map((value) => ({ value, label: value })),
            ]} />
          </div>
          <section className="memory-list">
            {filtered.map((item) => {
              const related = item.related_memory_id
                ? memories.find((memory) => memory.id === item.related_memory_id)
                : null;
              return (
                <article key={item.id} className={`memory-card surface status-${item.status}`}>
                  <div className="memory-card-head">
                    <span className="pill">{memoryStatusLabels[item.status]}</span>
                    <span className="pill">{item.kind}</span>
                    {item.status === "pending" && <span className="pill">{relationLabels[item.relation] || item.relation}</span>}
                    <span className="memory-confidence">{Math.round(item.confidence * 100)}%</span>
                  </div>
                  <p>{item.content}</p>
                  {related && (
                    <div className="memory-related">
                      <strong>旧记忆</strong>
                      <span>{related.content}</span>
                      <strong>候选版本</strong>
                      <span>{item.content}</span>
                    </div>
                  )}
                  <div className="memory-meta">
                    <span className="memory-time" title={`提取于 ${formatMemoryTime(item.created_at)}`}>
                      发生于 {formatMemoryTime(item.occurred_at)}
                    </span>
                    <span>{item.domain || "未分类"}</span>
                    <span>{item.topic || "未添加标签"}</span>
                    <span>提及 {item.mention_count} 次</span>
                    <span>强度 {item.strength.toFixed(1)}</span>
                    <span>重要性 {Math.round(item.importance * 100)}%</span>
                  </div>
                  {(item.cues.length > 0 || item.edges.length > 0) && (
                    <details className="memory-network-details">
                      <summary>{item.cues.length} 条线索 · {item.edges.length} 条关联</summary>
                      <div>{item.cues.map((cue) => <span className="pill" key={`${cue.cue_type}-${cue.value}`}>{cue.cue_type}：{cue.value}</span>)}</div>
                      {item.edges.map((edge) => <div key={`${edge.relation}-${edge.target_id}`}>#{edge.target_id} · {edge.relation} · {Math.round(edge.weight * 100)}%</div>)}
                    </details>
                  )}
                  <div className="memory-actions">
                    {item.status === "pending" && item.relation !== "duplicate" && (
                      <button className="primary" onClick={() => openEditMemory(item, "activate")}>
                        {item.relation === "conflict" ? "确认并存" : "审核确认"}
                      </button>
                    )}
                    {item.status === "pending" && item.relation === "conflict" && item.related_memory_id && (
                      <button onClick={() => openEditMemory(item, "replace")}>审核并替换</button>
                    )}
                    {item.status === "active" && <button onClick={() => patchMemory(item, { status: "disabled" })}>停用</button>}
                    {item.status === "disabled" && <button onClick={() => patchMemory(item, { status: "active" })}>启用</button>}
                    <button onClick={() => openEditMemory(item)}>编辑</button>
                    <button className="danger" onClick={() => removeMemory(item)}>
                      {item.status === "pending" ? "拒绝" : "删除"}
                    </button>
                  </div>
                </article>
              );
            })}
            {filtered.length === 0 && (
              <div className="memory-empty">
                <div className="memory-empty-mark">记</div>
                <h2>{memories.length === 0 ? "还没有长期记忆" : "没有匹配的记忆"}</h2>
                <p>{memories.length === 0 ? "可以手动添加，或在对话中点击“提取记忆”生成候选。" : "试试清空筛选条件或换一个关键词。"}</p>
                {memories.length === 0 && <button className="primary" onClick={() => setCreateOpen(true)}>添加第一条记忆</button>}
              </div>
            )}
          </section>
        </section>

        <aside className="memory-summary-panel">
          <header className="memory-summary-head">
            <div>
              <span className="memory-eyebrow">记忆索引</span>
              <h2>分层摘要</h2>
            </div>
            <span>{summaries.length} 条</span>
          </header>
          <p className="memory-summary-intro">将同标签的原子记忆整理为摘要，减少聊天上下文占用。</p>
          <div className="summary-generator">
            <Select value={summaryKind} ariaLabel="摘要类型" onChange={(value) => {
              setSummaryKind(value as "topic" | "domain");
              setSummaryTitle("");
            }} options={[
              { value: "topic", label: "标签摘要" },
              { value: "domain", label: "分类画像" },
            ]} />
            <Select value={summaryTitle} ariaLabel="摘要范围" onChange={setSummaryTitle} options={[
              { value: "", label: summaryKind === "topic" ? "选择标签" : "选择分类" },
              ...(summaryKind === "topic" ? topics : domains).map((value) => ({ value, label: value })),
            ]} />
            {summaryKind === "topic" && summaryTitle && (topicCounts.get(summaryTitle) || 0) >= 20 && (
              <div className="summary-hint">该标签已有 {topicCounts.get(summaryTitle)} 条有效记忆，建议重新整理。</div>
            )}
            <button className="primary" disabled={busy} onClick={generateSummary}>
              {busy ? "整理中..." : "重新整理"}
            </button>
          </div>
          <div className="summary-list">
            {summaries.map((item) => {
              const sourceIds: number[] = JSON.parse(item.source_memory_ids || "[]");
              return (
                <article key={item.id} className={`summary-card status-${item.status}`}>
                  <div className="memory-card-head">
                    <strong>{item.title}</strong>
                    <span className="pill">{item.kind === "domain" ? "分类" : "标签"} v{item.version}</span>
                    <span className="pill">{item.status === "stale" ? "已过期" : memoryStatusLabels[item.status] || item.status}</span>
                  </div>
                  <p>{item.content}</p>
                  <details>
                    <summary>{sourceIds.length} 条原子依据</summary>
                    {sourceIds.map((id) => <div key={id}>#{id} {memories.find((memory) => memory.id === id)?.content || "原记忆已删除"}</div>)}
                  </details>
                  <div className="memory-actions">
                    {item.status === "pending" && <button className="primary" onClick={async () => { await updateMemorySummary(item.id, { status: "active" }); await reload(); }}>确认</button>}
                    {item.status === "active" && <button onClick={async () => { await updateMemorySummary(item.id, { status: "disabled" }); await reload(); }}>停用</button>}
                    <button className="danger" onClick={async () => {
                      if (await confirm("确定删除这个摘要？")) {
                        await deleteMemorySummary(item.id);
                        await reload();
                      }
                    }}>删除</button>
                  </div>
                </article>
              );
            })}
            {summaries.length === 0 && (
              <div className="summary-empty">
                <strong>暂无摘要</strong>
                <span>有记忆后，可按标签或分类生成可审核的摘要。</span>
              </div>
            )}
          </div>
        </aside>
      </div>}
      <dialog
        ref={createDialogRef}
        className="memory-create-dialog"
        onClose={() => setCreateOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setCreateOpen(false);
        }}
      >
          <section className="dialog-body">
            <header className="memory-dialog-head">
              <div>
                <span className="memory-eyebrow">原子记忆</span>
                <h2>新增记忆</h2>
              </div>
              <button aria-label="关闭" onClick={() => setCreateOpen(false)}>×</button>
            </header>
            <label className="field">
              <span>内容</span>
              <textarea
                rows={5}
                autoFocus
                placeholder="记录一条稳定事实、偏好或经历"
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
            </label>
            <label className="field">
              <span>记忆类型</span>
              <Select
                value={draft.kind}
                onChange={(value) => setDraft({ ...draft, kind: value })}
                options={[
                  { value: "fact", label: "事实" },
                  { value: "episode", label: "事件" },
                  { value: "preference", label: "偏好" },
                  { value: "person", label: "人物" },
                  { value: "place", label: "地点" },
                  { value: "life_stage", label: "人生阶段" },
                ]}
              />
            </label>
            <label className="field">
              <span>标签</span>
              <input placeholder="例如：界面偏好" value={draft.topic} onChange={(event) => setDraft({ ...draft, topic: event.target.value })} />
            </label>
            <label className="field">
              <span>分类</span>
              <input placeholder="例如：知识、生活、经历" value={draft.domain} onChange={(event) => setDraft({ ...draft, domain: event.target.value })} />
            </label>
            <label className="field">
              <span>记忆时间</span>
              <input
                value={draft.occurred_at}
                onChange={(event) => setDraft({ ...draft, occurred_at: event.target.value })}
                onBlur={() => {
                  const parsed = parseMemoryTime(draft.occurred_at);
                  if (parsed) setDraft({ ...draft, occurred_at: formatMemoryInput(parsed) });
                }}
                placeholder="例如 2026-5-12，时分可选"
              />
            </label>
            <label className="field"><span>重要性 {Math.round(draft.importance * 100)}%</span><input type="range" min="0" max="1" step="0.05" value={draft.importance} style={{ "--range": draft.importance } as CSSProperties} onChange={(event) => setDraft({ ...draft, importance: Number(event.target.value) })} /></label>
            <label className="field"><span>情绪权重 {Math.round(draft.emotion_weight * 100)}%</span><input type="range" min="0" max="1" step="0.05" value={draft.emotion_weight} style={{ "--range": draft.emotion_weight } as CSSProperties} onChange={(event) => setDraft({ ...draft, emotion_weight: Number(event.target.value) })} /></label>
            <label className="field"><span>编码线索</span><textarea rows={3} placeholder={"每行一条，例如：\nplace:西湖\nemotion:离别感"} value={draft.cues_text} onChange={(event) => setDraft({ ...draft, cues_text: event.target.value })} /></label>
            <div className="dialog-actions">
              <button onClick={() => setCreateOpen(false)}>取消</button>
              <button className="primary" disabled={!draft.content.trim()} onClick={addMemory}>添加并启用</button>
            </div>
          </section>
      </dialog>
      <dialog
        ref={editDialogRef}
        className="memory-create-dialog memory-edit-dialog"
        onClose={() => {
          setEditingMemory(null);
          setReviewAction(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !savingEdit) {
            setEditingMemory(null);
            setReviewAction(null);
          }
        }}
      >
        <section className="dialog-body">
          <header className="memory-dialog-head">
            <div>
                <span className="memory-eyebrow">{reviewAction ? "待确认记忆" : "原子记忆"}</span>
                <h2>{reviewAction ? "确认记忆与时间" : "编辑记忆"}</h2>
              </div>
            <button
              aria-label="关闭"
              disabled={savingEdit}
              onClick={() => {
                setEditingMemory(null);
                setReviewAction(null);
              }}
            >
              ×
            </button>
          </header>
          <label className="field">
            <span>内容</span>
            <textarea
              rows={5}
              autoFocus
              placeholder="记录一条稳定事实、偏好或经历"
              value={editDraft.content}
              onChange={(event) => setEditDraft({ ...editDraft, content: event.target.value })}
            />
          </label>
          <label className="field">
            <span>记忆类型</span>
            <Select
              value={editDraft.kind}
              onChange={(value) => setEditDraft({ ...editDraft, kind: value })}
              options={[
                { value: "fact", label: "事实" },
                { value: "episode", label: "事件" },
                { value: "preference", label: "偏好" },
                { value: "person", label: "人物" },
                { value: "place", label: "地点" },
                { value: "life_stage", label: "人生阶段" },
                { value: "schema", label: "巩固图式" },
              ]}
            />
          </label>
          <label className="field">
            <span>标签</span>
            <input
              placeholder="例如：界面偏好"
              value={editDraft.topic}
              onChange={(event) => setEditDraft({ ...editDraft, topic: event.target.value })}
            />
          </label>
          <label className="field">
            <span>分类</span>
            <input
              placeholder="例如：知识、生活、经历"
              value={editDraft.domain}
              onChange={(event) => setEditDraft({ ...editDraft, domain: event.target.value })}
            />
          </label>
          <label className="field">
            <span>记忆时间</span>
            <input
              value={editDraft.occurred_at}
              onChange={(event) => setEditDraft({ ...editDraft, occurred_at: event.target.value })}
              onBlur={() => {
                const parsed = parseMemoryTime(editDraft.occurred_at);
                if (parsed) setEditDraft({ ...editDraft, occurred_at: formatMemoryInput(parsed) });
              }}
              placeholder="例如 2008年9月、2008/9/1 14:30"
            />
            {reviewAction && (
              <small className="memory-time-review-hint">
                请确认这里是事件实际发生的时间。正文没有明确日期时，可按文章时间或大致年份修正。
              </small>
            )}
          </label>
          <label className="field"><span>重要性 {Math.round(editDraft.importance * 100)}%</span><input type="range" min="0" max="1" step="0.05" value={editDraft.importance} style={{ "--range": editDraft.importance } as CSSProperties} onChange={(event) => setEditDraft({ ...editDraft, importance: Number(event.target.value) })} /></label>
          <label className="field"><span>情绪权重 {Math.round(editDraft.emotion_weight * 100)}%</span><input type="range" min="0" max="1" step="0.05" value={editDraft.emotion_weight} style={{ "--range": editDraft.emotion_weight } as CSSProperties} onChange={(event) => setEditDraft({ ...editDraft, emotion_weight: Number(event.target.value) })} /></label>
          <label className="field"><span>编码线索</span><textarea rows={3} placeholder="cue_type:value" value={editDraft.cues_text} onChange={(event) => setEditDraft({ ...editDraft, cues_text: event.target.value })} /></label>
          <div className="dialog-actions">
            <button disabled={savingEdit} onClick={() => {
              setEditingMemory(null);
              setReviewAction(null);
            }}>取消</button>
            <button
              className="primary"
              disabled={savingEdit || !editDraft.content.trim() || (reviewAction !== null && !editDraft.occurred_at)}
              onClick={saveMemoryEdit}
            >
              {savingEdit ? "保存中..." : reviewAction ? "确认时间并启用" : "保存修改"}
            </button>
          </div>
        </section>
      </dialog>
      {confirmElement}
      {toastElement}
    </section>
  );
}
