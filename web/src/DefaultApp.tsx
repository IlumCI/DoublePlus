import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { Skeleton, Toasts } from "./components/ui";
import { IS_STOCK_BOARD } from "./lib/brand";
import { Explore } from "./pages/Explore";

const TokenPage = lazy(() => import("./pages/Token").then((m) => ({ default: m.TokenPage })));
const LaunchPage = lazy(() => import("./pages/Launch").then((m) => ({ default: m.LaunchPage })));
const AdminPage =
  String(import.meta.env.VITE_PROTOCOL ?? "") === "stable-v3"
    ? lazy(() => import("./pages/AdminStable").then((m) => ({ default: m.AdminStable })))
    : lazy(() => import("./pages/Admin").then((m) => ({ default: m.AdminPage })));
const DocsPage = lazy(() => import("./pages/Docs").then((m) => ({ default: m.DocsPage })));
const ProfilePage = lazy(() => import("./pages/Profile").then((m) => ({ default: m.ProfilePage })));
const FlywheelPage = lazy(() => import("./pages/Flywheel").then((m) => ({ default: m.FlywheelPage })));
const BridgePage = lazy(() => import("./pages/Bridge").then((m) => ({ default: m.BridgePage })));
// koi.fun (Base flavor) discovery pages
const BasePartyPage = lazy(() => import("./pages/BaseParty").then((m) => ({ default: m.BaseParty })));
const BaseLeaderboardPage = lazy(() => import("./pages/BaseLeaderboard").then((m) => ({ default: m.BaseLeaderboard })));
const BaseSearchPage = lazy(() => import("./pages/BaseSearch").then((m) => ({ default: m.BaseSearch })));
const BaseFeedPage = lazy(() => import("./pages/BaseFeed").then((m) => ({ default: m.BaseFeed })));

function PageFallback() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <Skeleton className="h-14" />
      <Skeleton className="h-[400px] rounded-2xl" />
    </div>
  );
}

/** The board flavors (copair, base, arc, steadypads): shared header, footer and pages. */
export function DefaultApp() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col bg-bg">
        <Header />
        <main className="flex-1 pb-14 sm:pb-0">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Explore />} />
              <Route path="/launch" element={<LaunchPage />} />
              <Route path="/token/:address" element={<TokenPage />} />
              <Route path="/docs" element={<DocsPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/flywheel" element={<FlywheelPage />} />
              <Route path="/bridge" element={<BridgePage />} />
              {IS_STOCK_BOARD && (
                <>
                  <Route path="/party" element={<BasePartyPage />} />
                  <Route path="/pool-party" element={<Navigate to="/party" replace />} />
                  <Route path="/leaderboard" element={<BaseLeaderboardPage />} />
                  <Route path="/search" element={<BaseSearchPage />} />
                  <Route path="/feed" element={<BaseFeedPage />} />
                </>
              )}
              {/* Hidden operations console; access enforced on-chain by role. */}
              <Route path="/admin" element={<AdminPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
        <Toasts />
      </div>
    </BrowserRouter>  );
}
