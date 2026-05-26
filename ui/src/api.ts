import type {
  PostItem,
  PhotoItem,
  AnalysisItem,
  ChatSessionSummary,
  ChatSessionItem,
  AnalyzeRequest,
  ChatRequest,
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

export async function chat(body: ChatRequest) {
  return api<{ answer: string; usage: unknown }>("/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function chatStream(
  body: ChatRequest,
  onChunk: (delta: string) => void
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
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "请求失败");
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

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
