import { useEffect, useState, useRef, useCallback } from "react";
import { PenLine, Upload } from "lucide-react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoadingProvider, useLoading } from "./context/LoadingContext";
import { listPosts, listPhotos } from "./api";
import PostsPage from "./pages/Posts";
import PhotosPage from "./pages/Photos";
import MapPage from "./pages/Map";
import ChatPage from "./pages/Chat";
import MePage from "./pages/Me";
import LoginDialog from "./components/LoginDialog";
import Select from "./components/Select";
import AutoTooltip from "./components/AutoTooltip";

type View = "posts" | "photos" | "map" | "chat" | "me";

const tabs: { key: View; label: string; ownerOnly: boolean }[] = [
  { key: "posts", label: "文字", ownerOnly: false },
  { key: "photos", label: "照片", ownerOnly: false },
  { key: "map", label: "地图", ownerOnly: false },
  { key: "chat", label: "对话", ownerOnly: true },
  { key: "me", label: "Me", ownerOnly: true },
];

function AppContent() {
  const { role, incrementOwnerClick, resetOwnerClicks, logout } = useAuth();
  const { loading, message } = useLoading();
  const [view, setView] = useState<View>("posts");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [newPostTrigger, setNewPostTrigger] = useState(0);
  const [newPhotoTrigger, setNewPhotoTrigger] = useState(0);
  const [brandTapCount, setBrandTapCount] = useState(0);
  const [tapFill, setTapFill] = useState({ originX: 0, originY: 0, maxRadius: 0 });
  const tapRef = useRef({ count: 0, last: 0 });
  const tapResetTimerRef = useRef<number | null>(null);
  const showOwner = role === "owner";

  useEffect(() => {
    document.body.dataset.view = view;
  }, [view]);

  useEffect(() => {
    const disableAuto = (el: HTMLInputElement | HTMLTextAreaElement) => {
      el.setAttribute("autocomplete", "off");
      el.setAttribute("autocorrect", "off");
      el.setAttribute("autocapitalize", "off");
      el.spellcheck = false;
    };
    document.querySelectorAll("input, textarea").forEach((el) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) disableAuto(el);
    });
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
            disableAuto(node);
          }
          if (node instanceof HTMLElement) {
            node.querySelectorAll("input, textarea").forEach((el) => {
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) disableAuto(el);
            });
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (tapResetTimerRef.current !== null) window.clearTimeout(tapResetTimerRef.current);
  }, []);

  useEffect(() => {
    Promise.all([listPosts(), listPhotos()]).then(([posts, photos]) => {
      const categorySet = new Set<string>();
      posts.forEach((p) => { if (p.category) categorySet.add(p.category); });
      photos.forEach((p) => { if (p.category) categorySet.add(p.category); });
      setCategories(Array.from(categorySet));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const tauri = (window as any).__TAURI__;
    if (!tauri) return;
    document.body.classList.add("desktop-app");

    const appWindow =
      tauri.webviewWindow?.getCurrentWebviewWindow?.() ||
      tauri.window?.getCurrentWindow?.() ||
      tauri.window?.getCurrent?.();
    const startWindowDrag = () => {
      const drag =
        appWindow?.startDragging ||
        tauri.window?.startDragging ||
        tauri.webviewWindow?.startDragging;
      return drag?.call(appWindow).catch?.(() => {});
    };

    const startDrag = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Node;
      const element = target.nodeType === Node.TEXT_NODE ? target.parentElement : (target as Element);
      if (!element) return;
      if (element.closest("button, a, input, textarea, select, dialog, .custom-select, .tabs, .photo-frame, .role")) return;

      const inTopbar = element.closest(".topbar");
      const inWindowChrome = event.clientY <= 86;
      const inResizeZone =
        event.clientX >= window.innerWidth - 18 ||
        event.clientY >= window.innerHeight - 18;
      if (inResizeZone) return;
      if (!inTopbar && !inWindowChrome) return;

      startWindowDrag();
    };

    document.addEventListener("mousedown", startDrag);
    return () => {
      document.removeEventListener("mousedown", startDrag);
    };
  }, []);

  useEffect(() => {
    const topbar = document.querySelector(".topbar") as HTMLElement | null;
    const tabs = document.querySelector(".tabs") as HTMLElement | null;
    if (!topbar || !tabs || !("ResizeObserver" in window)) return;

    const check = () => {};

    check();

    const ro = new ResizeObserver(check);
    ro.observe(topbar);
    ro.observe(tabs);

    return () => {
      ro.disconnect();
    };
  }, []);

  const handleBrandClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as Element).closest("button, a, input, textarea, select, dialog, .custom-select, .app-select-menu, .role")) return;
    const topbar = e.currentTarget;
    const rect = topbar.getBoundingClientRect();
    const originX = e.clientX - rect.left;
    const originY = e.clientY - rect.top;
    const maxRadius = Math.max(
      Math.hypot(originX, originY),
      Math.hypot(rect.width - originX, originY),
      Math.hypot(originX, rect.height - originY),
      Math.hypot(rect.width - originX, rect.height - originY),
    );

    const now = Date.now();
    const t = tapRef.current;

    if (t.count >= 7) return;

    const sequenceExpired = now - t.last > 1200;
    if (sequenceExpired) {
      resetOwnerClicks();
      t.count = 0;
    }

    if (t.count === 0) {
      setTapFill({ originX, originY, maxRadius });
    }

    t.count += 1;
    t.last = now;
    incrementOwnerClick();
    setBrandTapCount(t.count);
    if (tapResetTimerRef.current !== null) window.clearTimeout(tapResetTimerRef.current);

    if (t.count >= 7) {
      tapResetTimerRef.current = window.setTimeout(() => {
        tapRef.current.count = 0;
        setBrandTapCount(0);
        resetOwnerClicks();
        tapResetTimerRef.current = null;
        if (role === "owner") {
          logout();
          setLoginOpen(false);
          if (view === "chat" || view === "me") setView("posts");
        } else {
          setLoginOpen(true);
        }
      }, 220);
      return;
    }

    tapResetTimerRef.current = window.setTimeout(() => {
      tapRef.current.count = 0;
      setBrandTapCount(0);
      resetOwnerClicks();
      tapResetTimerRef.current = null;
    }, 1200);
  }, [role, view, incrementOwnerClick, resetOwnerClicks, logout]);

  const operationCard = (
    <aside className={`sidebar operation-card${view === "posts" ? " post-card" : ""}`} aria-label="操作">
      <div className="field sidebar-field">
        <label>搜索</label>
        <input
          placeholder="标题、正文、标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="field sidebar-field">
        <label>分类</label>
        <Select
          value={categoryFilter}
          ariaLabel="分类"
          onChange={setCategoryFilter}
          options={[{ value: "", label: "全部" }, ...categories.map((c) => ({ value: c, label: c }))]}
        />
      </div>
      <div className="field sidebar-field kind-field">
        <label>类型</label>
        <Select
          value={kindFilter}
          ariaLabel="类型"
          onChange={setKindFilter}
          options={[
            { value: "", label: "全部" },
            { value: "article", label: "文章" },
            { value: "thought", label: "想法" },
            { value: "note", label: "随手写" },
          ]}
        />
      </div>
      {showOwner && (
        <div className="sidebar-row">
          <button id="newPhotoBtn" className="primary" onClick={() => setNewPhotoTrigger(t => t + 1)} aria-label="上传照片" title="上传照片">
            <Upload size={18} strokeWidth={2} />
          </button>
          <button id="newPostBtn" className="primary" onClick={() => setNewPostTrigger(t => t + 1)} aria-label="写点什么" title="写点什么">
            <PenLine size={18} strokeWidth={2} />
          </button>
        </div>
      )}
    </aside>
  );

  return (
    <>
      <svg className="liquid-glass-defs" aria-hidden="true" focusable="false">
        <filter
          id="liquid-glass-refraction"
          x="-24%"
          y="-24%"
          width="148%"
          height="148%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.018"
            numOctaves="2"
            seed="37"
            result="liquid-noise"
          />
          <feGaussianBlur in="liquid-noise" stdDeviation="1.3" result="liquid-map" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="liquid-map"
            scale="18"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>

      <header className="topbar" onClick={handleBrandClick}>
        {brandTapCount > 0 && (
          <span
            className="topbar-tap-progress"
            style={{
              ["--tap-origin-x" as string]: `${tapFill.originX}px`,
              ["--tap-origin-y" as string]: `${tapFill.originY}px`,
              ["--tap-progress" as string]: `${(brandTapCount / 7) * tapFill.maxRadius}px`,
            }}
            aria-live="polite"
          />
        )}
        <nav className="tabs" aria-label="主导航">
          {tabs.map((t) => {
            if (t.ownerOnly && !showOwner) return null;
            return (
              <button
                key={t.key}
                className={`tab ${view === t.key ? "active" : ""}`}
                onClick={() => {
                  if (view === t.key) {
                    window.location.reload();
                  } else {
                    setView(t.key);
                  }
                }}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="role" onClick={(e) => { e.stopPropagation(); setLoginOpen(true); }}>
          {role === "owner" ? "主人" : "游客"}
        </div>
      </header>

      <main>
        <section className="workspace">
          {view === "posts" && (
            <PostsPage
              search={search}
              categoryFilter={categoryFilter}
              kindFilter={kindFilter}
              tagFilter={tagFilter}
              onCategoryFilterChange={setCategoryFilter}
              onKindFilterChange={setKindFilter}
              onTagFilterChange={setTagFilter}
              newPostTrigger={newPostTrigger}
              operationCard={operationCard}
            />
          )}
          {view === "photos" && (
            <PhotosPage
              search={search}
              categoryFilter={categoryFilter}
              newPhotoTrigger={newPhotoTrigger}
              operationCard={operationCard}
            />
          )}
          {view === "map" && <MapPage />}
          {view === "chat" && showOwner && <ChatPage />}
          {view === "me" && showOwner && <MePage />}
        </section>
      </main>

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      <AutoTooltip />
      {loading && (
        <div className="ai-loading-overlay">
          <div className="ai-loading-spinner" />
          {message && <span className="ai-loading-message">{message}</span>}
        </div>
      )}
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <LoadingProvider>
        <AppContent />
      </LoadingProvider>
    </AuthProvider>
  );
}

export default App;
