import { loadActiveLlmProfile } from "./llmSettings";

export type EmbeddingSettings = {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
};

const SETTINGS_KEY = "embeddingSettings";

export function defaultEmbeddingSettings(): EmbeddingSettings {
  return {
    providerId: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
  };
}

export function loadEmbeddingSettings(): EmbeddingSettings {
  const defaults = defaultEmbeddingSettings();
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      // Fall through to the one-time legacy migration.
    }
  }
  const legacy = loadActiveLlmProfile();
  if (legacy.embeddingModel?.trim()) {
    return {
      providerId: legacy.providerId,
      apiKey: legacy.apiKey,
      baseUrl: legacy.baseUrl,
      model: legacy.embeddingModel.trim(),
    };
  }
  return defaults;
}

export function saveEmbeddingSettings(settings: EmbeddingSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    ...settings,
    apiKey: settings.apiKey.trim(),
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
  }));
}
