import { useMemo, useState } from "react";
import Select from "../components/Select";
import { useToast } from "../hooks/useToast";

type ProviderPreset = {
  id: string;
  name: string;
  baseUrl: string;
  models: { value: string; label: string }[];
  note: string;
};

const providers: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { value: "gpt-4.1", label: "gpt-4.1" },
      { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
      { value: "gpt-4o", label: "gpt-4o" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini" },
    ],
    note: "官方 OpenAI Chat Completions / 兼容入口。",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    models: [
      { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { value: "claude-haiku-4-20250514", label: "Claude Haiku 4" },
      { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
    ],
    note: "Anthropic 原生 Messages API；会自动使用 x-api-key 和 anthropic-version 请求头。",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { value: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { value: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
      { value: "google/gemini-3-pro", label: "Gemini 3 Pro" },
      { value: "openai/gpt-4.1", label: "GPT-4.1" },
      { value: "qwen/qwen3-max", label: "Qwen3 Max" },
      { value: "mistralai/mistral-large", label: "Mistral Large" },
    ],
    note: "统一网关，适合接入 Claude、Gemini、Qwen、Mistral 等多家模型。",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [
      { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
      { value: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite" },
    ],
    note: "使用 Gemini 的 OpenAI-compatible Chat Completions 入口。",
  },
  {
    id: "qwen",
    name: "Qwen / 通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { value: "qwen-plus", label: "qwen-plus" },
      { value: "qwen-max", label: "qwen-max" },
      { value: "qwen-turbo", label: "qwen-turbo" },
      { value: "qwen-vl-plus", label: "qwen-vl-plus" },
    ],
    note: "阿里云 DashScope OpenAI 兼容模式；国际站可改为 intl endpoint。",
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    models: [
      { value: "kimi-k2-0905-preview", label: "kimi-k2-0905-preview" },
      { value: "moonshot-v1-128k", label: "moonshot-v1-128k" },
      { value: "moonshot-v1-32k", label: "moonshot-v1-32k" },
      { value: "moonshot-v1-8k", label: "moonshot-v1-8k" },
    ],
    note: "Kimi Open Platform，OpenAI-compatible HTTP API。",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: [
      { value: "deepseek-v4-flash", label: "deepseek-v4-flash" },
      { value: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { value: "deepseek-chat", label: "deepseek-chat" },
      { value: "deepseek-reasoner", label: "deepseek-reasoner" },
    ],
    note: "DeepSeek 的 OpenAI-compatible 入口。",
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    models: [
      { value: "mistral-large-latest", label: "mistral-large-latest" },
      { value: "mistral-medium-latest", label: "mistral-medium-latest" },
      { value: "ministral-8b-latest", label: "ministral-8b-latest" },
    ],
    note: "Mistral Chat Completions API。",
  },
  {
    id: "mimo",
    name: "MiMo / 小米",
    baseUrl: "https://api.mimo-v2.com/v1",
    models: [
      { value: "xiaomi/mimo-v2-flash", label: "xiaomi/mimo-v2-flash" },
      { value: "xiaomi/mimo-v2-pro", label: "xiaomi/mimo-v2-pro" },
      { value: "xiaomi/mimo-v2-omni", label: "xiaomi/mimo-v2-omni" },
    ],
    note: "MiMo OpenAI-compatible 入口；如账号给了专属 endpoint，可手动覆盖。",
  },
  {
    id: "custom",
    name: "自定义兼容接口",
    baseUrl: "",
    models: [{ value: "custom", label: "自定义模型" }],
    note: "适合 Ollama、LM Studio、vLLM、LiteLLM、One API 等 OpenAI-compatible 服务。",
  },
];

function currentModel(preset: string, custom: string) {
  return preset === "custom" ? custom : preset;
}

function parseContextLimit(value: string): number | null {
  const trimmed = value.trim().toLowerCase().replace(/,/g, "");
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (Number.isNaN(num) || num < 0) return null;
  const unit = match[2];
  if (unit === "k") return Math.round(num * 1024);
  if (unit === "m") return Math.round(num * 1024 * 1024);
  return Math.round(num);
}

export default function AnalyzePage() {
  const initialProvider = localStorage.getItem("llmProvider") || "openai";
  const [providerId, setProviderId] = useState(initialProvider);
  const [apiKey, setApiKey] = useState(localStorage.getItem("apiKey") || "");
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem("baseUrl") || providers.find((p) => p.id === initialProvider)?.baseUrl || "");
  const [modelPreset, setModelPreset] = useState(localStorage.getItem("modelPreset") || "");
  const [customModel, setCustomModel] = useState(localStorage.getItem("customModel") || "");
  const [contextLimit, setContextLimit] = useState(localStorage.getItem("contextLimit") || "");
  const { show: showToast, element: toastElement } = useToast();

  const provider = useMemo(() => providers.find((item) => item.id === providerId) || providers[0], [providerId]);
  const modelOptions = useMemo(() => [
    { value: "", label: "选择模型" },
    ...provider.models,
    { value: "custom", label: "自定义模型名" },
  ], [provider]);
  const model = currentModel(modelPreset, customModel);

  const handleProviderChange = (nextProviderId: string) => {
    const nextProvider = providers.find((item) => item.id === nextProviderId) || providers[0];
    setProviderId(nextProvider.id);
    setBaseUrl(nextProvider.baseUrl);
    setModelPreset(nextProvider.models[0]?.value || "");
    if (nextProvider.id !== "custom") setCustomModel("");
  };

  const handleSave = () => {
    if (!model.trim()) {
      showToast("请选择或填写模型");
      return;
    }
    const parsedLimit = parseContextLimit(contextLimit);
    if (contextLimit.trim() && parsedLimit === null) {
      showToast("上下文大小格式不正确");
      return;
    }
    localStorage.setItem("llmProvider", providerId);
    localStorage.setItem("apiKey", apiKey);
    localStorage.setItem("baseUrl", baseUrl);
    localStorage.setItem("modelPreset", modelPreset);
    localStorage.setItem("customModel", customModel);
    localStorage.setItem("model", model);
    if (parsedLimit !== null) {
      localStorage.setItem("contextLimit", String(parsedLimit));
    } else {
      localStorage.removeItem("contextLimit");
    }
    showToast("LLM 设置已保存");
  };

  return (
    <section className="view active" id="analyzeView">
      <div className="llm-settings-layout">
        <section className="analysis-panel llm-settings-panel">
          <header className="settings-head">
            <div>
              <h2>LLM 设置</h2>
              <p>这些设置会用于对话、标题生成和后续 LLM 功能。</p>
            </div>
            <button className="primary" onClick={handleSave}>保存设置</button>
          </header>

          <div className="settings-grid">
            <div className="field">
              <label>服务商</label>
              <Select
                value={providerId}
                ariaLabel="服务商"
                onChange={handleProviderChange}
                options={providers.map((item) => ({ value: item.id, label: item.name }))}
              />
            </div>

            <div className="field">
              <label>API Key</label>
              <input placeholder="填入当前服务商的 API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" />
            </div>

            <div className="field wide-field">
              <label>Base URL</label>
              <input placeholder="OpenAI-compatible Base URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>

            <div className="field">
              <label>模型</label>
              <Select
                value={modelPreset}
                ariaLabel="模型"
                onChange={setModelPreset}
                options={modelOptions}
              />
            </div>

            <div className="field">
              <label>自定义模型名</label>
              <input
                placeholder="例如 vendor/model-name"
                value={customModel}
                onChange={(e) => {
                  setCustomModel(e.target.value);
                  if (modelPreset !== "custom") setModelPreset("custom");
                }}
              />
            </div>

            <div className="field">
              <label>上下文大小</label>
              <input
                placeholder="例如 4096、4K、128K、1M"
                value={contextLimit}
                onChange={(e) => setContextLimit(e.target.value)}
              />
            </div>
          </div>

          <div className="settings-note">
            <strong>{provider.name}</strong>
            <span>{provider.note}</span>
          </div>

          <div className="settings-summary">
            <span>当前模型</span>
            <strong>{model || "未选择"}</strong>
          </div>
        </section>
      </div>

      {toastElement}
    </section>
  );
}
