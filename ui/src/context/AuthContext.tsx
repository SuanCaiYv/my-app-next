import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getToken, setToken, clearToken, me } from "../api";

interface AuthContextType {
  role: "guest" | "owner";
  setRole: (role: "guest" | "owner") => void;
  ownerClickCount: number;
  incrementOwnerClick: () => void;
  token: string;
  login: (token: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<"guest" | "owner">("guest");
  const [ownerClickCount, setOwnerClickCount] = useState(0);
  const [token, setTokenState] = useState(getToken());

  useEffect(() => {
    me().then((data) => {
      setRole(data.role as "guest" | "owner");
    }).catch(() => {
      setRole("guest");
    });
  }, []);

  const login = (newToken: string) => {
    setToken(newToken);
    setTokenState(newToken);
    setRole("owner");
  };

  const logout = () => {
    clearToken();
    setTokenState("");
    setRole("guest");
    setOwnerClickCount(0);
    window.location.reload();
  };

  const incrementOwnerClick = () => {
    setOwnerClickCount((c) => c + 1);
  };

  return (
    <AuthContext.Provider
      value={{ role, setRole, ownerClickCount, incrementOwnerClick, token, login, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
