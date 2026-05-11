const state = {
  role: "guest",
  token: localStorage.getItem("ownerToken") || "",
  posts: [],
  photos: [],
  analyses: [],
  view: "posts",
  viewingPostId: null,
  analyzing: false,
  pickerMode: "posts",
  pickerTarget: "analysis",
  chatMessages: [],
  chatting: false,
  chatContext: { postIds: [], photoIds: [], freeText: "" },
  sentChatContext: { postIds: [], photoIds: [], freeText: "" },
  pendingChatFreeText: null,
  chatSessions: [],
  currentChatSessionId: null,
  chatUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model: "" },
  dateTimePicker: {
    selected: new Date(),
    visibleMonth: new Date(),
  },
  map: null,
  mapMarkers: [],
  photoPreviewLoadId: 0,
  photoPreviewScale: 1,
  photoPreviewPan: { x: 0, y: 0 },
  photoPreviewDrag: null,
  photoColumnCount: 0,
  photoResizeTimer: null,
  renderKeys: {},
};

const $ = (id) => document.getElementById(id);

function showPhotoPreviewBackdrop() {
  let backdrop = $("photoPreviewBackdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "photoPreviewBackdrop";
    backdrop.className = "photo-preview-backdrop-layer";
    document.body.appendChild(backdrop);
  }
  backdrop.hidden = false;
}

function hidePhotoPreviewBackdrop() {
  const backdrop = $("photoPreviewBackdrop");
  if (backdrop) backdrop.hidden = true;
}

function resetDialogPanelState(panel) {
  if (!panel) return;
  panel.getAnimations?.().forEach((animation) => animation.cancel());
  panel.style.willChange = "";
  panel.style.opacity = "";
  panel.style.transform = "";
}

async function closeAnimatedDialog(dialog, panelSelector) {
  if (!dialog?.open) return;
  const panel = dialog.querySelector(panelSelector);
  if (!panel || !panel.animate) {
    dialog.close();
    return;
  }
  panel.style.willChange = "transform, opacity, border-radius";
  const animation = panel.animate([
    { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    { opacity: 0, transform: "translate3d(0, 18px, 0) scale(0.96)" },
  ], {
    duration: 220,
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    fill: "both",
  });
  await animation.finished.catch(() => {});
  panel.style.willChange = "";
  if (dialog.open) dialog.close();
  animation.cancel();
  resetDialogPanelState(panel);
}

const api = async (path, options = {}) => {
  const headers = options.headers || {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
};

function showConfirm(message) {
  return new Promise((resolve) => {
    const dialog = $("confirmDialog");
    $("confirmMessage").textContent = message;
    const handler = () => {
      resolve(dialog.returnValue === "ok");
      dialog.removeEventListener("close", handler);
    };
    dialog.addEventListener("close", handler);
    dialog.showModal();
  });
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2200);
}

function kindName(kind) {
  return { article: "文章", thought: "想法", note: "随手写" }[kind] || kind;
}

function toDatetimeLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDatetimeLocal(value) {
  if (!value) return new Date();
  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

function formatDatetimeDisplay(value) {
  const date = parseDatetimeLocal(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTimeText(value) {
  return formatDatetimeDisplay(toDatetimeLocal(new Date(value)));
}

function setPostUpdatedAtValue(date) {
  const value = toDatetimeLocal(date);
  $("postUpdatedAt").value = value;
  $("postUpdatedAtDisplay").textContent = formatDatetimeDisplay(value);
}

function statusName(status) {
  return status === "published" ? "发布" : "草稿";
}

function statusPillClass(status) {
  return status === "published" ? "pill-status-published" : "pill-status-draft";
}

function escapeHtml(value = "") {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function matches(text, query) {
  return text.toLowerCase().includes(query.toLowerCase());
}

function photoMasonryColumnCount() {
  const photoList = $("photoList");
  if (!photoList || photoList.clientWidth === 0) return 3;
  const containerWidth = photoList.clientWidth;
  const minColumnWidth = 260;
  const gap = 18;
  return Math.max(1, Math.floor((containerWidth + gap) / (minColumnWidth + gap)));
}

function schedulePhotoLayoutRender() {
  if (state.view !== "photos") return;
  clearTimeout(state.photoResizeTimer);
  state.photoResizeTimer = setTimeout(() => {
    const nextColumnCount = photoMasonryColumnCount();
    if (nextColumnCount === state.photoColumnCount) return;
    state.renderKeys.photos = "";
    renderActiveView();
  }, 120);
}

function observePhotoGridSize() {
  const photoList = $("photoList");
  if (!photoList || !("ResizeObserver" in window)) return;
  const observer = new ResizeObserver(schedulePhotoLayoutRender);
  observer.observe(photoList);
}

function photoThumbnailUrl(photo) {
  return photo.thumbnail_url || photo.url;
}

function initDragRegion() {
  if (!window.__TAURI__) return;
  document.body.classList.add("desktop-app");
  const tauriWindow = window.__TAURI__.window;
  const appWindow = tauriWindow?.getCurrentWebviewWindow?.() || tauriWindow?.getCurrentWindow?.();
  if (!appWindow?.startDragging) return;

  const startDragging = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("a, input, textarea, select, dialog, .custom-select, .tabs, .photo-frame")) return;

    const inTopbar = event.target.closest(".topbar");
    const inWindowChrome = document.body.classList.contains("desktop-app") && event.clientY <= 86;
    if (!inTopbar && !inWindowChrome) return;

    appWindow.startDragging().catch(() => {});
  };

  document.addEventListener("mousedown", startDragging);
  document.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, a, input, textarea, select, dialog, .custom-select, .tabs, .photo-frame")) return;
    if (!event.target.closest(".topbar")) return;
    appWindow.toggleMaximize?.().catch(() => {});
  });
}

async function boot() {
  $("apiKey").value = localStorage.getItem("llmApiKey") || "";
  $("baseUrl").value = localStorage.getItem("llmBaseUrl") || "https://api.openai.com";
  const savedModel = localStorage.getItem("llmModel") || "gpt-4.1-mini";
  $("model").value = savedModel;
  const preset = [...$("modelPreset").options].find((option) => option.value === savedModel);
  $("modelPreset").value = preset ? savedModel : "custom";
  syncModelField();
  syncConfigPanel();
  await refreshRole();
  await loadAll();
  bindEvents();
  render();
  initDragRegion();
}

async function refreshRole() {
  const me = await api("/api/auth/me");
  state.role = me.role;
  document.body.classList.toggle("owner", state.role === "owner");
  $("roleLabel").textContent = state.role === "owner" ? "主人" : "游客";
}

async function loadAll() {
  const [posts, photos, analyses] = await Promise.all([
    api("/api/posts"),
    api("/api/photos"),
    state.role === "owner" ? api("/api/analyses") : Promise.resolve([]),
  ]);
  state.posts = posts;
  state.photos = photos;
  state.analyses = analyses;
  state.renderKeys = {};
  populateCategories();
  syncCustomSelect("categoryFilter");
  renderAnalysisPickers();
  renderChatPickers();
  renderAnalysisHistory();
  if (state.role === "owner") await loadChatSessions();
}

function populateCategories() {
  const categories = new Set([""]);
  state.posts.forEach((item) => item.category && categories.add(item.category));
  state.photos.forEach((item) => item.category && categories.add(item.category));
  $("categoryFilter").innerHTML = [...categories]
    .map((item) => `<option value="${escapeHtml(item)}">${item ? escapeHtml(item) : "全部"}</option>`)
    .join("");
}

function initCustomSelects() {
  document.querySelectorAll(".custom-select").forEach((custom) => {
    const select = $(custom.dataset.selectId);
    const button = custom.querySelector(".custom-select-button");
    button.addEventListener("click", () => {
      document.querySelectorAll(".custom-select.open").forEach((item) => {
        if (item !== custom) item.classList.remove("open");
      });
      custom.classList.toggle("open");
      syncCustomSelect(select.id);
    });
    syncCustomSelect(select.id);
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest(".custom-select")) return;
    document.querySelectorAll(".custom-select.open").forEach((item) => item.classList.remove("open"));
  });
}

function syncCustomSelect(selectId) {
  const select = $(selectId);
  if (!select) return;
  const custom = document.querySelector(`.custom-select[data-select-id="${selectId}"]`);
  if (!custom) return;
  const current = select.options[select.selectedIndex];
  const placeholder = custom.dataset.placeholder;
  custom.querySelector(".custom-select-button span").textContent =
    placeholder && !select.value ? placeholder : current?.textContent || "全部";
  custom.querySelector(".custom-select-menu").innerHTML = [...select.options].map((option) => `
    <button
      type="button"
      class="custom-select-option${option.value === select.value ? " selected" : ""}"
      data-value="${escapeHtml(option.value)}"
    >
      ${escapeHtml(option.textContent)}
    </button>
  `).join("");

  custom.querySelectorAll(".custom-select-option").forEach((option) => {
    option.addEventListener("click", () => {
      select.value = option.dataset.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      custom.classList.remove("open");
      syncCustomSelect(selectId);
    });
  });
}

function bindEvents() {
  let taps = 0;
  let lastTap = 0;
  $("brand").addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  $("brand").addEventListener("click", async (event) => {
    event.stopPropagation();
    const now = Date.now();
    taps = now - lastTap > 1200 ? 1 : taps + 1;
    lastTap = now;
    if (taps >= 7) {
      taps = 0;
      if (state.role === "owner") {
        state.token = "";
        localStorage.removeItem("ownerToken");
        await refreshRole();
        await loadAll();
        render();
        toast("已退出登录");
        return;
      }
      $("loginDialog").showModal();
      $("password").focus();
    }
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (state.view === tab.dataset.view) return;
      state.view = tab.dataset.view;
      render();
    });
  });

  ["search", "categoryFilter", "kindFilter"].forEach((id) => {
    $(id).addEventListener("input", render);
  });
  window.addEventListener("resize", () => {
    state.renderKeys.photos = "";
    if (state.view === "photos") renderPhotos();
  });
  initCustomSelects();
  $("postUpdatedAtDisplay").addEventListener("click", () => {
    openDateTimePicker();
  });
  $("prevPickerMonth").addEventListener("click", () => shiftPickerMonth(-1));
  $("nextPickerMonth").addEventListener("click", () => shiftPickerMonth(1));
  document.addEventListener("click", (event) => {
    if (event.target.closest("#datetimePopover") || event.target.closest("#postUpdatedAtDisplay")) return;
    $("datetimePopover").hidden = true;
  });

  async function doLogin() {
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: $("password").value }),
      });
      state.token = data.token;
      localStorage.setItem("ownerToken", data.token);
      $("loginDialog").close();
      await refreshRole();
      await loadAll();
      render();
      toast("已登录");
    } catch (error) {
      toast(error.message);
    }
  }

  $("password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      doLogin();
    }
  });

  $("newPostBtn").addEventListener("click", () => openPostDialog());
  $("deletePostBtn").addEventListener("click", deletePost);
  $("generateTitleBtn").addEventListener("click", generateTitle);

  ["postTitle", "postBody", "postCategory", "postTags"].forEach((id) => {
    $(id).addEventListener("input", debouncedSavePost);
  });
  $("postKind").addEventListener("change", debouncedSavePost);
  $("postStatus").addEventListener("change", debouncedSavePost);
  $("postUpdatedAt").addEventListener("change", debouncedSavePost);
  $("postDialog").addEventListener("close", () => savePost(true));
  $("closePostViewBtn").addEventListener("click", () => closePostView());

  // Click backdrop to close dialogs
  ["postViewDialog", "postDialog", "photoDialog", "pickerDialog", "photoPreviewDialog", "renameSessionDialog"].forEach((id) => {
    $(id).addEventListener("click", (e) => {
      if (id === "postViewDialog" && e.target === $(id)) {
        closePostView();
        return;
      }
      if (id === "photoPreviewDialog" && e.target === $(id)) {
        closePhotoPreview();
        return;
      }
      if (e.target === $(id)) $(id).close();
    });
  });
  $("editFromViewBtn").addEventListener("click", () => {
    const post = state.posts.find((item) => item.id === state.viewingPostId);
    $("postViewDialog").close();
    openPostDialog(post);
  });
  $("newPhotoBtn").addEventListener("click", () => openPhotoDialog());
  $("deletePhotoBtn").addEventListener("click", deletePhoto);

  ["photoTitle", "photoCategory", "photoTags", "photoDescription"].forEach((id) => {
    $(id).addEventListener("input", debouncedSavePhoto);
  });
  $("photoFile").addEventListener("change", debouncedSavePhoto);
  state._onPhotoDialogClose = () => {
    debouncedSavePhoto.cancel();
    savePhoto(true);
  };
  $("photoDialog").addEventListener("close", state._onPhotoDialogClose);
  $("postViewDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closePostView();
  });
  $("closePhotoPreviewBtn").addEventListener("click", () => closePhotoPreview());
  $("photoZoomInBtn").addEventListener("click", () => setPhotoPreviewScale(state.photoPreviewScale + 0.25));
  $("photoZoomOutBtn").addEventListener("click", () => setPhotoPreviewScale(state.photoPreviewScale - 0.25));
  $("photoZoomResetBtn").addEventListener("click", () => setPhotoPreviewScale(1));
  $("previewPhotoImage").addEventListener("wheel", (event) => {
    event.preventDefault();
    setPhotoPreviewScale(state.photoPreviewScale + (event.deltaY < 0 ? 0.16 : -0.16));
  }, { passive: false });
  $("previewPhotoImage").addEventListener("pointerdown", startPhotoPreviewPan);
  $("previewPhotoImage").addEventListener("dblclick", (event) => {
    event.preventDefault();
    resetPhotoPreviewTransform();
  });
  window.addEventListener("pointermove", movePhotoPreviewPan);
  window.addEventListener("pointerup", endPhotoPreviewPan);
  window.addEventListener("pointercancel", endPhotoPreviewPan);
  $("photoPreviewDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    closePhotoPreview();
  });
  $("photoPreviewDialog").addEventListener("close", () => {
    state.photoPreviewLoadId += 1;
    state.photoPreviewScale = 1;
    state.photoPreviewPan = { x: 0, y: 0 };
    state.photoPreviewDrag = null;
    hidePhotoPreviewBackdrop();
    $("photoPreviewDialog").classList.remove("loading");
    $("previewPhotoImage").removeAttribute("src");
  });
  $("runAnalyzeBtn").addEventListener("click", runAnalyze);
  $("chatForm").addEventListener("submit", sendChatMessage);
  $("chatInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    $("chatForm").requestSubmit();
  });
  $("chatInput").addEventListener("input", scheduleTokenMeterRender);
  $("chatFreeText").addEventListener("input", scheduleTokenMeterRender);
  $("clearChatBtn").addEventListener("click", () => {
    state.currentChatSessionId = null;
    state.chatMessages = [];
    state.chatContext = { postIds: [], photoIds: [], freeText: "" };
    state.sentChatContext = { postIds: [], photoIds: [], freeText: "" };
    state.chatting = false;
    resetChatUsage();
    $("chatFreeText").value = "";
    $("chatSessionSelect").value = "";
    syncCustomSelect("chatSessionSelect");
    syncChatSessionActions();
    restorePickerChecks("chatPosts", []);
    restorePickerChecks("chatPhotos", []);
    renderChatMessages();
    renderChatContextSummary();
  });
  $("newChatBtn").addEventListener("click", newChatSession);
  $("renameSessionBtn").addEventListener("click", openRenameChatSessionDialog);
  $("renameSessionForm").addEventListener("submit", renameChatSession);
  $("deleteSessionBtn").addEventListener("click", deleteChatSession);
  $("chatSessionSelect").addEventListener("change", (e) => {
    const id = e.target.value ? Number(e.target.value) : null;
    if (id) {
      switchChatSession(id);
    } else {
      resetChatState();
    }
  });
  ["apiKey", "baseUrl", "model"].forEach((id) => {
    $(id).addEventListener("input", persistLlmSettings);
  });
  $("model").addEventListener("input", scheduleTokenMeterRender);
  document.querySelectorAll("[data-open-picker]").forEach((button) => {
    button.addEventListener("click", () =>
      openPickerDialog(button.dataset.openPicker, button.dataset.pickerTarget || "analysis")
    );
  });
  document.querySelectorAll("[data-chat-select-all]").forEach((button) => {
    button.addEventListener("click", () => toggleChatContextSelection(button.dataset.chatSelectAll));
  });
  $("analysisPosts").addEventListener("click", (event) => {
    if (event.target.matches("input")) return;
    openPickerDialog("posts", "analysis");
  });
  $("analysisPhotos").addEventListener("click", (event) => {
    if (event.target.matches("input")) return;
    openPickerDialog("photos", "analysis");
  });
  $("chatPosts").addEventListener("click", (event) => {
    if (event.target.matches("input")) {
      updateChatSelectAllButtons();
      renderTokenMeter();
      return;
    }
    openPickerDialog("posts", "chat");
  });
  $("chatPhotos").addEventListener("click", (event) => {
    if (event.target.matches("input")) {
      updateChatSelectAllButtons();
      renderTokenMeter();
      return;
    }
    openPickerDialog("photos", "chat");
  });
  $("pickerDialog").addEventListener("close", applyPickerSelection);
  $("modelPreset").addEventListener("change", () => {
    if ($("modelPreset").value !== "custom") {
      $("model").value = $("modelPreset").value;
    }
    persistLlmSettings();
    syncModelField();
    renderTokenMeter();
  });
  $("toggleConfigBtn").addEventListener("click", () => {
    const collapsed = !$("llmConfigBody").hidden;
    localStorage.setItem("llmConfigCollapsed", collapsed ? "1" : "0");
    syncConfigPanel();
  });
  observePhotoGridSize();
  window.addEventListener("resize", schedulePhotoLayoutRender);
}

function syncModelField() {
  $("customModelField").style.display = $("modelPreset").value === "custom" ? "grid" : "none";
}

function currentModel() {
  return $("modelPreset").value === "custom" ? $("model").value : $("modelPreset").value;
}

const MODEL_CONTEXT_LIMITS = {
  "gpt-4.1": 1_000_000,
  "gpt-4.1-mini": 1_000_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4": 1_000_000,
  "deepseek-chat": 128_000,
  "deepseek-reasoner": 64_000,
  "qwen-plus": 131_072,
};
const DEFAULT_CONTEXT_LIMIT = 128_000;
const IMAGE_TOKEN_ESTIMATE = 1500;
const SYSTEM_PROMPT_TOKEN_ESTIMATE = 60;

function contextLimitForModel(name) {
  if (!name) return DEFAULT_CONTEXT_LIMIT;
  const key = name.trim().toLowerCase();
  if (MODEL_CONTEXT_LIMITS[key]) return MODEL_CONTEXT_LIMITS[key];
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (key.startsWith(prefix)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

function estimateTextTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk + other / 4);
}

function formatTokenCount(n) {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return n.toLocaleString("en-US");
}

function tokenMeterState(ratio) {
  if (ratio >= 0.85) return "danger";
  if (ratio >= 0.6) return "warn";
  return "safe";
}

function persistLlmSettings() {
  localStorage.setItem("llmApiKey", $("apiKey").value);
  localStorage.setItem("llmBaseUrl", $("baseUrl").value);
  localStorage.setItem("llmModel", currentModel());
  if (!$("llmSaveStatus")) return;
  $("llmSaveStatus").textContent = "已保存";
  $("llmSaveStatus").classList.add("saved");
  clearTimeout(persistLlmSettings.timer);
  persistLlmSettings.timer = setTimeout(() => {
    $("llmSaveStatus").classList.remove("saved");
  }, 900);
}

function syncConfigPanel() {
  const hasConfig = Boolean(localStorage.getItem("llmApiKey"));
  const collapsed = hasConfig && localStorage.getItem("llmConfigCollapsed") !== "0";
  $("llmConfigBody").hidden = collapsed;
  $("toggleConfigBtn").textContent = collapsed ? "展开设置" : "收起";
}

function render() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === state.view);
    tab.setAttribute("aria-current", tab.dataset.view === state.view ? "page" : "false");
  });
  syncViewShell();
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  $(`${state.view}View`).classList.add("active");
  renderActiveView();
}

function renderActiveView() {
  syncSidebarPlacement();

  if (state.view === "posts") {
    const key = viewRenderKey("posts", state.posts);
    if (state.renderKeys.posts !== key) {
      renderPosts();
      state.renderKeys.posts = key;
    }
    return;
  }

  if (state.view === "photos") {
    const key = viewRenderKey("photos", state.photos);
    if (state.renderKeys.photos !== key) {
      renderPhotos();
      state.renderKeys.photos = key;
    }
    return;
  }

  if (state.view === "map") {
    const key = viewRenderKey("map", state.photos);
    if (state.renderKeys.map !== key) {
      requestAnimationFrame(() => {
        renderPhotoMap();
        state.renderKeys.map = key;
      });
    }
  }
}

function viewRenderKey(view, items) {
  return [
    view,
    $("search").value.trim(),
    $("categoryFilter").value,
    view === "posts" ? $("kindFilter").value : "",
    items.map((item) => `${item.id}:${item.updated_at}`).join("|"),
  ].join("::");
}

function restoreSidebarToWorkspace() {
  const sidebar = document.querySelector(".sidebar");
  const workspace = document.querySelector(".workspace");
  if (sidebar && workspace && sidebar.parentElement !== workspace) {
    workspace.prepend(sidebar);
  }
}

function syncSidebarPlacement() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;

  if (state.view === "posts") {
    const postList = $("postList");
    if (postList && sidebar.parentElement !== postList) {
      postList.prepend(sidebar);
    }
    return;
  }

  if (state.view === "photos") {
    const firstColumn = $("photoList")?.querySelector(".photo-masonry-column");
    if (firstColumn && sidebar.parentElement !== firstColumn) {
      firstColumn.prepend(sidebar);
      return;
    }
  }

  restoreSidebarToWorkspace();
}

function syncViewShell() {
  document.body.dataset.view = state.view;
  const placeholders = {
    posts: "标题、正文、标签",
    photos: "照片标题、说明、标签",
    map: "照片标题、说明、标签",
    chat: "搜索上下文内容",
    analyze: "搜索待分析内容",
  };
  const searchInput = $("search");
  if (searchInput) searchInput.placeholder = placeholders[state.view] || "标题、正文、标签";
}

function filteredPosts() {
  const query = $("search").value.trim();
  const category = $("categoryFilter").value;
  const kind = $("kindFilter").value;
  return state.posts.filter((post) => {
    const haystack = `${post.title} ${post.body} ${post.category} ${post.tags}`;
    return (!query || matches(haystack, query)) &&
      (!category || post.category === category) &&
      (!kind || post.kind === kind);
  });
}

function renderPosts() {
  const posts = filteredPosts();
  const sidebar = document.querySelector(".sidebar");
  const postList = $("postList");
  const workspace = document.querySelector(".workspace");

  if (sidebar && workspace && postList) {
    if (state.view === "posts") {
      if (sidebar.parentElement !== postList) postList.prepend(sidebar);
    } else if (sidebar.parentElement === postList) {
      workspace.appendChild(sidebar);
    }
  }

  const cardsHtml = posts.length
    ? posts.map((post) => `
      <article class="post-card" data-view-post="${post.id}" tabindex="0">
        <div class="post-head">
          <div>
            <h2 class="post-title">${escapeHtml(post.title)}</h2>
            <div class="meta">
              <span class="pill pill-kind">${kindName(post.kind)}</span>
              <span class="pill pill-status ${statusPillClass(post.status)}">${statusName(post.status)}</span>
              ${post.category ? `<span class="pill pill-category">${escapeHtml(post.category)}</span>` : ""}
              ${post.tags ? `<span class="pill pill-tags">${escapeHtml(post.tags)}</span>` : ""}
              <span class="meta-date">${formatDateTimeText(post.updated_at)}</span>
            </div>
          </div>
        </div>
        <div class="body preview">${escapeHtml(post.body)}</div>
      </article>
    `).join("")
    : `<div class="empty">还没有可浏览的文字</div>`;

  if (state.view === "posts" && sidebar && sidebar.parentElement === postList) {
    Array.from(postList.children).forEach((child) => {
      if (child !== sidebar) child.remove();
    });
    postList.insertAdjacentHTML("beforeend", cardsHtml);
  } else {
    postList.innerHTML = cardsHtml;
  }

  document.querySelectorAll("[data-view-post]").forEach((card) => {
    card.addEventListener("click", () => {
      const post = state.posts.find((item) => item.id === Number(card.dataset.viewPost));
      openPostView(post);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const post = state.posts.find((item) => item.id === Number(card.dataset.viewPost));
        openPostView(post);
      }
    });
  });

}

function openPostView(post) {
  if (!post) return;
  state.viewingPostId = post.id;
  $("viewPostTitle").textContent = post.title;
  $("viewPostMeta").innerHTML = `
    <span class="pill pill-kind">${kindName(post.kind)}</span>
    <span class="pill pill-status ${statusPillClass(post.status)}">${statusName(post.status)}</span>
    ${post.category ? `<span class="pill pill-category">${escapeHtml(post.category)}</span>` : ""}
    ${post.tags ? `<span class="pill pill-tags">${escapeHtml(post.tags)}</span>` : ""}
    <span>${formatDateTimeText(post.updated_at)}</span>
  `;
  $("viewPostBody").textContent = post.body;
  const dialog = $("postViewDialog");
  resetDialogPanelState(dialog.querySelector(".reader"));
  dialog.showModal();
}

function closePostView() {
  closeAnimatedDialog($("postViewDialog"), ".reader");
}

function renderPhotos() {
  const query = $("search").value.trim();
  const category = $("categoryFilter").value;
  const photos = state.photos.filter((photo) => {
    const haystack = `${photo.title} ${photo.description} ${photo.category} ${photo.tags}`;
    return (!query || matches(haystack, query)) && (!category || photo.category === category);
  });

  const sidebar = document.querySelector(".sidebar");
  const photoList = $("photoList");

  if (!photos.length) {
    if (state.view === "photos" && sidebar && photoList) {
      if (sidebar.parentElement !== photoList) photoList.prepend(sidebar);
    }
    Array.from(photoList.children).forEach((child) => {
      if (child !== sidebar) child.remove();
    });
    if (!photoList.querySelector(".empty")) {
      photoList.insertAdjacentHTML("beforeend", `<div class="empty">还没有照片</div>`);
    }
    return;
  }

  const columnCount = photoMasonryColumnCount();
  state.photoColumnCount = columnCount;
  photoList.style.setProperty("--photo-columns", String(columnCount));
  const columns = Array.from({ length: columnCount }, () => []);
  photos.forEach((photo, index) => {
    columns[index % columns.length].push(photo);
  });

  if (sidebar && sidebar.closest("#photoList")) {
    const workspace = document.querySelector(".workspace");
    if (workspace) workspace.appendChild(sidebar);
  }

  photoList.innerHTML = columns.map((items) => `
    <div class="photo-masonry-column">
      ${items.map(renderPhotoCard).join("")}
    </div>
  `).join("");

  if (state.view === "photos" && sidebar) {
    const firstColumn = photoList.querySelector(".photo-masonry-column");
    if (firstColumn && sidebar.parentElement !== firstColumn) {
      firstColumn.prepend(sidebar);
    }
  }

  document.querySelectorAll("[data-preview-photo]").forEach((button) => {
    const preview = () => {
      const photo = state.photos.find((item) => item.id === Number(button.dataset.previewPhoto));
      openPhotoPreview(photo);
    };
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      preview();
    });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.detail !== 0) return;
      preview();
    });
  });

  document.querySelectorAll("[data-preview-photo-frame]").forEach((frame) => {
    frame.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".photo-actions")) return;
      event.preventDefault();
      const photo = state.photos.find((item) => item.id === Number(frame.dataset.previewPhotoFrame));
      openPhotoPreview(photo);
    });
  });

  document.querySelectorAll("[data-edit-photo]").forEach((button) => {
    button.addEventListener("click", () => {
      const photo = state.photos.find((item) => item.id === Number(button.dataset.editPhoto));
      openPhotoDialog(photo);
    });
  });

  balancePhotoMasonry();
  photoList.querySelectorAll(".photo-card img").forEach((image) => {
    if (image.complete) return;
    image.addEventListener("load", () => requestAnimationFrame(balancePhotoMasonry), { once: true });
  });
}

function renderPhotoCard(photo) {
  return `
    <article class="photo-card" data-photo-card="${photo.id}">
      <div class="photo-frame" data-preview-photo-frame="${photo.id}">
        <img src="${photoThumbnailUrl(photo)}" alt="${escapeHtml(photo.title || photo.original_name)}" loading="lazy" decoding="async" fetchpriority="low" />
        <div class="photo-actions">
          <button data-preview-photo="${photo.id}" title="预览" aria-label="预览">⤢</button>
          <a class="button-link" href="${photo.url}" download="${escapeHtml(photo.original_name || photo.filename)}" title="下载" aria-label="下载">↓</a>
          ${state.role === "owner" ? `<button data-edit-photo="${photo.id}" title="编辑" aria-label="编辑">✎</button>` : ""}
        </div>
        <div class="photo-info">
          <h3>${escapeHtml(photo.title || photo.original_name)}</h3>
          <div class="meta">
            ${photo.category ? `<span>${escapeHtml(photo.category)}</span>` : ""}
            ${photo.tags ? `<span>${escapeHtml(photo.tags)}</span>` : ""}
          </div>
          <p>${escapeHtml(photo.description)}</p>
        </div>
      </div>
    </article>
  `;
}

function balancePhotoMasonry() {
  if (state.view !== "photos") return;
  const photoList = $("photoList");
  if (!photoList) return;
  const columns = Array.from(photoList.querySelectorAll(".photo-masonry-column"));
  if (columns.length <= 1) return;

  const cardsById = new Map(
    Array.from(photoList.querySelectorAll(".photo-card")).map((card) => [
      Number(card.dataset.photoCard),
      card,
    ])
  );
  if (!cardsById.size) return;

  const columnGap = parseFloat(getComputedStyle(photoList).gap) || 18;
  const cardEntries = state.photos
    .map((photo) => cardsById.get(photo.id))
    .filter(Boolean)
    .map((card) => ({
      card,
      height: card.getBoundingClientRect().height,
    }));

  cardEntries.forEach(({ card }) => card.remove());

  const heights = columns.map((column) => {
    const sidebar = column.querySelector(".sidebar");
    return sidebar ? sidebar.getBoundingClientRect().height + columnGap : 0;
  });

  cardEntries.forEach(({ card, height }) => {
    const targetIndex = heights.indexOf(Math.min(...heights));
    columns[targetIndex].appendChild(card);
    heights[targetIndex] += height + columnGap;
  });
}

function openPhotoPreview(photo) {
  if (!photo) return;
  const title = photo.title || photo.original_name;
  const dialog = $("photoPreviewDialog");
  const image = $("previewPhotoImage");
  const loadId = ++state.photoPreviewLoadId;
  resetPhotoPreviewTransform();
  $("previewPhotoTitle").textContent = title;
  $("previewPhotoMeta").innerHTML = `
    ${photo.category ? `<span class="pill">${escapeHtml(photo.category)}</span>` : ""}
    ${photo.tags ? `<span>${escapeHtml(photo.tags)}</span>` : ""}
    <span>${formatDateTimeText(photo.updated_at)}</span>
  `;
  image.onload = null;
  image.onerror = null;
  image.src = "";
  image.removeAttribute("src");
  image.alt = title;
  $("previewPhotoDescription").textContent = photo.description || "";
  $("downloadPhotoLink").href = photo.url;
  $("downloadPhotoLink").download = photo.original_name || photo.filename || title;
  dialog.classList.add("loading");
  showPhotoPreviewBackdrop();
  setTimeout(() => {
    if (loadId !== state.photoPreviewLoadId) return;
    if (!dialog.open) {
      resetDialogPanelState(dialog.querySelector(".photo-preview-dialog"));
      dialog.showModal();
    }
    setTimeout(() => {
      if (loadId !== state.photoPreviewLoadId || !dialog.open) return;
      image.onload = () => {
        if (loadId === state.photoPreviewLoadId) dialog.classList.remove("loading");
      };
      image.onerror = () => {
        if (loadId === state.photoPreviewLoadId) dialog.classList.remove("loading");
      };
      image.decoding = "async";
      image.src = photo.url;
    }, 80);
  }, 30);
}

function setPhotoPreviewScale(scale) {
  const nextScale = Math.min(4, Math.max(0.5, Number(scale) || 1));
  state.photoPreviewScale = nextScale;
  if (nextScale <= 1) state.photoPreviewPan = { x: 0, y: 0 };
  applyPhotoPreviewTransform();
}

function setPhotoPreviewPan(x, y) {
  if (state.photoPreviewScale <= 1) {
    state.photoPreviewPan = { x: 0, y: 0 };
  } else {
    state.photoPreviewPan = { x, y };
  }
  applyPhotoPreviewTransform();
}

function resetPhotoPreviewTransform() {
  state.photoPreviewScale = 1;
  state.photoPreviewPan = { x: 0, y: 0 };
  applyPhotoPreviewTransform();
}

function applyPhotoPreviewTransform() {
  const image = $("previewPhotoImage");
  if (image) {
    image.style.setProperty("--preview-scale", String(state.photoPreviewScale));
    image.style.setProperty("--preview-pan-x", `${state.photoPreviewPan.x}px`);
    image.style.setProperty("--preview-pan-y", `${state.photoPreviewPan.y}px`);
    image.classList.toggle("is-zoomed", state.photoPreviewScale > 1);
  }
  const label = $("photoZoomResetBtn");
  if (label) label.textContent = `${Math.round(state.photoPreviewScale * 100)}%`;
}

function startPhotoPreviewPan(event) {
  if (state.photoPreviewScale <= 1 || event.button !== 0) return;
  event.preventDefault();
  const image = $("previewPhotoImage");
  image.setPointerCapture?.(event.pointerId);
  image.classList.add("is-panning");
  state.photoPreviewDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: state.photoPreviewPan.x,
    originY: state.photoPreviewPan.y,
  };
}

function movePhotoPreviewPan(event) {
  const drag = state.photoPreviewDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  setPhotoPreviewPan(
    drag.originX + event.clientX - drag.startX,
    drag.originY + event.clientY - drag.startY
  );
}

function endPhotoPreviewPan(event) {
  const drag = state.photoPreviewDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  $("previewPhotoImage").classList.remove("is-panning");
  state.photoPreviewDrag = null;
}

async function closePhotoPreview() {
  const dialog = $("photoPreviewDialog");
  const panel = dialog.querySelector(".photo-preview-dialog");
  resetPhotoPreviewTransform();
  await closeAnimatedDialog(dialog, ".photo-preview-dialog");
  if (panel) panel.style.transform = "";
}

function filteredPhotos() {
  const query = $("search").value.trim();
  const category = $("categoryFilter").value;
  return state.photos.filter((photo) => {
    const haystack = `${photo.title} ${photo.description} ${photo.category} ${photo.tags}`;
    return (!query || matches(haystack, query)) && (!category || photo.category === category);
  });
}

function renderPhotoMap() {
  if (state.view !== "map" || !$("photoMap")) return;
  const locatedPhotos = filteredPhotos().filter((photo) =>
    Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude)
  );

  if (!window.L) {
    $("photoMap").style.display = "none";
    $("mapFallback").innerHTML = `<div class="empty">地图资源未加载。可联网后刷新，或查看下方有位置的照片。</div>${mapPhotoList(locatedPhotos)}`;
    return;
  }

  $("photoMap").style.display = "block";
  $("mapFallback").innerHTML = locatedPhotos.length ? "" : `<div class="empty">还没有带位置信息的照片</div>`;

  if (!state.map) {
    state.map = L.map("photoMap");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.map);
  }

  state.mapMarkers.forEach((marker) => marker.remove());
  state.mapMarkers = locatedPhotos.map((photo) => {
    const marker = L.marker([photo.latitude, photo.longitude]).addTo(state.map);
    marker.bindPopup(`
      <div class="map-popup">
        <img src="${photoThumbnailUrl(photo)}" alt="${escapeHtml(photo.title || photo.original_name)}" loading="lazy" decoding="async" fetchpriority="low" />
        <strong>${escapeHtml(photo.title || photo.original_name)}</strong>
        ${photo.description ? `<p>${escapeHtml(photo.description)}</p>` : ""}
      </div>
    `);
    return marker;
  });

  setTimeout(() => {
    state.map.invalidateSize();
    if (locatedPhotos.length) {
      const bounds = L.latLngBounds(locatedPhotos.map((photo) => [photo.latitude, photo.longitude]));
      state.map.fitBounds(bounds.pad(0.25), { maxZoom: 14 });
    } else {
      state.map.setView([30, 105], 4);
    }
  }, 0);
}

function mapPhotoList(photos) {
  return photos.length
    ? `<div class="map-photo-list">${photos.map((photo) => `
        <article>
          <img src="${photoThumbnailUrl(photo)}" alt="${escapeHtml(photo.title || photo.original_name)}" loading="lazy" decoding="async" fetchpriority="low" />
          <span>${escapeHtml(photo.title || photo.original_name)}</span>
        </article>
      `).join("")}</div>`
    : "";
}

function renderAnalysisPickers() {
  renderPostPicker("analysisPosts");
  renderPhotoPicker("analysisPhotos");
}

function renderChatPickers() {
  renderPostPicker("chatPosts");
  renderPhotoPicker("chatPhotos");
  updateChatSelectAllButtons();
  renderChatMessages();
  renderChatContextSummary();
}

function renderPostPicker(containerId) {
  $(containerId).innerHTML = state.posts.map((post) => `
    <label class="check-item">
      <input type="checkbox" value="${post.id}" data-picker-source="posts" />
      <span>${kindName(post.kind)} · ${escapeHtml(post.title)}</span>
    </label>
  `).join("") || `<div class="empty compact">暂无文字</div>`;
}

function renderPhotoPicker(containerId) {
  $(containerId).innerHTML = state.photos.map((photo) => `
    <label class="check-item">
      <input type="checkbox" value="${photo.id}" data-picker-source="photos" />
      <img src="${photoThumbnailUrl(photo)}" alt="" class="check-thumb" loading="lazy" decoding="async" fetchpriority="low" />
      <span>${escapeHtml(photo.title || photo.original_name)}</span>
    </label>
  `).join("") || `<div class="empty compact">暂无照片</div>`;
}

function pickerContainer(mode, target = "analysis") {
  if (target === "chat") {
    return mode === "photos" ? $("chatPhotos") : $("chatPosts");
  }
  return mode === "photos" ? $("analysisPhotos") : $("analysisPosts");
}

function selectedPickerIds(mode, target = "analysis") {
  const container = pickerContainer(mode, target);
  return [...container.querySelectorAll("input:checked")].map((item) => Number(item.value));
}

function toggleChatContextSelection(mode) {
  const container = pickerContainer(mode, "chat");
  const inputs = [...container.querySelectorAll("input")];
  if (!inputs.length) return;
  const shouldSelect = inputs.some((input) => !input.checked);
  inputs.forEach((input) => {
    input.checked = shouldSelect;
  });
  updateChatSelectAllButtons();
  renderTokenMeter();
}

function updateChatSelectAllButtons() {
  document.querySelectorAll("[data-chat-select-all]").forEach((button) => {
    const mode = button.dataset.chatSelectAll;
    const inputs = [...pickerContainer(mode, "chat").querySelectorAll("input")];
    const allSelected = inputs.length > 0 && inputs.every((input) => input.checked);
    button.textContent = allSelected ? "清空" : "全选";
    button.disabled = inputs.length === 0;
  });
}

function openPickerDialog(mode, target = "analysis") {
  state.pickerMode = mode;
  state.pickerTarget = target;
  const items = mode === "photos" ? state.photos : state.posts;
  const selected = new Set(selectedPickerIds(mode, target));
  $("pickerDialogList").innerHTML = items.length
    ? items.map((item) => {
      const label = mode === "photos"
        ? `${item.title || item.original_name}${item.category ? ` · ${item.category}` : ""}`
        : `${kindName(item.kind)} · ${item.title}${item.category ? ` · ${item.category}` : ""}`;
      return `
        <label class="large-check-item">
          <input type="checkbox" value="${item.id}" ${selected.has(item.id) ? "checked" : ""} />
          ${mode === "photos" ? `<img src="${photoThumbnailUrl(item)}" alt="" class="check-thumb-large" loading="lazy" decoding="async" fetchpriority="low" />` : ""}
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    }).join("")
    : `<div class="empty">暂无${mode === "photos" ? "照片" : "文字"}</div>`;
  $("pickerDialog").showModal();
}

function applyPickerSelection() {
  const selected = new Set([...$("pickerDialogList").querySelectorAll("input:checked")].map((item) => item.value));
  const compact = pickerContainer(state.pickerMode, state.pickerTarget);
  compact.querySelectorAll("input").forEach((input) => {
    input.checked = selected.has(input.value);
  });
  $("pickerDialog").close();
  if (state.pickerTarget === "chat") {
    renderTokenMeter();
  }
}

function renderAnalysisHistory() {
  if (!$("analysisHistory")) return;
  $("analysisCount").textContent = state.analyses.length ? `${state.analyses.length} 条` : "";
  $("analysisHistory").innerHTML = state.analyses.length
    ? state.analyses.map((item) => `
      <div class="history-row">
        <button class="history-item" data-analysis-id="${item.id}">
          <span>${escapeHtml(item.subject || "未命名分析")}</span>
          <small>${escapeHtml(item.model)} · ${formatDateTimeText(item.created_at)}</small>
        </button>
        <button class="history-delete danger" data-delete-analysis="${item.id}">删除</button>
      </div>
    `).join("")
    : `<div class="empty compact">暂无分析历史</div>`;

  document.querySelectorAll("[data-analysis-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.analyses.find((analysis) => analysis.id === Number(button.dataset.analysisId));
      if (!item) return;
      $("analysisResult").innerHTML = renderMarkdown(item.answer);
      document.querySelectorAll(".history-item").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
    });
  });

  document.querySelectorAll("[data-delete-analysis]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!await showConfirm("确定删除这条分析历史？")) return;
      try {
        await api(`/api/analyses/${button.dataset.deleteAnalysis}`, { method: "DELETE" });
        state.analyses = state.analyses.filter((item) => item.id !== Number(button.dataset.deleteAnalysis));
        renderAnalysisHistory();
        toast("分析历史已删除");
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function renderChatMessages() {
  let html = "";
  if (state.chatMessages.length) {
    html = state.chatMessages.map((message) => `
      <article class="chat-message ${message.role}">
        <div class="chat-avatar">${message.role === "assistant" ? "AI" : "我"}</div>
        <div class="chat-bubble">
          <div class="markdown">${renderMarkdown(message.content)}</div>
        </div>
      </article>
    `).join("");
  } else if (!state.chatting) {
    html = `<div class="empty compact">选择上下文后开始提问</div>`;
  }

  if (state.chatting) {
    html += `
      <article class="chat-message assistant">
        <div class="chat-avatar">AI</div>
        <div class="chat-bubble loading">正在输入...</div>
      </article>
    `;
  }

  $("chatMessages").innerHTML = html;
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function renderChatContextSummary() {
  const parts = [];
  for (const id of state.chatContext.postIds) {
    const post = state.posts.find((p) => p.id === id);
    if (post) parts.push(`📄 ${escapeHtml(post.title)}`);
  }
  for (const id of state.chatContext.photoIds) {
    const photo = state.photos.find((p) => p.id === id);
    if (photo) parts.push(`🖼️ ${escapeHtml(photo.title || photo.original_name)}`);
  }
  if (state.chatContext.freeText) {
    parts.push("📝 指定片段");
  }
  const el = $("chatContextSummary");
  if (parts.length) {
    el.innerHTML = parts.map((p) => `<span class="pill">${p}</span>`).join("");
  } else {
    el.innerHTML = "";
  }
  renderTokenMeter();
}

function collectChatContextSnapshot() {
  const postIds = new Set(state.chatContext.postIds);
  const photoIds = new Set(state.chatContext.photoIds);
  const chatPosts = $("chatPosts");
  const chatPhotos = $("chatPhotos");
  if (chatPosts) {
    chatPosts.querySelectorAll("input:checked").forEach((input) => postIds.add(Number(input.value)));
  }
  if (chatPhotos) {
    chatPhotos.querySelectorAll("input:checked").forEach((input) => photoIds.add(Number(input.value)));
  }
  const freeTextEl = $("chatFreeText");
  const freeText = state.pendingChatFreeText ?? (freeTextEl ? freeTextEl.value : state.chatContext.freeText);
  return { postIds: [...postIds], photoIds: [...photoIds], freeText };
}

function estimatePromptTokens(snapshot, draftInput) {
  let total = SYSTEM_PROMPT_TOKEN_ESTIMATE;
  if (snapshot.freeText) {
    total += estimateTextTokens(snapshot.freeText) + 12;
  }
  for (const id of snapshot.postIds) {
    const post = state.posts.find((p) => p.id === id);
    if (post) {
      total += estimateTextTokens(post.title) + estimateTextTokens(post.body) + 24;
    }
  }
  total += snapshot.photoIds.length * IMAGE_TOKEN_ESTIMATE;
  for (const msg of state.chatMessages) {
    total += estimateTextTokens(msg.content) + 8;
  }
  if (draftInput) total += estimateTextTokens(draftInput);
  return total;
}

function renderTokenMeter() {
  const node = $("chatTokenMeter");
  if (!node) return;
  const model = currentModel();
  if (!model) {
    node.hidden = true;
    return;
  }

  const snapshot = collectChatContextSnapshot();
  const draftInput = $("chatInput") ? $("chatInput").value : "";
  const estimated = estimatePromptTokens(snapshot, draftInput);

  const confirmed = state.chatUsage.confirmed && state.chatUsage.model === model;
  const used = confirmed
    ? Math.max(state.chatUsage.totalTokens, estimated)
    : estimated;
  const limit = contextLimitForModel(model);
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
  const fillRatio = limit > 0 ? Math.min(used / limit, 1.02) : 0;

  node.hidden = false;
  node.dataset.state = tokenMeterState(ratio);

  const fill = node.querySelector(".token-meter-fill");
  if (fill) fill.style.width = `${Math.max(fillRatio * 100, used > 0 ? 1.5 : 0).toFixed(2)}%`;

  node.querySelector(".token-meter-used").textContent = formatTokenCount(used);
  node.querySelector(".token-meter-limit").textContent = formatTokenCount(limit);

  const percentValue = ratio * 100;
  let percentText;
  if (percentValue >= 10) percentText = `${percentValue.toFixed(0)}%`;
  else if (percentValue >= 1) percentText = `${percentValue.toFixed(1)}%`;
  else if (percentValue > 0) percentText = `${percentValue.toFixed(2)}%`;
  else percentText = "0%";
  node.querySelector(".token-meter-percent").textContent = percentText;

  const sourceEl = node.querySelector(".token-meter-source");
  if (sourceEl) {
    sourceEl.dataset.source = confirmed ? "actual" : "estimated";
    sourceEl.textContent = confirmed ? "实际" : "估算";
  }
}

let tokenMeterTimer = null;
function scheduleTokenMeterRender() {
  if (tokenMeterTimer) return;
  tokenMeterTimer = setTimeout(() => {
    tokenMeterTimer = null;
    renderTokenMeter();
  }, 80);
}

function resetChatUsage() {
  state.chatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, confirmed: false, model: "" };
}

async function loadChatSessions() {
  try {
    state.chatSessions = await api("/api/chat-sessions");
    renderChatSessionSelect();
  } catch (error) {
    console.error("loadChatSessions failed:", error);
  }
}

function renderChatSessionSelect() {
  const select = $("chatSessionSelect");
  select.innerHTML = '<option value="">新对话</option>' +
    state.chatSessions.map((s) =>
      `<option value="${s.id}">${escapeHtml(s.title)}</option>`
    ).join("");
  if (state.currentChatSessionId) {
    select.value = state.currentChatSessionId;
  }
  syncCustomSelect("chatSessionSelect");
  syncChatSessionActions();
}

function syncChatSessionActions() {
  const hasSession = Boolean(state.currentChatSessionId);
  $("renameSessionBtn").disabled = !hasSession;
  $("deleteSessionBtn").disabled = !hasSession;
}

function openDateTimePicker() {
  const selected = parseDatetimeLocal($("postUpdatedAt").value);
  state.dateTimePicker.selected = selected;
  state.dateTimePicker.visibleMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  renderDateTimePicker();
  $("datetimePopover").hidden = false;
}

function shiftPickerMonth(delta) {
  const current = state.dateTimePicker.visibleMonth;
  state.dateTimePicker.visibleMonth = new Date(current.getFullYear(), current.getMonth() + delta, 1);
  renderDateTimePicker();
}

function selectPickerDate(year, month, day) {
  const current = state.dateTimePicker.selected;
  state.dateTimePicker.selected = new Date(year, month, day, current.getHours(), current.getMinutes());
  state.dateTimePicker.visibleMonth = new Date(year, month, 1);
  setPostUpdatedAtValue(state.dateTimePicker.selected);
  renderDateTimePicker();
}

function selectPickerTime(part, value) {
  const current = state.dateTimePicker.selected;
  if (part === "hour") current.setHours(value);
  if (part === "minute") current.setMinutes(value);
  state.dateTimePicker.selected = new Date(current);
  setPostUpdatedAtValue(state.dateTimePicker.selected);
  renderDateTimePicker();
}

function renderDateTimePicker() {
  const selected = state.dateTimePicker.selected;
  const visible = state.dateTimePicker.visibleMonth;
  $("pickerMonthLabel").textContent = `${visible.getFullYear()}年${String(visible.getMonth() + 1).padStart(2, "0")}月`;

  const first = new Date(visible.getFullYear(), visible.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const today = new Date();
  $("pickerCalendar").innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const isMuted = date.getMonth() !== visible.getMonth();
    const isSelected = date.toDateString() === selected.toDateString();
    const isToday = date.toDateString() === today.toDateString();
    return `
      <button
        type="button"
        class="ios-day${isMuted ? " muted" : ""}${isSelected ? " selected" : ""}${isToday ? " today" : ""}"
        data-year="${date.getFullYear()}"
        data-month="${date.getMonth()}"
        data-day="${date.getDate()}"
      >${date.getDate()}</button>
    `;
  }).join("");
  $("pickerCalendar").querySelectorAll(".ios-day").forEach((button) => {
    button.addEventListener("click", () => selectPickerDate(
      Number(button.dataset.year),
      Number(button.dataset.month),
      Number(button.dataset.day),
    ));
  });

  $("pickerHours").innerHTML = Array.from({ length: 24 }, (_, hour) => `
    <button type="button" class="${hour === selected.getHours() ? "selected" : ""}" data-hour="${hour}">
      ${String(hour).padStart(2, "0")}
    </button>
  `).join("");
  $("pickerMinutes").innerHTML = Array.from({ length: 60 }, (_, minute) => `
    <button type="button" class="${minute === selected.getMinutes() ? "selected" : ""}" data-minute="${minute}">
      ${String(minute).padStart(2, "0")}
    </button>
  `).join("");
  $("pickerHours").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => selectPickerTime("hour", Number(button.dataset.hour)));
  });
  $("pickerMinutes").querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => selectPickerTime("minute", Number(button.dataset.minute)));
  });
  bindTimeWheelScroll("pickerHours", "hour");
  bindTimeWheelScroll("pickerMinutes", "minute");
  requestAnimationFrame(() => {
    $("pickerHours").querySelector(".selected")?.scrollIntoView({ block: "center" });
    $("pickerMinutes").querySelector(".selected")?.scrollIntoView({ block: "center" });
  });
}

function bindTimeWheelScroll(containerId, part) {
  const container = $(containerId);
  clearTimeout(container._scrollTimer);
  container.onscroll = () => {
    clearTimeout(container._scrollTimer);
    container._scrollTimer = setTimeout(() => settleTimeWheel(container, part), 90);
  };
}

function settleTimeWheel(container, part) {
  const buttons = [...container.querySelectorAll("button")];
  if (!buttons.length) return;
  const center = container.getBoundingClientRect().top + container.clientHeight / 2;
  const closest = buttons.reduce((best, button) => {
    const rect = button.getBoundingClientRect();
    const distance = Math.abs(rect.top + rect.height / 2 - center);
    return distance < best.distance ? { button, distance } : best;
  }, { button: buttons[0], distance: Infinity }).button;
  const value = Number(part === "hour" ? closest.dataset.hour : closest.dataset.minute);
  selectPickerTime(part, value);
}

async function switchChatSession(id) {
  try {
    const session = await api(`/api/chat-sessions/${id}`);
    state.currentChatSessionId = session.id;
    state.chatMessages = JSON.parse(session.messages || "[]");
    state.chatContext.postIds = JSON.parse(session.context_post_ids || "[]");
    state.chatContext.photoIds = JSON.parse(session.context_photo_ids || "[]");
    state.chatContext.freeText = session.context_free_text || "";
    state.sentChatContext = {
      postIds: [...state.chatContext.postIds],
      photoIds: [...state.chatContext.photoIds],
      freeText: state.chatContext.freeText,
    };
    resetChatUsage();
    restorePickerChecks("chatPosts", state.chatContext.postIds);
    restorePickerChecks("chatPhotos", state.chatContext.photoIds);
    $("chatFreeText").value = state.chatContext.freeText;
    syncChatSessionActions();
    renderChatMessages();
    renderChatContextSummary();
  } catch (error) {
    toast(error.message);
  }
}

function restorePickerChecks(containerId, ids) {
  const container = $(containerId);
  container.querySelectorAll("input").forEach((input) => {
    input.checked = ids.includes(Number(input.value));
  });
  if (containerId === "chatPosts" || containerId === "chatPhotos") {
    updateChatSelectAllButtons();
  }
}

async function newChatSession() {
  state.currentChatSessionId = null;
  state.chatMessages = [];
  state.chatContext = { postIds: [], photoIds: [], freeText: "" };
  state.sentChatContext = { postIds: [], photoIds: [], freeText: "" };
  state.chatting = false;
  resetChatUsage();
  $("chatFreeText").value = "";
  $("chatSessionSelect").value = "";
  syncCustomSelect("chatSessionSelect");
  syncChatSessionActions();
  restorePickerChecks("chatPosts", []);
  restorePickerChecks("chatPhotos", []);
  renderChatMessages();
  renderChatContextSummary();
}

function resetChatState() {
  newChatSession();
}

function openRenameChatSessionDialog() {
  if (!state.currentChatSessionId) return;
  const session = state.chatSessions.find((s) => s.id === state.currentChatSessionId);
  const currentTitle = session?.title || "新对话";
  $("renameSessionTitle").value = currentTitle;
  $("renameSessionDialog").showModal();
  requestAnimationFrame(() => {
    $("renameSessionTitle").focus();
    $("renameSessionTitle").select();
  });
}

async function renameChatSession(event) {
  event.preventDefault();
  if (!state.currentChatSessionId) return;
  const session = state.chatSessions.find((s) => s.id === state.currentChatSessionId);
  const currentTitle = session?.title || "新对话";
  const title = $("renameSessionTitle").value.trim();
  if (!title) {
    toast("会话名不能为空");
    return;
  }
  if (title === currentTitle) {
    $("renameSessionDialog").close();
    return;
  }

  try {
    const updated = await api(`/api/chat-sessions/${state.currentChatSessionId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (session) {
      session.title = updated.title;
      session.updated_at = updated.updated_at;
    }
    renderChatSessionSelect();
    $("renameSessionDialog").close();
    toast("会话已重命名");
  } catch (error) {
    toast(error.message);
  }
}

async function deleteChatSession() {
  if (!state.currentChatSessionId) return;
  if (!await showConfirm("确定删除这个会话？")) return;
  try {
    await api(`/api/chat-sessions/${state.currentChatSessionId}`, { method: "DELETE" });
    state.chatSessions = state.chatSessions.filter((s) => s.id !== state.currentChatSessionId);
    renderChatSessionSelect();
    newChatSession();
  } catch (error) {
    toast(error.message);
  }
}

async function saveChatSession() {
  const messagesJson = JSON.stringify(state.chatMessages);
  const contextPostIds = JSON.stringify(state.chatContext.postIds);
  const contextPhotoIds = JSON.stringify(state.chatContext.photoIds);
  const contextFreeText = state.chatContext.freeText;
  const firstUserMsg = state.chatMessages.find((m) => m.role === "user");
  const currentSession = state.chatSessions.find((s) => s.id === state.currentChatSessionId);
  const title = currentSession?.title || (firstUserMsg ? firstUserMsg.content.slice(0, 20) : "新对话");

  try {
    if (state.currentChatSessionId) {
      await api(`/api/chat-sessions/${state.currentChatSessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          messages: messagesJson,
          context_post_ids: contextPostIds,
          context_photo_ids: contextPhotoIds,
          context_free_text: contextFreeText,
        }),
      });
      const session = state.chatSessions.find((s) => s.id === state.currentChatSessionId);
      if (session) session.title = title;
    } else {
      const result = await api("/api/chat-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          messages: messagesJson,
          context_post_ids: contextPostIds,
          context_photo_ids: contextPhotoIds,
          context_free_text: contextFreeText,
        }),
      });
      state.currentChatSessionId = result.id;
      state.chatSessions.unshift({ id: result.id, title, created_at: result.created_at, updated_at: result.updated_at });
    }
    renderChatSessionSelect();
  } catch (error) {
    console.error("saveChatSession failed:", error);
    toast("保存会话失败: " + error.message);
  }
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (state.chatting) return;
  const content = $("chatInput").value.trim();
  if (!content) {
    toast("请输入对话内容");
    return;
  }
  persistLlmSettings();
  const model = currentModel();
  if (!$("apiKey").value.trim() || !model.trim()) {
    toast("先在 LLM 设置里填写 API Key 和模型");
    return;
  }

  const currentPostIds = [...new Set([...state.chatContext.postIds, ...selectedPickerIds("posts", "chat")])];
  const currentPhotoIds = [...new Set([...state.chatContext.photoIds, ...selectedPickerIds("photos", "chat")])];
  const currentFreeText = state.pendingChatFreeText ?? $("chatFreeText").value.trim();
  state.pendingChatFreeText = null;

  state.chatMessages.push({ role: "user", content });
  $("chatInput").value = "";
  $("chatFreeText").value = "";
  renderChatMessages();

  state.chatContext.postIds = currentPostIds;
  state.chatContext.photoIds = currentPhotoIds;
  state.chatContext.freeText = currentFreeText;

  state.chatting = true;

  try {
    const data = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: $("apiKey").value,
        base_url: $("baseUrl").value,
        model,
        post_ids: currentPostIds,
        photo_ids: currentPhotoIds,
        free_text: currentFreeText || null,
        messages: state.chatMessages,
      }),
    });
    state.chatMessages.push({ role: "assistant", content: data.answer });
    renderChatMessages();
    state.sentChatContext.postIds = [...currentPostIds];
    state.sentChatContext.photoIds = [...currentPhotoIds];
    state.sentChatContext.freeText = currentFreeText;
    $("chatPosts").querySelectorAll("input:checked").forEach((input) => { input.checked = false; });
    $("chatPhotos").querySelectorAll("input:checked").forEach((input) => { input.checked = false; });
    await saveChatSession();
    state.chatContext.freeText = "";
    state.sentChatContext.freeText = "";
    const usage = data.usage || {};
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
    state.chatUsage = {
      promptTokens,
      completionTokens,
      totalTokens,
      confirmed: true,
      model,
    };
    renderChatContextSummary();
  } catch (error) {
    state.chatMessages.push({ role: "assistant", content: error.message });
    renderChatMessages();
  } finally {
    state.chatting = false;
    renderChatMessages();
  }
}

function openPostDialog(post = null) {
  $("postId").value = post?.id || "";
  $("postTitle").value = post?.title || "";
  $("postBody").value = post?.body || "";
  $("postKind").value = post?.kind || "article";
  $("postStatus").value = post?.status || "draft";
  $("postCategory").value = post?.category || "";
  $("postTags").value = post?.tags || "";
  syncCustomSelect("postKind");
  syncCustomSelect("postStatus");
  setPostUpdatedAtValue(post?.updated_at ? new Date(post.updated_at) : new Date());
  $("datetimePopover").hidden = true;
  $("deletePostBtn").style.display = post ? "" : "none";
  $("postDialog").showModal();
}

async function savePost(closeAfter = true) {
  const title = $("postTitle").value.trim();
  const body = $("postBody").value.trim();
  if (!title && !body) return;

  const id = $("postId").value;
  const dt = $("postUpdatedAt").value;
  const payload = {
    title: $("postTitle").value,
    body: $("postBody").value,
    kind: $("postKind").value,
    status: $("postStatus").value,
    category: $("postCategory").value,
    tags: $("postTags").value,
    updated_at: dt ? dt + ":00" : undefined,
  };
  try {
    const result = await api(id ? `/api/posts/${id}` : "/api/posts", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!id && result?.id) {
      $("postId").value = result.id;
    }
    if (closeAfter) $("postDialog").close();
    await loadAll();
    render();
    if (closeAfter) toast("已保存");
  } catch (error) {
    toast(error.message);
  }
}

const debouncedSavePost = (() => {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => savePost(false), 800);
  };
})();

async function generateTitle(event) {
  event.preventDefault();
  const body = $("postBody").value.trim();
  if (!body) {
    toast("先写一点内容");
    return;
  }
  const model = currentModel();
  if (!$("apiKey").value.trim() || !model.trim()) {
    toast("先在 LLM 分析页填写 API Key 和模型");
    return;
  }
  persistLlmSettings();
  $("generateTitleBtn").textContent = "...";
  $("generateTitleBtn").disabled = true;
  try {
    const data = await api("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: $("apiKey").value,
        base_url: $("baseUrl").value,
        model,
        prompt: "请为下面这篇个人文章或随手想法生成一个中文标题。标题要自然、具体、有记忆点，不要夸张，不要使用书名号，不要解释，只返回一个标题，最多 18 个中文字符。",
        free_text: `分类：${$("postCategory").value || "未分类"}\n标签：${$("postTags").value || "无"}\n正文：\n${body}`,
        post_ids: [],
        photo_ids: [],
        save: false,
      }),
    });
    $("postTitle").value = cleanTitle(data.answer);
    toast("标题已生成");
  } catch (error) {
    toast(error.message);
  } finally {
    $("generateTitleBtn").textContent = "AI";
    $("generateTitleBtn").disabled = false;
  }
}

function cleanTitle(value = "") {
  return value
    .trim()
    .replace(/^["'“”‘’《》]+|["'“”‘’《》]+$/g, "")
    .split("\n")[0]
    .replace(/^标题[:：]\s*/, "")
    .trim();
}

async function deletePost(event) {
  event.preventDefault();
  const id = $("postId").value;
  if (!id || !await showConfirm("确定删除这条内容？")) return;
  await api(`/api/posts/${id}`, { method: "DELETE" });
  $("postDialog").close();
  await loadAll();
  render();
  toast("已删除");
}

function openPhotoDialog(photo = null) {
  $("photoId").value = photo?.id || "";
  $("photoTitle").value = photo?.title || "";
  $("photoCategory").value = photo?.category || "";
  $("photoTags").value = photo?.tags || "";
  $("photoDescription").value = photo?.description || "";
  $("photoFile").value = "";
  $("fileField").style.display = photo ? "none" : "grid";
  $("deletePhotoBtn").style.visibility = photo ? "visible" : "hidden";
  $("photoDialog").showModal();
}

async function savePhoto(closeAfter = true) {
  const id = $("photoId").value;
  try {
    if (id) {
      await api(`/api/photos/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: $("photoTitle").value,
          category: $("photoCategory").value,
          tags: $("photoTags").value,
          description: $("photoDescription").value,
        }),
      });
    } else {
      const file = $("photoFile").files[0];
      if (!file) return;
      const form = new FormData();
      form.append("file", file);
      form.append("title", $("photoTitle").value);
      form.append("category", $("photoCategory").value);
      form.append("tags", $("photoTags").value);
      form.append("description", $("photoDescription").value);
      const result = await api("/api/photos", { method: "POST", body: form });
      $("photoId").value = result.id;
    }
    if (closeAfter) $("photoDialog").close();
    await loadAll();
    render();
    if (closeAfter) toast("已保存");
  } catch (error) {
    toast(error.message);
  }
}

const debouncedSavePhoto = (() => {
  let timer;
  const fn = () => {
    clearTimeout(timer);
    timer = setTimeout(() => savePhoto(false), 800);
  };
  fn.cancel = () => clearTimeout(timer);
  return fn;
})();

async function deletePhoto(event) {
  event.preventDefault();
  const id = $("photoId").value;
  console.log("[deletePhoto] clicked, id:", id);
  if (!id || !await showConfirm("确定删除这张照片？")) {
    console.log("[deletePhoto] cancelled, id empty or confirm declined");
    return;
  }
  const handler = state._onPhotoDialogClose;
  if (handler) $("photoDialog").removeEventListener("close", handler);
  console.log("[deletePhoto] sending DELETE /api/photos/" + id);
  try {
    const result = await api(`/api/photos/${id}`, { method: "DELETE" });
    console.log("[deletePhoto] DELETE success, result:", result);
    state.photos = state.photos.filter((p) => String(p.id) !== id);
    console.log("[deletePhoto] filtered state.photos, new count:", state.photos.length);
    $("photoId").value = "";
    $("photoDialog").close();
    console.log("[deletePhoto] calling render()");
    render();
    toast("已删除");
  } catch (err) {
    console.error("[deletePhoto] DELETE failed:", err);
    toast("删除失败: " + err.message);
  } finally {
    if (handler) $("photoDialog").addEventListener("close", handler);
    console.log("[deletePhoto] done");
  }
}

async function runAnalyze() {
  if (state.analyzing) return;
  persistLlmSettings();
  const model = currentModel();
  const postIds = selectedPickerIds("posts", "analysis");
  const photoIds = selectedPickerIds("photos", "analysis");
  state.analyzing = true;
  $("runAnalyzeBtn").disabled = true;
  $("runAnalyzeBtn").textContent = "分析中...";
  $("analysisResult").textContent = "分析中...";
  try {
    const data = await api("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: $("apiKey").value,
        base_url: $("baseUrl").value,
        model,
        prompt: $("analysisPrompt").value,
        free_text: $("freeText").value,
        post_ids: postIds,
        photo_ids: photoIds,
        save: true,
      }),
    });
    $("analysisResult").innerHTML = renderMarkdown(data.answer);
    localStorage.setItem("llmConfigCollapsed", "1");
    syncConfigPanel();
    state.analyses = await api("/api/analyses");
    renderAnalysisHistory();
  } catch (error) {
    $("analysisResult").textContent = error.message;
  } finally {
    state.analyzing = false;
    $("runAnalyzeBtn").disabled = false;
    $("runAnalyzeBtn").textContent = "开始分析";
  }
}

function renderMarkdown(source = "") {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listOpen = false;
  let listType = "";

  const closeList = () => {
    if (listOpen) {
      html += `</${listType}>`;
      listOpen = false;
      listType = "";
    }
  };

  const openList = (type) => {
    if (listOpen && listType !== type) closeList();
    if (!listOpen) {
      html += `<${type}>`;
      listOpen = true;
      listType = type;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      html += `<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      openList("ul");
      html += `<li>${inlineMarkdown(bullet[1])}</li>`;
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      openList("ol");
      html += `<li>${inlineMarkdown(ordered[1])}</li>`;
      continue;
    }
    closeList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  }
  closeList();
  return html || "";
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

boot().catch((error) => toast(error.message));
