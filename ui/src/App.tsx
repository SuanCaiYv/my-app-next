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

  const operationCard = showOwner ? (
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
      <div className="sidebar-row">
        <button id="newPhotoBtn" className="primary" onClick={() => setNewPhotoTrigger(t => t + 1)}>
          上传照片
        </button>
        <button id="newPostBtn" className="primary" onClick={() => setNewPostTrigger(t => t + 1)}>
          写点什么
        </button>
      </div>
    </aside>
  ) : null;

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
