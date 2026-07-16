import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { Header } from "./components/Header";
import { NavBar } from "./components/NavBar";
import { Ticker } from "./components/Ticker";
import { Skeleton, Toasts } from "./components/ui";
import { BRAND } from "./lib/brand";
import { wagmiConfig } from "./lib/wagmi";
import { Explore } from "./pages/Explore";

const TokenPage = lazy(() => import("./pages/Token").then((m) => ({ default: m.TokenPage })));
const LaunchPage = lazy(() => import("./pages/Launch").then((m) => ({ default: m.LaunchPage })));
const MyCoinsPage = lazy(() => import("./pages/MyCoins").then((m) => ({ default: m.MyCoinsPage })));
const AdminPage = lazy(() => import("./pages/Admin").then((m) => ({ default: m.AdminPage })));
const DocsPage = lazy(() => import("./pages/Docs").then((m) => ({ default: m.DocsPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false },
  },
});

function PageFallback() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <Skeleton className="h-14" />
      <Skeleton className="h-[400px] rounded-2xl" />
    </div>
  );
}

export default function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <div className="flex min-h-screen flex-col bg-bg">
            <Header />
            <Ticker />
            <NavBar />
            <main className="flex-1">
              <Suspense fallback={<PageFallback />}>
                <Routes>
                  <Route path="/" element={<Explore />} />
                  <Route path="/launch" element={<LaunchPage />} />
                  <Route path="/mine" element={<MyCoinsPage />} />
                  <Route path="/token/:address" element={<TokenPage />} />
                  <Route path="/docs" element={<DocsPage />} />
                  {/* Hidden operations console; access enforced on-chain by role. */}
                  <Route path="/admin" element={<AdminPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Suspense>
            </main>
            <footer className="border-t border-edge/70 py-8">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 sm:px-6">
                <p className="text-[14px] text-ink-3">
                  <span className="font-semibold text-ink-2">{BRAND.name}</span> · {BRAND.tagline}
                </p>
                <nav className="flex items-center gap-6 text-[14px]">
                  <Link to="/docs" className="font-medium text-ink-2 transition-colors hover:text-ink">
                    Docs
                  </Link>
                  <a
                    href="https://robinhoodchain.blockscout.com"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-ink-2 transition-colors hover:text-ink"
                  >
                    Explorer
                  </a>
                  <a
                    href={BRAND.twitter}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${BRAND.name} on X`}
                    className="text-ink-2 transition-colors hover:text-ink"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
                    </svg>
                  </a>
                </nav>
              </div>
            </footer>
            <Toasts />
          </div>
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
