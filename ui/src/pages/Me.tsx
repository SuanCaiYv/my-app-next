import { useCallback, useState } from "react";
import { Brain, RefreshCw, Settings } from "lucide-react";
import MemoryPage from "./Memory";
import EmbeddingPage from "./Embedding";
import AnalyzePage from "./Analyze";

const sections = [
  {
    id: "memory",
    label: "记忆",
    description: "整理并管理属于你的个人记忆条目与总结。",
    icon: Brain,
  },
  {
    id: "embedding",
    label: "向量转换",
    description: "配置 Embedding 服务，将内容转换为可检索的向量。",
    icon: RefreshCw,
  },
  {
    id: "analyze",
    label: "LLM配置",
    description: "管理大语言模型接口与默认提示词模板。",
    icon: Settings,
  },
];

export default function MePage() {
  const [open, setOpen] = useState<Record<string, boolean>>({ memory: true });

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const isOpen = !!prev[id];
      const next: Record<string, boolean> = {};
      sections.forEach((section) => {
        next[section.id] = section.id === id ? !isOpen : false;
      });
      return next;
    });
  }, []);

  return (
    <section className="view active me-view" id="meView">
      <div className="me-sections">
        <div className="me-card-grid">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                type="button"
                className={`plain me-card ${open[section.id] ? "active" : ""}`}
                onClick={() => toggle(section.id)}
                aria-expanded={open[section.id]}
              >
                <span className="me-card-icon" aria-hidden="true">
                  <Icon size={26} strokeWidth={1.75} />
                </span>
                <span className="me-card-title">{section.label}</span>
                <span className="me-card-description">{section.description}</span>
              </button>
            );
          })}
        </div>

        {sections.map((section) => (
          <div
            key={`body-${section.id}`}
            className={`me-section ${open[section.id] ? "open" : ""}`}
          >
            {open[section.id] && (
              <div className="me-section-body">
                {section.id === "memory" && <MemoryPage />}
                {section.id === "embedding" && <EmbeddingPage />}
                {section.id === "analyze" && <AnalyzePage />}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
