import { useCallback, useEffect, useRef, useState } from "react";

interface ConfirmState {
  message: string;
  resolve: (value: boolean) => void;
}

export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const confirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({ message, resolve });
    });
  }, []);

  const onConfirm = useCallback(() => {
    state?.resolve(true);
    setState(null);
  }, [state]);

  const onCancel = useCallback(() => {
    state?.resolve(false);
    setState(null);
  }, [state]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!state || !dialog) return;
    if (!dialog.open) {
      dialog.showModal();
    }
  }, [state]);

  const element = state ? (
    <dialog
      ref={dialogRef}
      className="confirm-dialog-overlay"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={onCancel}
    >
      <form
        className="dialog-body confirm-dialog"
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p>{state.message}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="danger">
            确定
          </button>
        </div>
      </form>
    </dialog>
  ) : null;

  return { confirm, element };
}
