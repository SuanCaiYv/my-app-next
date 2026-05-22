import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type SelectOption = {
  value: string;
  label: string;
};

export default function Select({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState({ left: 0, top: 0, width: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) || options[0];
  const portalTarget = rootRef.current?.closest("dialog") || document.body;

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const updateMenuRect = () => {
      const rect = rootRef.current!.getBoundingClientRect();
      setMenuRect({
        left: rect.left,
        top: rect.bottom + 8,
        width: rect.width,
      });
    };
    updateMenuRect();
    window.addEventListener("resize", updateMenuRect);
    window.addEventListener("scroll", updateMenuRect, true);
    return () => {
      window.removeEventListener("resize", updateMenuRect);
      window.removeEventListener("scroll", updateMenuRect, true);
    };
  }, [open]);

  return (
    <div className="app-select" ref={rootRef}>
      <button
        type="button"
        className="app-select-button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{selected?.label || ""}</span>
        <span className="app-select-arrow" aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          className="app-select-menu"
          role="listbox"
          ref={menuRef}
          style={{ left: menuRect.left, top: menuRect.top, width: Math.max(menuRect.width, 168) }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`app-select-option ${option.value === value ? "selected" : ""}`}
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="app-select-check">{option.value === value ? "✓" : ""}</span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>,
        portalTarget
      )}
    </div>
  );
}
