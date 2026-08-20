import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CHAINS, type Chain } from "./data";

export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  body?: string;
  leaving?: boolean;
}

export interface Wallet {
  address: string;
  label: string;
}

interface AppState {
  wallet: Wallet | null;
  connecting: string | null;
  chain: Chain;
  favorites: string[];
  toasts: Toast[];
  connect: (walletId: string, label: string) => Promise<void>;
  disconnect: () => void;
  setChain: (id: string) => void;
  toggleFavorite: (ticker: string) => void;
  toast: (t: Omit<Toast, "id">) => void;
}

const Ctx = createContext<AppState | null>(null);

const DEMO_ADDRESS = "0xA4c8E19f37D25b60C41e8F93B7a5D20C64E1F98b";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`meridian:${key}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(`meridian:${key}`);
    else localStorage.setItem(`meridian:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable — session-only state */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<Wallet | null>(() => load<Wallet | null>("wallet", null));
  const [connecting, setConnecting] = useState<string | null>(null);
  const [chain, setChainState] = useState<Chain>(() => {
    const saved = load<{ id: string } | null>("chain", null);
    return CHAINS.find((c) => c.id === saved?.id) ?? CHAINS[0];
  });
  const [favorites, setFavorites] = useState<string[]>(() => load<string[]>("favorites", []));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 260);
    }, 4200);
  }, []);

  const connect = useCallback(
    async (walletId: string, label: string) => {
      setConnecting(walletId);
      await new Promise((r) => setTimeout(r, 900));
      const next = { address: DEMO_ADDRESS, label };
      setWallet(next);
      save("wallet", next);
      setConnecting(null);
      toast({
        kind: "success",
        title: "Wallet connected",
        body: `${label} · ${DEMO_ADDRESS.slice(0, 6)}…${DEMO_ADDRESS.slice(-4)}`,
      });
    },
    [toast]
  );

  const disconnect = useCallback(() => {
    setWallet(null);
    save("wallet", null);
    toast({ kind: "info", title: "Wallet disconnected" });
  }, [toast]);

  const setChain = useCallback(
    (id: string) => {
      const next = CHAINS.find((c) => c.id === id);
      if (!next) return;
      setChainState(next);
      save("chain", { id: next.id });
      toast({ kind: "info", title: `Network set to ${next.name}` });
    },
    [toast]
  );

  const toggleFavorite = useCallback((ticker: string) => {
    setFavorites((prev) => {
      const next = prev.includes(ticker) ? prev.filter((t) => t !== ticker) : [...prev, ticker];
      save("favorites", next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      wallet,
      connecting,
      chain,
      favorites,
      toasts,
      connect,
      disconnect,
      setChain,
      toggleFavorite,
      toast,
    }),
    [wallet, connecting, chain, favorites, toasts, connect, disconnect, setChain, toggleFavorite, toast]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
