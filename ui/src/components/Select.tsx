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
  const [menuRect, setMenuRect] = useState({ left: 12, top: 0, minWidth: 168 });
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
      const viewportPadding = 12;
      const availableWidth = Math.max(168, window.innerWidth - viewportPadding * 2);
      const naturalWidth = menuRef.current?.getBoundingClientRect().width || rect.width;
      const menuWidth = Math.min(Math.max(rect.width, naturalWidth, 168), availableWidth);
      const centeredLeft = rect.left + (rect.width - menuWidth) / 2;
      const left = Math.min(
        Math.max(viewportPadding, centeredLeft),
        window.innerWidth - menuWidth - viewportPadding,
      );
      const menuHeight = menuRef.current?.getBoundingClientRect().height || 0;
      const below = rect.bottom + 8;
      const above = rect.top - menuHeight - 8;
      const top = menuHeight > 0 && below + menuHeight > window.innerHeight - viewportPadding && above >= viewportPadding
        ? above
        : below;
      setMenuRect({
        left,
        top,
        minWidth: Math.max(rect.width, 168),
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
    <div className="app-select relative w-full min-w-0" ref={rootRef}>
      <button
        type="button"
        className="app-select-button plain flex w-full min-h-[48px] items-center justify-between gap-3 rounded-xl border border-[#D1D5DB] bg-white px-3 text-left text-[15px] text-[#1A1A1A] shadow-sm transition-colors hover:border-[#9CA3AF] focus:border-[#6B7280] focus:outline-none focus:ring-2 focus:ring-[#6B7280]/20 aria-expanded:border-[#6B7280]"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span className="min-w-0 truncate">{selected?.label || ""}</span>
        <svg
          className={`h-2.5 w-2.5 flex-shrink-0 text-[#6B7280] transition-transform duration-150 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && createPortal(
        <div
          className="app-select-menu fixed z-[2147483647] max-h-[min(280px,48vh)] w-max min-w-[168px] max-w-[calc(100vw-24px)] overflow-auto rounded-2xl border border-[#E5E7EB] bg-white p-2 shadow-lg"
          role="listbox"
          ref={menuRef}
          style={{ left: menuRect.left, top: menuRect.top, minWidth: menuRect.minWidth }}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`app-select-option plain grid w-full min-w-max grid-cols-[22px_1fr] items-center gap-1 rounded-lg px-2.5 py-2 text-left text-[14px] font-medium transition-colors hover:bg-[#F3F4F6] ${option.value === value ? "selected bg-[#E8F6F5] text-[#1f605e]" : "text-[#1A1A1A]"}`}
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => event.preventDefault()}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="text-[13px] font-black text-[#1f605e]">{option.value === value ? "✓" : ""}</span>
              <span className="whitespace-nowrap">{option.label}</span>
            </button>
          ))}
        </div>,
        portalTarget
      )}
    </div>
  );
}
