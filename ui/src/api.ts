import type {
  PostItem,
  PhotoItem,
  AnalysisItem,
  ChatSessionSummary,
  ChatSessionItem,
  AnalyzeRequest,
  ChatRequest,
  MemoryItem,
  MemorySummaryItem,
  MemoryRecallMeta,
  MemoryRecallPreview,
  MemoryRecallEvent,
  LocationItem,
  LocationDetail,
  ExtractLocationsRequest,
} from "./types";

let token = localStorage.getItem("ownerToken") || "";

export function getToken() {
  return token;
}

export function setToken(newToken: string) {
  token = newToken;
  localStorage.setItem("ownerToken", newToken);
}

export function clearToken() {
  token = "";
  localStorage.removeItem("ownerToken");
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 204) return null as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

export async function login(password: string) {
  return api<{ token: string; role: string }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function me() {
  return api<{ role: string }>("/api/auth/me");
}

export async function listPosts() {
  return api<PostItem[]>("/api/posts");
}

export async function createPost(body: unknown) {
  return api<PostItem>("/api/posts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updatePost(id: number, body: unknown) {
  return api<PostItem>(`/api/posts/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deletePost(id: number) {
  return api<void>(`/api/posts/${id}`, { method: "DELETE" });
}

export async function listPhotos() {
  return api<PhotoItem[]>("/api/photos");
}

export async function uploadPhoto(formData: FormData) {
  return api<PhotoItem>("/api/photos", {
    method: "POST",
    body: formData,
  });
}

export async function updatePhoto(id: number, body: unknown) {
  return api<PhotoItem>(`/api/photos/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deletePhoto(id: number) {
  return api<void>(`/api/photos/${id}`, { method: "DELETE" });
}

export async function listLocations() {
  return api<LocationItem[]>("/api/locations");
}

export async function extractLocations(body: ExtractLocationsRequest) {
  return api<LocationItem[]>("/api/locations", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listPostLocations(postId: number) {
  return api<LocationItem[]>(`/api/posts/${postId}/locations`);
}

export async function addPostLocation(postId: number, name: string) {
  return api<LocationItem>(`/api/posts/${postId}/locations`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function removePostLocation(postId: number, locationId: number) {
  return api<void>(`/api/posts/${postId}/locations/${locationId}`, { method: "DELETE" });
}

export async function getLocationDetail(locationId: number) {
  return api<LocationDetail>(`/api/locations/${locationId}`);
}

export async function listAnalyses() {
  return api<AnalysisItem[]>("/api/analyses");
}

export async function deleteAnalysis(id: number) {
  return api<void>(`/api/analyses/${id}`, { method: "DELETE" });
}

export async function analyze(body: AnalyzeRequest) {
  return api<{ id: unknown; answer: string }>("/api/analyze", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function testLlmConnection(body: {
  api_key: string;
  base_url?: string;
  model: string;
  provider?: string;
}) {
  return api<{ ok: boolean; model: string; answer: string; elapsed_ms: number }>("/api/llm/test", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function testEmbeddingConnection(body: {
  api_key: string;
  base_url: string;
  model: string;
  provider?: string;
}) {
  return api<{ ok: boolean; model: string; dimensions: number; elapsed_ms: number }>("/api/embeddings/test", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function chat(body: ChatRequest) {
  return api<{ answer: string; usage: unknown }>("/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function chatStream(
  body: ChatRequest,
  onChunk: (delta: string) => void,
  onMemory?: (meta: MemoryRecallMeta) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "请求失败");
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const json = JSON.parse(data);
            if (json.memory) {
              onMemory?.(json.memory);
              continue;
            }
            const content = json.choices?.[0]?.delta?.content ?? json.delta?.text;
            if (content) {
              onChunk(content);
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function listChatSessions() {
  return api<ChatSessionSummary[]>("/api/chat-sessions");
}

export async function createChatSession(body: unknown) {
  return api<ChatSessionItem>("/api/chat-sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getChatSession(id: number) {
  return api<ChatSessionItem>(`/api/chat-sessions/${id}`);
}

export async function updateChatSession(id: number, body: unknown) {
  return api<ChatSessionItem>(`/api/chat-sessions/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteChatSession(id: number) {
  return api<void>(`/api/chat-sessions/${id}`, { method: "DELETE" });
}

export async function listMemories() {
  return api<MemoryItem[]>("/api/memories");
}

export async function createMemory(body: unknown) {
  return api<MemoryItem>("/api/memories", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateMemory(id: number, body: unknown) {
  return api<MemoryItem>(`/api/memories/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteMemory(id: number) {
  return api<void>(`/api/memories/${id}`, { method: "DELETE" });
}

export async function extractMemories(body: unknown) {
  return api<MemoryItem[]>("/api/memories/extract", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listMemoryExtractionSources() {
  return api<{ post_ids: number[]; photo_ids: number[] }>("/api/memory-extractions/sources");
}

export async function previewMemoryRecall(query: string, budgetTokens = 800) {
  return api<MemoryRecallPreview>("/api/memories/recall-preview", {
    method: "POST",
    body: JSON.stringify({ query, budget_tokens: budgetTokens }),
  });
}

export async function listMemoryRecallEvents() {
  return api<MemoryRecallEvent[]>("/api/memory-recall-events");
}

export async function listMemorySummaries() {
  return api<MemorySummaryItem[]>("/api/memory-summaries");
}

export async function createMemorySummary(body: unknown) {
  return api<MemorySummaryItem>("/api/memory-summaries", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateMemorySummary(id: number, body: unknown) {
  return api<MemorySummaryItem>(`/api/memory-summaries/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function deleteMemorySummary(id: number) {
  return api<void>(`/api/memory-summaries/${id}`, { method: "DELETE" });
}

export async function generateMemorySummary(body: unknown) {
  return api<MemorySummaryItem>("/api/memory-summaries/generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
