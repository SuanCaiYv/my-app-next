import { useEffect, useMemo, useState, useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { useAuth } from "../context/AuthContext";
import { listPhotos, uploadPhoto, updatePhoto, deletePhoto } from "../api";
import type { PhotoItem } from "../types";
import { useToast } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";

function formatDateTimeText(value: string) {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ImageSize {
  width: number;
  height: number;
}

export default function PhotosPage({
  search,
  categoryFilter,
  newPhotoTrigger,
  operationCard,
}: {
  search: string;
  categoryFilter: string;
  newPhotoTrigger?: number;
  operationCard?: ReactNode;
}) {
  const { role } = useAuth();
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewPhoto, setPreviewPhoto] = useState<PhotoItem | null>(null);
  const [previewInitialSize, setPreviewInitialSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [editPhoto, setEditPhoto] = useState<PhotoItem | null>(null);
  const { show: showToast, element: toastElement } = useToast();
  const { confirm: confirmDialog, element: confirmElement } = useConfirm();
  const [gridWidth, setGridWidth] = useState(0);
  const [photoHeights, setPhotoHeights] = useState<Record<number, number>>({});
  const gridRef = useRef<HTMLDivElement>(null);
  const handledNewPhotoTrigger = useRef(newPhotoTrigger || 0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listPhotos();
      setPhotos(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (newPhotoTrigger && newPhotoTrigger > handledNewPhotoTrigger.current) {
      handledNewPhotoTrigger.current = newPhotoTrigger;
      setEditPhoto({ id: 0, title: "", description: "", category: "", tags: "", filename: "", original_name: "", mime: "", url: "", thumbnail_url: "", latitude: null, longitude: null, created_at: "", updated_at: "" } as PhotoItem);
    }
  }, [newPhotoTrigger]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return photos.filter((p) => {
      const hay = `${p.title} ${p.description} ${p.category} ${p.tags}`.toLowerCase();
      return (!q || hay.includes(q)) && (!categoryFilter || p.category === categoryFilter);
    });
  }, [photos, search, categoryFilter]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const updateWidth = () => setGridWidth(grid.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const columnCount = useMemo(() => {
    if (!gridWidth) return 3;
    const minColumnWidth = 300;
    const gap = 18;
    return Math.max(1, Math.floor((gridWidth + gap) / (minColumnWidth + gap)));
  }, [gridWidth]);

  const measurePhotoCard = useCallback((photoId: number, card?: Element | null) => {
    const target = card || gridRef.current?.querySelector(`[data-photo-card="${photoId}"]`);
    if (!target) return;
    const height = Math.round(target.getBoundingClientRect().height);
    if (height <= 0) return;
    setPhotoHeights((prev) => (prev[photoId] === height ? prev : { ...prev, [photoId]: height }));
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      filtered.forEach((photo) => measurePhotoCard(photo.id));
    });
    return () => cancelAnimationFrame(frame);
  }, [filtered, columnCount, measurePhotoCard]);

  const columns = useMemo(() => {
    const cols: PhotoItem[][] = Array.from({ length: columnCount }, () => []);
    const heights = Array.from({ length: columnCount }, () => 0);
    filtered.forEach((photo) => {
      const targetIndex = heights.indexOf(Math.min(...heights));
      cols[targetIndex].push(photo);
      heights[targetIndex] += (photoHeights[photo.id] || 320) + 18;
    });
    return cols;
  }, [filtered, columnCount, photoHeights]);

  const handlePreview = useCallback((photo: PhotoItem) => {
    const img = new Image();
    img.onload = () => {
      setPreviewInitialSize({ width: img.naturalWidth, height: img.naturalHeight });
      setPreviewPhoto(photo);
    };
    img.onerror = () => {
      setPreviewInitialSize({ width: 0, height: 0 });
      setPreviewPhoto(photo);
    };
    img.src = photo.url;
  }, []);

  const handleClosePreview = useCallback(() => {
    setPreviewPhoto(null);
    setPreviewInitialSize({ width: 0, height: 0 });
  }, []);

  const handleSave = async (photo: Partial<PhotoItem>, file?: File) => {
    try {
      if (editPhoto?.id && !file) {
        await updatePhoto(editPhoto.id, photo);
      } else {
        const form = new FormData();
        if (file) form.append("file", file);
        form.append("title", photo.title || "");
        form.append("category", photo.category || "");
        form.append("tags", photo.tags || "");
        form.append("description", photo.description || "");
        await uploadPhoto(form);
      }
      setEditPhoto(null);
      await load();
      showToast("已保存");
    } catch (err: any) {
      showToast(err.message);
      throw err;
    }
  };

  const handleDelete = async () => {
    if (!editPhoto?.id) return;
    if (!(await confirmDialog("确定删除这张照片？"))) return;
    try {
      await deletePhoto(editPhoto.id);
      setEditPhoto(null);
      await load();
      showToast("已删除");
    } catch (err: any) {
      showToast(err.message);
    }
  };

  return (
    <section className="view active" id="photosView">
      <div
        id="photoList"
        className="photo-grid"
        ref={gridRef}
      >
        {loading ? (
          <>
            {operationCard}
            <div className="empty">加载中...</div>
          </>
        ) : filtered.length === 0 ? (
          <>
            {operationCard}
            <div className="empty">还没有照片</div>
          </>
        ) : (
          columns.map((column, columnIndex) => (
            <div key={columnIndex} className="photo-masonry-column">
              {columnIndex === 0 && operationCard}
              {column.map((photo) => (
                <article key={photo.id} className="photo-card" data-photo-card={photo.id}>
                  <div className="photo-frame" onClick={() => handlePreview(photo)}>
                    <img
                      src={photo.thumbnail_url || photo.url}
                      alt={photo.title || photo.original_name}
                      loading="lazy"
                      decoding="async"
                      onLoad={(e) => measurePhotoCard(photo.id, e.currentTarget.closest(".photo-card"))}
                    />
                    {role === "owner" && (
                      <div className="photo-actions">
                        <button title="预览" aria-label="预览" onClick={(e) => { e.stopPropagation(); handlePreview(photo); }}>⤢</button>
                        <a className="button-link" href={photo.url} download={photo.original_name || photo.filename} title="下载" aria-label="下载" onClick={(e) => e.stopPropagation()}>↓</a>
                        <button title="编辑" aria-label="编辑" onClick={(e) => { e.stopPropagation(); setEditPhoto(photo); }}>✎</button>
                      </div>
                    )}
                    <div className="photo-info">
                      <h3>{photo.title || photo.original_name}</h3>
                      <div className="meta">
                        {photo.category && <span>{photo.category}</span>}
                        {photo.tags && <span>{photo.tags}</span>}
                      </div>
                      <p>{photo.description}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ))
        )}
      </div>

      <PhotoPreviewDialog photo={previewPhoto} initialSize={previewInitialSize} onClose={handleClosePreview} />
      <PhotoEditDialog
        photo={editPhoto}
        onClose={() => setEditPhoto(null)}
        onSave={handleSave}
        onDelete={handleDelete}
      />

      {confirmElement}
      {toastElement}
    </section>
  );
}

function PhotoPreviewDialog({ photo, initialSize, onClose }: { photo: PhotoItem | null; initialSize: ImageSize; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<null | { startX: number; startY: number; originX: number; originY: number }>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (photo) {
      setScale(1);
      setPan({ x: 0, y: 0 });
      setDrag(null);
      if (initialSize.width > 0 && initialSize.height > 0) {
        setImageSize(initialSize);
        setLoading(false);
      } else {
        setImageSize({ width: 0, height: 0 });
        setLoading(true);
      }
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [photo, initialSize]);

  useEffect(() => {
    const updateViewportSize = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", updateViewportSize);
    return () => window.removeEventListener("resize", updateViewportSize);
  }, []);

  if (!photo) return null;
  const title = photo.title || photo.original_name;
  const location = Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude)
    ? `${Number(photo.latitude).toFixed(5)}, ${Number(photo.longitude).toFixed(5)}`
    : "";
  const clampScale = (value: number) => Math.min(5, Math.max(1, value));
  const setPreviewScale = (value: number) => {
    const next = clampScale(value);
    setScale(next);
    if (next === 1) setPan({ x: 0, y: 0 });
  };
  const maxPreviewWidth = Math.max(320, viewportSize.width - 56);
  const maxPreviewHeight = Math.max(320, viewportSize.height - 56);
  const imageAspect = imageSize.width && imageSize.height ? imageSize.width / imageSize.height : 4 / 3;
  const previewWidth = maxPreviewWidth / maxPreviewHeight > imageAspect
    ? Math.round(maxPreviewHeight * imageAspect)
    : maxPreviewWidth;
  const previewHeight = maxPreviewWidth / maxPreviewHeight > imageAspect
    ? maxPreviewHeight
    : Math.round(maxPreviewWidth / imageAspect);

  return (
    <dialog ref={dialogRef} id="photoPreviewDialog" className={`photo-preview-dialog-overlay${loading ? " loading" : ""}`} onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section
        className="dialog-body wide photo-preview-dialog"
        style={{
          width: `${previewWidth}px`,
          height: `${previewHeight}px`,
          aspectRatio: imageAspect,
        }}
      >
        <header className="photo-preview-header">
          <div>
            <h3>{title}</h3>
            <div className="meta">
              {location && <span>{location}</span>}
              {photo.category && <span className="pill">{photo.category}</span>}
              {photo.tags && <span>{photo.tags}</span>}
              <span>{formatDateTimeText(photo.updated_at)}</span>
            </div>
          </div>
          <div className="photo-preview-tools">
            <button className="dialog-button" type="button" aria-label="缩小" onClick={() => setPreviewScale(scale - 0.25)}>-</button>
            <button className="dialog-button photo-zoom-label" type="button" onClick={() => setPreviewScale(1)}>{Math.round(scale * 100)}%</button>
            <button className="dialog-button" type="button" aria-label="放大" onClick={() => setPreviewScale(scale + 0.25)}>+</button>
          </div>
        </header>
        <div
          className="photo-preview-body"
          onWheel={(e) => {
            e.preventDefault();
            setPreviewScale(scale + (e.deltaY < 0 ? 0.18 : -0.18));
          }}
        >
          <img
            src={photo.url}
            alt={title}
            className={`${scale > 1 ? "is-zoomed" : ""} ${drag ? "is-panning" : ""}`}
            style={{
              "--preview-scale": scale,
              "--preview-pan-x": `${pan.x}px`,
              "--preview-pan-y": `${pan.y}px`,
            } as CSSProperties}
            draggable={false}
            onLoad={(e) => {
              setImageSize({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              });
              setLoading(false);
            }}
            onError={() => setLoading(false)}
            onDoubleClick={() => setPreviewScale(scale > 1 ? 1 : 2)}
            onPointerDown={(e) => {
              if (scale <= 1 || e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ startX: e.clientX, startY: e.clientY, originX: pan.x, originY: pan.y });
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              setPan({
                x: drag.originX + e.clientX - drag.startX,
                y: drag.originY + e.clientY - drag.startY,
              });
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId);
              setDrag(null);
            }}
            onPointerCancel={() => setDrag(null)}
          />
        </div>
        {photo.description && <p className="photo-preview-desc">{photo.description}</p>}
        <div className="dialog-actions">
          <a className="button-link primary" href={photo.url} download={photo.original_name || photo.filename}>下载</a>
          <button className="secondary" onClick={onClose}>关闭</button>
        </div>
      </section>
    </dialog>
  );
}

function PhotoEditDialog({
  photo,
  onClose,
  onSave,
  onDelete,
}: {
  photo: PhotoItem | null;
  onClose: () => void;
  onSave: (p: Partial<PhotoItem>, file?: File) => Promise<void> | void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (photo) {
      setTitle(photo.title);
      setCategory(photo.category);
      setTags(photo.tags);
      setDescription(photo.description);
      setFile(null);
      setSaving(false);
      setError("");
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [photo]);

  const savePhoto = async (nextFile?: File | null) => {
    if (saving) return;
    const uploadFile = nextFile === undefined ? file : nextFile;
    if (!photo?.id && !uploadFile) {
      setError("请选择一张图片");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({ title, category, tags, description }, uploadFile || undefined);
    } catch (err: any) {
      setError(err.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = (event: React.FormEvent) => {
    event.preventDefault();
    savePhoto();
  };

  const handleFileChange = (nextFile: File | null) => {
    setFile(nextFile);
    setError("");
  };

  const handleBackdropClick = () => {
    if (saving) return;
    if (!photo?.id && file) {
      savePhoto(file);
      return;
    }
    onClose();
  };

  if (!photo) return null;

  return (
    <dialog
      ref={dialogRef}
      className="photo-dialog"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && handleBackdropClick()}
    >
      <form className="dialog-body" onSubmit={handleSave}>
        {!photo.id && (
          <div className="field">
            <label>{saving ? "正在上传" : "照片文件"}</label>
            <input
              type="file"
              accept="image/*"
              required
              disabled={saving}
              onChange={(e) => {
                handleFileChange(e.target.files?.[0] || null);
              }}
            />
          </div>
        )}
        <div className="field">
          <label>标题</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label>分类</label>
          <input value={category} onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div className="field">
          <label>标签</label>
          <input value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
        <div className="field">
          <label>说明</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
        </div>
        {error && <div className="dialog-error">{error}</div>}
        <div className="dialog-actions">
          {photo.id > 0 && <button className="danger" type="button" onClick={onDelete} disabled={saving}>删除</button>}
          <button className="secondary" type="button" onClick={onClose} disabled={saving}>取消</button>
          <button className="primary" type="submit" disabled={saving}>{saving ? (photo.id > 0 ? "保存中..." : "上传中...") : (photo.id > 0 ? "保存" : "上传")}</button>
        </div>
      </form>
    </dialog>
  );
}
