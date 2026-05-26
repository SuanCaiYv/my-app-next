export interface PostItem {
  id: number;
  title: string;
  body: string;
  kind: "article" | "thought" | "note";
  status: "draft" | "published";
  category: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface PhotoItem {
  id: number;
  title: string;
  description: string;
  category: string;
  tags: string;
  filename: string;
  original_name: string;
  mime: string;
  url: string;
  thumbnail_url: string;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  updated_at: string;
}

export interface AnalysisItem {
  id: number;
  subject: string;
  prompt: string;
  model: string;
  base_url: string;
  post_ids: string;
  photo_ids: string;
  free_text: string;
  answer: string;
  created_at: string;
}

export interface ChatSessionSummary {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatSessionItem {
  id: number;
  title: string;
  messages: string;
  context_post_ids: string;
  context_photo_ids: string;
  context_free_text: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageInput {
  role: string;
  content: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AnalyzeRequest {
  api_key: string;
  base_url?: string;
  model: string;
  prompt: string;
  post_ids: number[];
  photo_ids: number[];
  free_text?: string;
  save?: boolean;
  provider?: string;
}

export interface ChatRequest {
  api_key: string;
  base_url?: string;
  model: string;
  post_ids: number[];
  photo_ids: number[];
  free_text?: string;
  messages: ChatMessageInput[];
  stream?: boolean;
  provider?: string;
}
