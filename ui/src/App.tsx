import { useEffect, useState, useRef, useCallback } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { listPosts, listPhotos } from "./api";
import PostsPage from "./pages/Posts";
import PhotosPage from "./pages/Photos";
import MapPage from "./pages/Map";
import ChatPage from "./pages/Chat";
import AnalyzePage from "./pages/Analyze";
import LoginDialog from "./components/LoginDialog";
import Select from "./components/Select";

type View = "posts" | "photos" | "map" | "chat" | "analyze";

const tabs: { key: View; label: string; ownerOnly: boolean }[] = [
  { key: "posts", label: "文字", ownerOnly: false },
  { key: "photos", label: "照片", ownerOnly: false },
  { key: "map", label: "地图", ownerOnly: false },
  { key: "chat", label: "对话", ownerOnly: true },
  { key: "analyze", label: "LLM", ownerOnly: true },
];

function AppContent() {
  const { role, ownerClickCount, incrementOwnerClick, logout } = useAuth();
  const [view, setView] = useState<View>("posts");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [newPostTrigger, setNewPostTrigger] = useState(0);
  const [newPhotoTrigger, setNewPhotoTrigger] = useState(0);
  const tapRef = useRef({ count: 0, last: 0 });
  const showOwner = role === "owner" || ownerClickCount >= 7;

  useEffect(() => {
    document.body.dataset.view = view;
  }, [view]);

  useEffect(() => {
    Promise.all([listPosts(), listPhotos()]).then(([posts, photos]) => {
      const set = new Set<string>();
      posts.forEach((p) => { if (p.category) set.add(p.category); });
      photos.forEach((p) => { if (p.category) set.add(p.category); });
      setCategories(Array.from(set));
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
      if ((event.target as Element)?.closest("button, a, input, textarea, select, dialog, .custom-select, .tabs, .photo-frame")) return;

      const inTopbar = (event.target as Element)?.closest(".topbar");
      const inWindowChrome = event.clientY <= 86;
      const inResizeZone =
        event.clientX >= window.innerWidth - 18 ||
        event.clientY >= window.innerHeight - 18;
      if (inResizeZone) return;
      if (!inTopbar && !inWindowChrome) return;

      startWindowDrag();
    };

    const dblClick = (event: MouseEvent) => {
      if ((event.target as Element)?.closest("button, a, input, textarea, select, dialog, .custom-select, .tabs, .photo-frame")) return;
      if (!(event.target as Element)?.closest(".topbar")) return;
      appWindow.toggleMaximize?.().catch(() => {});
    };

    document.addEventListener("mousedown", startDrag);
    document.addEventListener("dblclick", dblClick);
    return () => {
      document.removeEventListener("mousedown", startDrag);
      document.removeEventListener("dblclick", dblClick);
    };
  }, []);

  useEffect(() => {
    const topbar = document.querySelector(".topbar") as HTMLElement | null;
    const brand = document.querySelector(".brand") as HTMLElement | null;
    const tabs = document.querySelector(".tabs") as HTMLElement | null;
    if (!topbar || !brand || !tabs || !("ResizeObserver" in window)) return;

    let brandWidth = 0;

    const check = () => {
      const style = getComputedStyle(topbar);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingRight = parseFloat(style.paddingRight) || 0;
      const contentWidth = topbar.clientWidth - paddingLeft - paddingRight;

      const tabsWidth = tabs.offsetWidth;
      if (!brand.classList.contains("hidden") && brand.offsetWidth > 0) {
        brandWidth = brand.offsetWidth;
      }

      const role = document.querySelector(".role") as HTMLElement | null;
      const roleWidth = role && role.offsetWidth > 0 ? role.offsetWidth : 0;

      const needed = brandWidth + tabsWidth + roleWidth + 40;

      if (contentWidth < needed) {
        brand.classList.add("hidden");
      } else {
        brand.classList.remove("hidden");
      }
    };

    const ro = new ResizeObserver(check);
    ro.observe(topbar);
    ro.observe(tabs);
    ro.observe(brand);

    const mo = new MutationObserver(check);
    mo.observe(tabs, { childList: true, subtree: true, attributes: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  const handleBrandClick = useCallback(() => {
    incrementOwnerClick();
    const now = Date.now();
    const t = tapRef.current;
    t.count = now - t.last > 1200 ? 1 : t.count + 1;
    t.last = now;
    if (t.count >= 7) {
      t.count = 0;
      if (role === "owner") {
        logout();
        setLoginOpen(false);
        if (view === "chat" || view === "analyze") setView("posts");
      } else {
        setLoginOpen(true);
      }
    }
  }, [role, view, incrementOwnerClick, logout]);

  const handleBrandDblClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

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
          <button id="newPhotoBtn" className="primary" onClick={() => setNewPhotoTrigger(t => t + 1)}>
            上传照片
          </button>
          <button id="newPostBtn" className="primary" onClick={() => setNewPostTrigger(t => t + 1)}>
            写点什么
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

      <header className="topbar" data-tauri-drag-region>
        <button
          className="brand"
          title="Hello.me"
          onClick={handleBrandClick}
          onDoubleClick={handleBrandDblClick}
          onMouseDown={(e) => e.preventDefault()}
        >
          <img src="/assets/logo.png" alt="" />
          <span>Hello.me</span>
        </button>
        <nav className="tabs" aria-label="主导航">
          {tabs.map((t) => {
            if (t.ownerOnly && !showOwner) return null;
            return (
              <button
                key={t.key}
                className={`tab ${view === t.key ? "active" : ""}`}
                onClick={() => setView(t.key)}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        <div className="role" onClick={() => setLoginOpen(true)}>
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
          {view === "analyze" && showOwner && <AnalyzePage />}
        </section>
      </main>

      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
