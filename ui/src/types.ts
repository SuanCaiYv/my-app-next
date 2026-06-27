export interface LocationItem {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  created_at: string;
  updated_at: string;
}

export interface LocationDetail {
  location: LocationItem;
  posts: PostItem[];
  photos: PhotoItem[];
}

export interface ExtractLocationsRequest {
  post_id: number;
  amap_key: string;
  api_key: string;
  base_url?: string;
  model: string;
  provider?: string;
  prompt?: string;
}

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
  use_memory: boolean;
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
  use_memory?: boolean;
  memory_budget_tokens?: number;
  embedding_model?: string;
  embedding_api_key?: string;
  embedding_base_url?: string;
  embedding_provider?: string;
}

export interface MemoryItem {
  id: number;
  content: string;
  normalized_content: string;
  topic: string;
  domain: string;
  status: "pending" | "active" | "disabled" | "superseded";
  relation: "new" | "duplicate" | "reinforce" | "update" | "conflict";
  related_memory_id: number | null;
  source_session_id: number | null;
  supersedes_id: number | null;
  mention_count: number;
  confidence: number;
  last_mentioned_at: string;
  valid_from: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  kind: "episode" | "fact" | "preference" | "person" | "place" | "life_stage" | "schema";
  time_precision: "exact" | "day" | "month" | "year" | "period" | "unknown";
  importance: number;
  emotion_weight: number;
  strength: number;
  last_activated_at: string;
  cues: MemoryCue[];
  sources: MemorySource[];
  edges: MemoryEdge[];
}

export interface MemoryCue { cue_type: string; value: string; specificity: number; }
export interface MemorySource { source_type: string; source_id: number | null; excerpt: string; }
export interface MemoryEdge { target_id: number; relation: string; weight: number; }

export interface MemorySummaryItem {
  id: number;
  kind: "topic" | "domain";
  title: string;
  content: string;
  source_memory_ids: string;
  status: "pending" | "active" | "stale" | "disabled";
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryRecallMeta {
  domains: number;
  topics: number;
  memories: number;
  estimated_tokens: number;
  semantic: boolean;
  mode?: string;
  depth?: string;
  breadth?: number;
  candidates?: number;
  selected_node_ids?: number[];
  expanded_node_ids?: number[];
  planned?: boolean;
  scores?: Array<{ node_id: number; score: number; lexical_score?: number; semantic_score?: number; reason: string }>;
}

export interface MemoryRecallPreview {
  plan: { goal: string; depth: string; breadth: number; cues: string[]; exclusions: string[] };
  packet: string;
  meta: MemoryRecallMeta;
  nodes: MemoryItem[];
}

export interface MemoryRecallEvent {
  id: number; query: string; mode: string; depth: string; breadth: number;
  selected_node_ids: string; created_at: string;
}
