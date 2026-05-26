export type LlmProfile = {
  id: string;
  name: string;
  providerId: string;
  apiKey: string;
  baseUrl: string;
  modelPreset: string;
  customModel: string;
  contextLimit: string;
  titlePrompt: string;
};

const PROFILES_KEY = "llmProfiles";
const ACTIVE_PROFILE_KEY = "activeLlmProfileId";
export const DEFAULT_TITLE_PROMPT = "请为下面这篇个人文章或随手想法生成一个中文标题。标题要自然、具体、有记忆点，不要夸张，不要使用书名号，不要解释，只返回一个标题，最多 18 个中文字符。";

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
    apiKey: "",
    baseUrl: "",
    modelPreset: "",
    customModel: "",
    contextLimit: "",
    titlePrompt: "",
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
    apiKey: localStorage.getItem("apiKey") || "",
    baseUrl: localStorage.getItem("baseUrl") || "",
    modelPreset,
    customModel,
    contextLimit: localStorage.getItem("contextLimit") || "",
    titlePrompt: localStorage.getItem("titlePrompt") || "",
  });
}

function normalizeProfile(value: Partial<LlmProfile>, index = 0): LlmProfile {
  return createLlmProfile({
    id: value.id || (index === 0 ? "legacy-default" : newProfileId()),
    name: value.name || `配置 ${index + 1}`,
    providerId: value.providerId || "openai",
    apiKey: value.apiKey || "",
    baseUrl: value.baseUrl || "",
    modelPreset: value.modelPreset || "",
    customModel: value.customModel || "",
    contextLimit: value.contextLimit || "",
    titlePrompt: value.titlePrompt || "",
  });
}

export function loadLlmProfiles(): { profiles: LlmProfile[]; activeId: string } {
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
  return { profiles: [legacy], activeId: legacy.id };
}

export function saveLlmProfiles(profiles: LlmProfile[], activeId: string) {
  const safeProfiles = profiles.length > 0 ? profiles : [createLlmProfile()];
  const safeActiveId = safeProfiles.some((profile) => profile.id === activeId)
    ? activeId
    : safeProfiles[0].id;
  localStorage.setItem(PROFILES_KEY, JSON.stringify(safeProfiles));
  localStorage.setItem(ACTIVE_PROFILE_KEY, safeActiveId);

  const active = safeProfiles.find((profile) => profile.id === safeActiveId) || safeProfiles[0];
  localStorage.setItem("llmProvider", active.providerId);
  localStorage.setItem("apiKey", active.apiKey);
  localStorage.setItem("baseUrl", active.baseUrl);
  localStorage.setItem("modelPreset", active.modelPreset);
  localStorage.setItem("customModel", active.customModel);
  localStorage.setItem("model", currentModel(active));
  if (active.contextLimit.trim()) {
    localStorage.setItem("contextLimit", active.contextLimit);
  } else {
    localStorage.removeItem("contextLimit");
  }
  if (active.titlePrompt.trim()) {
    localStorage.setItem("titlePrompt", active.titlePrompt);
  } else {
    localStorage.removeItem("titlePrompt");
  }
}

export function loadActiveLlmProfile(): LlmProfile {
  const { profiles, activeId } = loadLlmProfiles();
  return profiles.find((profile) => profile.id === activeId) || profiles[0];
}
