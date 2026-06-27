import { loadLlmSettings, saveLlmSettings } from "./api";

export type LlmProfile = {
  id: string;
  name: string;
  providerId: string;
  apiFormat: "openai" | "anthropic";
  apiKey: string;
  baseUrl: string;
  modelPreset: string;
  customModel: string;
  contextLimit: string;
  embeddingModel: string;
  titlePrompt: string;
  tagsPrompt: string;
  locationPrompt: string;
};

const PROFILES_KEY = "llmProfiles";
const ACTIVE_PROFILE_KEY = "activeLlmProfileId";
export const DEFAULT_TITLE_PROMPT = "请为下面这篇个人文章或随手想法生成一个中文标题。标题要自然、具体、有记忆点，不要夸张，不要使用书名号，不要解释，只返回一个标题，最多 18 个中文字符。";
export const DEFAULT_TAGS_PROMPT = "请根据下面这篇个人文章或随手想法的正文、分类和标题，生成 3-7 个中文标签。优先从已有的标签列表中挑选最合适的标签，只有当已有标签无法准确表达时才创造新标签。标签之间用中文逗号分隔，不要解释，只返回标签。";
export const DEFAULT_LOCATION_PROMPT = "请从下面这篇个人文章或随手想法中提取所有真实存在的地点。对每个地点给出尽可能详细的名称（如\"浙江省杭州市西湖区西湖\"），以便后续地理编码。只返回 JSON 数组，不要解释。格式：[{\"name\":\"...\"}]";

export function currentModel(profile: Pick<LlmProfile, "modelPreset" | "customModel">) {
  return profile.modelPreset === "custom" ? profile.customModel : profile.modelPreset;
}

function newProfileId() {
  return `llm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createLlmProfile(overrides: Partial<LlmProfile> = {}): LlmProfile {
  return {
    id: newProfileId(),
    name: "默认配置",
    providerId: "openai",
    apiFormat: "openai",
    apiKey: "",
    baseUrl: "",
    modelPreset: "",
    customModel: "",
    contextLimit: "",
    embeddingModel: "",
    titlePrompt: "",
    tagsPrompt: "",
    locationPrompt: "",
    ...overrides,
  };
}

function profileFromLegacy(): LlmProfile {
  const providerId = localStorage.getItem("llmProvider") || "openai";
  const modelPreset = localStorage.getItem("modelPreset") || "";
  const customModel = localStorage.getItem("customModel") || "";
  return createLlmProfile({
    id: "legacy-default",
    name: "默认配置",
    providerId,
    apiFormat: providerId === "anthropic" ? "anthropic" : "openai",
    apiKey: localStorage.getItem("apiKey") || "",
    baseUrl: localStorage.getItem("baseUrl") || "",
    modelPreset,
    customModel,
    contextLimit: localStorage.getItem("contextLimit") || "",
    embeddingModel: localStorage.getItem("embeddingModel") || "",
    titlePrompt: localStorage.getItem("titlePrompt") || "",
    tagsPrompt: localStorage.getItem("tagsPrompt") || "",
    locationPrompt: localStorage.getItem("locationPrompt") || "",
  });
}

function normalizeProfile(value: Partial<LlmProfile>, index = 0): LlmProfile {
  return createLlmProfile({
    id: value.id || (index === 0 ? "legacy-default" : newProfileId()),
    name: value.name || `配置 ${index + 1}`,
    providerId: value.providerId || "openai",
    apiFormat: value.apiFormat || (value.providerId === "anthropic" ? "anthropic" : "openai"),
    apiKey: value.apiKey || "",
    baseUrl: value.baseUrl || "",
    modelPreset: value.modelPreset || "",
    customModel: value.customModel || "",
    contextLimit: value.contextLimit || "",
    embeddingModel: value.embeddingModel || "",
    titlePrompt: value.titlePrompt || "",
    tagsPrompt: value.tagsPrompt || "",
    locationPrompt: value.locationPrompt || "",
  });
}

function loadLlmProfilesFromLocalStorage(): { profiles: LlmProfile[]; activeId: string } | null {
  const raw = localStorage.getItem(PROFILES_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const profiles = parsed.map((item, index) => normalizeProfile(item, index));
        const storedActiveId = localStorage.getItem(ACTIVE_PROFILE_KEY);
        const activeId = profiles.some((profile) => profile.id === storedActiveId)
          ? storedActiveId!
          : profiles[0].id;
        return { profiles, activeId };
      }
    } catch {
      // Fall through to legacy migration.
    }
  }

  const legacy = profileFromLegacy();
  if (legacy.apiKey || legacy.baseUrl || legacy.modelPreset) {
    return { profiles: [legacy], activeId: legacy.id };
  }
  return null;
}

function clearLegacyLlmLocalStorage() {
  localStorage.removeItem(PROFILES_KEY);
  localStorage.removeItem(ACTIVE_PROFILE_KEY);
  localStorage.removeItem("llmProvider");
  localStorage.removeItem("apiKey");
  localStorage.removeItem("baseUrl");
  localStorage.removeItem("modelPreset");
  localStorage.removeItem("customModel");
  localStorage.removeItem("model");
  localStorage.removeItem("embeddingModel");
  localStorage.removeItem("contextLimit");
  localStorage.removeItem("titlePrompt");
  localStorage.removeItem("tagsPrompt");
  localStorage.removeItem("locationPrompt");
}

export async function loadLlmProfiles(): Promise<{ profiles: LlmProfile[]; activeId: string }> {
  try {
    const settings = await loadLlmSettings();
    if (settings.profiles.length > 0) {
      return {
        profiles: settings.profiles.map((item, index) => normalizeProfile(item, index)),
        activeId: settings.activeId || settings.profiles[0].id,
      };
    }
  } catch {
    // Fall back to localStorage and attempt migration.
  }

  const legacy = loadLlmProfilesFromLocalStorage();
  if (legacy) {
    try {
      await saveLlmSettings({ profiles: legacy.profiles, activeId: legacy.activeId });
      clearLegacyLlmLocalStorage();
    } catch {
      // If backend save fails, still return local values so the app works.
    }
    return legacy;
  }

  const fallback = createLlmProfile();
  return { profiles: [fallback], activeId: fallback.id };
}

export async function saveLlmProfiles(profiles: LlmProfile[], activeId: string) {
  const safeProfiles = profiles.length > 0 ? profiles : [createLlmProfile()];
  const safeActiveId = safeProfiles.some((profile) => profile.id === activeId)
    ? activeId
    : safeProfiles[0].id;
  await saveLlmSettings({ profiles: safeProfiles, activeId: safeActiveId });
}

export async function loadActiveLlmProfile(): Promise<LlmProfile> {
  const { profiles, activeId } = await loadLlmProfiles();
  return profiles.find((profile) => profile.id === activeId) || profiles[0];
}

export function requestProvider(profile: Pick<LlmProfile, "providerId" | "apiFormat">) {
  if (profile.apiFormat === "anthropic") return "anthropic";
  return profile.providerId === "anthropic" ? "openai-compatible" : profile.providerId;
}
