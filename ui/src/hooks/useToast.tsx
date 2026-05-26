import { useState, useRef, useCallback, useEffect } from "react";

export function useToast() {
  const [msg, setMsg] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef(0);

  const show = useCallback((text: string) => {
    clearTimeout(timerRef.current);
    ref.current?.hidePopover?.();
    setMsg(text);
  }, []);

  useEffect(() => {
    if (!msg) return;
    ref.current?.showPopover?.();
    timerRef.current = window.setTimeout(() => {
      ref.current?.hidePopover?.();
      setMsg("");
    }, 2200);
    return () => clearTimeout(timerRef.current);
  }, [msg]);

  const element = msg ? (
    <div ref={ref} popover="manual" className="toast show">{msg}</div>
  ) : null;

  return { show, element };
}
