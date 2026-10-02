import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { BRAND_FLAVOR } from "./lib/brand";
import { wagmiConfig } from "./lib/wagmi";

// Each self-contained flavor is its own chunk: a doubleplus visitor should not
// download hammr's auction app, and the reverse.
const HammrApp = lazy(() => import("./hammr/HammrApp").then((m) => ({ default: m.HammrApp })));
const VentureApp = lazy(() => import("./venture/VentureApp").then((m) => ({ default: m.VentureApp })));
const DefaultApp = lazy(() => import("./DefaultApp").then((m) => ({ default: m.DefaultApp })));

const queryClient = new QueryClient({
  defaultOptions: {
    // Serve cached reads longer and keep them in memory across navigation so
    // moving between pages doesn't re-hit the RPC for data we already have.
    queries: { staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false, retry: 2 },
  },
});

export default function App() {
  // The hammr flavor is a self-contained auction app with its own chrome.
  if (BRAND_FLAVOR === "hammr") {
    return (
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <Suspense fallback={null}><HammrApp /></Suspense>
        </QueryClientProvider>
      </WagmiProvider>
    );
  }
  // The venture flavor is the self-contained startup-funding launchpad.
  if (BRAND_FLAVOR === "venture") {
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
        <Suspense fallback={null}><DefaultApp /></Suspense>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
