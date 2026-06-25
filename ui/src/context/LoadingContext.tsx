import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface LoadingContextValue {
  loading: boolean;
  message: string;
  setLoading: (loading: boolean, message?: string) => void;
}

const LoadingContext = createContext<LoadingContextValue | null>(null);

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [loading, setLoadingState] = useState(false);
  const [message, setMessage] = useState("");

  const setLoading = useCallback((next: boolean, nextMessage = "") => {
    setLoadingState(next);
    setMessage(nextMessage);
  }, []);

  return (
    <LoadingContext.Provider value={{ loading, message, setLoading }}>
      {children}
    </LoadingContext.Provider>
  );
}

export function useLoading() {
  const ctx = useContext(LoadingContext);
  if (!ctx) throw new Error("useLoading must be used within LoadingProvider");
  return ctx;
}
