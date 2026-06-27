import { loadEmbeddingSettings as loadEmbeddingSettingsApi, saveEmbeddingSettings as saveEmbeddingSettingsApi } from "./api";

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

function loadEmbeddingSettingsFromLocalStorage(): EmbeddingSettings | null {
  const defaults = defaultEmbeddingSettings();
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      // Fall through to legacy migration.
    }
  }

  const legacyRaw = localStorage.getItem("embeddingModel");
  if (legacyRaw?.trim()) {
    return {
      providerId: localStorage.getItem("llmProvider") || "openai",
      apiKey: localStorage.getItem("apiKey") || "",
      baseUrl: localStorage.getItem("baseUrl") || "",
      model: legacyRaw.trim(),
    };
  }

  return null;
}

function clearLegacyEmbeddingLocalStorage() {
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem("embeddingModel");
}

export async function loadEmbeddingSettings(): Promise<EmbeddingSettings> {
  try {
    const settings = await loadEmbeddingSettingsApi();
    if (settings.baseUrl.trim() || settings.model.trim()) {
      return {
        ...defaultEmbeddingSettings(),
        ...settings,
        apiKey: settings.apiKey.trim(),
        baseUrl: settings.baseUrl.trim(),
        model: settings.model.trim(),
      };
    }
  } catch {
    // Fall back to localStorage and attempt migration.
  }

  const legacy = loadEmbeddingSettingsFromLocalStorage();
  if (legacy) {
    try {
      await saveEmbeddingSettingsApi({
        ...legacy,
        apiKey: legacy.apiKey.trim(),
        baseUrl: legacy.baseUrl.trim(),
        model: legacy.model.trim(),
      });
      clearLegacyEmbeddingLocalStorage();
    } catch {
      // If backend save fails, still return local values so the app works.
    }
    return legacy;
  }

  return defaultEmbeddingSettings();
}

export async function saveEmbeddingSettings(settings: EmbeddingSettings) {
  await saveEmbeddingSettingsApi({
    ...settings,
    apiKey: settings.apiKey.trim(),
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
  });
}
