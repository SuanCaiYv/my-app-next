import { useEffect, useRef, useState } from "react";

type TooltipState = {
  text: string;
  x: number;
  y: number;
  below: boolean;
};

const CONTROL_SELECTOR = "[data-tooltip], button, a[href], input:not([type='hidden']), textarea, select, [role='button']";

function tooltipText(element: HTMLElement) {
  const explicit = element.dataset.tooltip;
  if (explicit?.trim()) return explicit.trim();

  if (element instanceof HTMLInputElement) {
    if (element.type !== "checkbox" && element.type !== "radio") return "";
    const label = element.closest("label");
    return label?.dataset.tooltip?.trim()
      || element.getAttribute("aria-label")?.trim()
      || label?.getAttribute("title")?.trim()
      || "";
  }

  const text = element.textContent?.replace(/\s+/g, " ").trim();
  if (text && /[\p{L}\p{N}]/u.test(text)) return "";
  return element.getAttribute("aria-label")?.trim()
    || element.getAttribute("title")?.trim()
    || "";
}

export default function AutoTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };

    const restoreTitle = (element: HTMLElement | null) => {
      if (!element?.dataset.autoTooltipTitle) return;
      element.setAttribute("title", element.dataset.autoTooltipTitle);
      delete element.dataset.autoTooltipTitle;
    };

    const hide = () => {
      clearTimer();
      restoreTitle(activeRef.current);
      activeRef.current = null;
      setTooltip(null);
    };

    const show = (target: EventTarget | null, delay: number) => {
      const element = target instanceof Element ? target.closest<HTMLElement>(CONTROL_SELECTOR) : null;
      if (!element || element.closest("[data-tooltip-disabled='true']")) return;
      const text = tooltipText(element);
      if (!text) return;

      clearTimer();
      restoreTitle(activeRef.current === element ? null : activeRef.current);
      activeRef.current = element;
      const nativeTitle = element.getAttribute("title");
      if (nativeTitle) {
        element.dataset.autoTooltipTitle = nativeTitle;
        element.removeAttribute("title");
      }

      timerRef.current = window.setTimeout(() => {
        if (activeRef.current !== element || !element.isConnected) return;
        const rect = element.getBoundingClientRect();
        const viewportPadding = Math.min(150, window.innerWidth / 2);
        const center = rect.left + rect.width / 2;
        const x = Math.max(viewportPadding, Math.min(window.innerWidth - viewportPadding, center));
        const below = rect.top < 56;
        setTooltip({
          text: text.length > 100 ? `${text.slice(0, 97)}...` : text,
          x,
          y: below ? rect.bottom + 9 : rect.top - 9,
          below,
        });
      }, delay);
    };

    const onPointerOver = (event: PointerEvent) => show(event.target, 520);
    const onPointerOut = (event: PointerEvent) => {
      if (!activeRef.current) return;
      if (event.relatedTarget instanceof Node && activeRef.current.contains(event.relatedTarget)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => show(event.target, 180);
    const onFocusOut = (event: FocusEvent) => {
      if (!activeRef.current) return;
      if (event.relatedTarget instanceof Node && activeRef.current.contains(event.relatedTarget)) return;
      hide();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  if (!tooltip) return null;
  return (
    <div
      className={`auto-tooltip${tooltip.below ? " below" : ""}`}
      role="tooltip"
      style={{ left: tooltip.x, top: tooltip.y }}
    >
      {tooltip.text}
    </div>
  );
}
