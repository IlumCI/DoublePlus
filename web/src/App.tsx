import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "./lib/wagmi";

// Each self-contained flavor is its own chunk: a doubleplus visitor should not
// download hammr's auction app, and the reverse.
// The flavor is fixed at build time (import.meta.env is substituted), so the
// bundler drops the apps a build can never show: a doubleplus build carries
// no hammr or board code at all, not even as unused chunks.
const HammrApp = import.meta.env.VITE_BRAND === "hammr" ? lazy(() => import("./hammr/HammrApp").then((m) => ({ default: m.HammrApp }))) : null;
const VentureApp = import.meta.env.VITE_BRAND === "venture" ? lazy(() => import("./venture/VentureApp").then((m) => ({ default: m.VentureApp }))) : null;
const DefaultApp = import.meta.env.VITE_BRAND !== "hammr" && import.meta.env.VITE_BRAND !== "venture" ? lazy(() => import("./DefaultApp").then((m) => ({ default: m.DefaultApp }))) : null;

const queryClient = new QueryClient({
  defaultOptions: {
    // Serve cached reads longer and keep them in memory across navigation so
    // moving between pages doesn't re-hit the RPC for data we already have.
    queries: { staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false, retry: 2 },
  },
});

export default function App() {
  // The hammr flavor is a self-contained auction app with its own chrome.
  if (HammrApp) {
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={null}><HammrApp /></Suspense>
        </QueryClientProvider>
      </WagmiProvider>
    );
  }
  // The venture flavor is the self-contained startup-funding launchpad.
  if (VentureApp) {
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={null}><VentureApp /></Suspense>
        </QueryClientProvider>
      </WagmiProvider>
    );
  }
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>{DefaultApp && <DefaultApp />}</Suspense>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
