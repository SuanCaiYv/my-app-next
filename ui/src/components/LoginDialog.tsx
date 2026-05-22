import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { login } from "../api";

export default function LoginDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { login: doLogin } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropPointerDownRef = useRef(false);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const closeDialog = () => {
    setPassword("");
    setError("");
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const data = await login(password);
      doLogin(data.token);
      closeDialog();
    } catch (err: unknown) {
      setPassword("");
      setError(err instanceof Error ? err.message : "登录失败");
      inputRef.current?.focus();
    }
  };

  if (!open) return null;

  return (
    <dialog
      open
      className="login-dialog"
      onPointerDown={(e) => {
        backdropPointerDownRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPointerDownRef.current && e.target === e.currentTarget) {
          closeDialog();
        }
        backdropPointerDownRef.current = false;
      }}
    >
      <form
        className="login-box"
        onSubmit={handleSubmit}
        onPointerDown={() => {
          backdropPointerDownRef.current = false;
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className={error ? "is-error" : ""}
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError("");
          }}
          placeholder={error || "输入密码"}
          aria-label="密码"
          autoComplete="off"
          autoFocus
        />
      </form>
    </dialog>
  );
}
