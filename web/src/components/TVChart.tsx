import { useEffect, useRef } from "react";
import type { Address } from "@launchpad/sdk";

import { makeDatafeed } from "../lib/tvDatafeed";

// Load the TradingView Advanced Charts standalone bundle once.
let tvScript: Promise<void> | null = null;
function loadTradingView(): Promise<void> {
  if ((window as any).TradingView?.widget) return Promise.resolve();
  if (tvScript) return tvScript;
  tvScript = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/charting_library/charting_library.standalone.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load TradingView library"));
    document.head.appendChild(s);
  });
  return tvScript;
}

/** Real TradingView Advanced Charts, fed by our on-chain candles. */
export function TVChart({ token, symbol }: { token: Address; symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const idRef = useRef(`tv_${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    let widget: any;
    let dead = false;
    loadTradingView()
      .then(() => {
        if (dead || !ref.current) return;
        const TV = (window as any).TradingView;
        widget = new TV.widget({
          container: idRef.current,
          datafeed: makeDatafeed(token, symbol),
          symbol,
          interval: "5",
          library_path: "/charting_library/",
          locale: "en",
          timezone: "Etc/UTC",
          autosize: true,
          theme: "dark",
          disabled_features: [
            "use_localstorage_for_settings",
            "header_symbol_search",
            "symbol_search_hot_key",
            "header_compare",
            "header_saveload",
            "display_market_status",
            "popup_hints",
          ],
          enabled_features: ["hide_left_toolbar_by_default", "iframe_loading_compatibility_mode"],
          loading_screen: { backgroundColor: "#14161a", foregroundColor: "#ee463a" },
          overrides: {
            "paneProperties.background": "#14161a",
            "paneProperties.backgroundType": "solid",
            "paneProperties.vertGridProperties.color": "#1f232a",
            "paneProperties.horzGridProperties.color": "#1f232a",
            "scalesProperties.textColor": "#9298a2",
            "scalesProperties.backgroundColor": "#14161a",
            "mainSeriesProperties.candleStyle.upColor": "#21c45d",
            "mainSeriesProperties.candleStyle.downColor": "#ef584d",
            "mainSeriesProperties.candleStyle.borderUpColor": "#21c45d",
            "mainSeriesProperties.candleStyle.borderDownColor": "#ef584d",
            "mainSeriesProperties.candleStyle.wickUpColor": "#21c45d",
            "mainSeriesProperties.candleStyle.wickDownColor": "#ef584d",
          },
          studies_overrides: {
            "volume.volume.color.0": "#ef584d",
            "volume.volume.color.1": "#21c45d",
            "volume.volume.transparency": 70,
          },
        });
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      try {
        widget?.remove();
      } catch {
        /* ignore */
      }
    };
  }, [token, symbol]);

  return <div id={idRef.current} ref={ref} className="h-full w-full" />;
}
