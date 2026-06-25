import { useMemo, useState } from "react";
import Select from "../components/Select";
import { testEmbeddingConnection } from "../api";
import { loadEmbeddingSettings, saveEmbeddingSettings, type EmbeddingSettings } from "../embeddingSettings";
import { useToast } from "../hooks/useToast";

const providers = [
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small" },
  { id: "qwen", name: "Qwen / 通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4" },
  { id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-embed" },
  { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-embedding-001" },
  { id: "ollama", name: "Ollama（本地）", baseUrl: "http://localhost:11434", model: "qwen3-embedding:4b" },
  { id: "custom", name: "自定义兼容接口", baseUrl: "", model: "" },
];

export default function EmbeddingPage() {
  const initial = useMemo(() => loadEmbeddingSettings(), []);
  const [settings, setSettings] = useState<EmbeddingSettings>(initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ state: "success" | "error"; message: string } | null>(null);
  const { show: showToast, element: toastElement } = useToast();

  const update = (patch: Partial<EmbeddingSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const changeProvider = (providerId: string) => {
    const provider = providers.find((item) => item.id === providerId)!;
    update({ providerId, baseUrl: provider.baseUrl, model: provider.model });
    setTestResult(null);
  };
  const validate = () => {
    if (!settings.baseUrl.trim()) { showToast("请填写 Embedding Base URL"); return false; }
    if (!settings.model.trim()) { showToast("请填写 Embedding 模型"); return false; }
    return true;
  };
  const save = () => {
    if (!validate()) return;
    saveEmbeddingSettings(settings);
    showToast("向量配置已保存");
  };
  const test = async () => {
    if (!validate()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testEmbeddingConnection({
        api_key: settings.apiKey,
        base_url: settings.baseUrl,
        model: settings.model,
        provider: settings.providerId,
      });
      setTestResult({ state: "success", message: `连接成功 · ${result.dimensions} 维 · ${result.elapsed_ms} ms` });
    } catch (error) {
      setTestResult({ state: "error", message: error instanceof Error ? error.message : "连接测试失败" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="view active" id="embeddingView">
      <div className="llm-settings-layout">
        <section className="analysis-panel llm-settings-panel">
          <header className="settings-head">
            <div>
              <h2>向量配置</h2>
              <p>独立配置长期记忆的 Embedding 服务。它只用于语义召回，不影响聊天模型。</p>
            </div>
            <div className="settings-head-actions">
              <button className="secondary" disabled={testing} onClick={test}>{testing ? "测试中..." : "测试向量连接"}</button>
              <button className="primary" onClick={save}>保存设置</button>
            </div>
          </header>

          <div className="settings-grid">
            <div className="field">
              <label>服务商</label>
              <Select value={settings.providerId} ariaLabel="Embedding 服务商" onChange={changeProvider}
                options={providers.map((item) => ({ value: item.id, label: item.name }))} />
            </div>
            <div className="field">
              <label>Embedding 模型</label>
              <input value={settings.model} onChange={(event) => update({ model: event.target.value })} placeholder="例如 text-embedding-3-small" />
            </div>
            <div className="field">
              <label>API Key（可选）</label>
              <input type="password" value={settings.apiKey} onChange={(event) => update({ apiKey: event.target.value })} placeholder="本地服务可留空" />
            </div>
            <div className="field wide-field">
              <label>Base URL</label>
              <input value={settings.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} placeholder="服务根地址或完整 Embedding 接口地址" />
            </div>
          </div>

          <div className="settings-note">
            <strong>工作方式</strong>
            <span>首次召回时自动生成并缓存记忆向量；本地无鉴权服务可不填 API Key。服务不可用时降级为关键词召回。</span>
          </div>
          {testResult && <div className={`llm-test-result ${testResult.state}`} role="status"><strong>{testResult.state === "success" ? "向量服务可用" : "连接失败"}</strong><span>{testResult.message}</span></div>}
        </section>
      </div>
      {toastElement}
    </section>
  );
}
