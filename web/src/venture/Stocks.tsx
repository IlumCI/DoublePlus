import { useEffect, useMemo, useState } from "react";
import { createPublicClient, defineChain, http, type Address } from "viem";

import { env } from "../lib/env";
import { venturePc } from "./client";
import { usePageMeta } from "./seo";
import { ago, fmtUsdV } from "./ui";
import { marketState, poolPriceUsd, premium, type MarketState } from "./stockPremium";
import STOCKS from "./stocks.json";

// Stock tokens live on mainnet only, so this page reads mainnet whichever
// network the rest of the site is pointed at.
const MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
const mainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [MAINNET_RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const pc = env.chainId === 4663 ? venturePc : createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC), batch: { multicall: { wait: 16 } } });

const ETH_USD_FEED: Address = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
const USDG_USD_FEED: Address = "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2";
const feedAbi = [{ type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
  { type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" },
] }] as const;
const poolAbi = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" },
  ] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

interface Stock { symbol: string; name: string; token: Address; feed: Address; pool: Address; quote: "USDG" | "WETH"; fee: number; depthUsd: number }
interface Row extends Stock { poolUsd: number; navUsd: number; prem: number; feedAt: number }

const STATE_LABEL: Record<MarketState, string> = { regular: "US market open", extended: "24/5 session", closed: "weekend: market shut" };

/** Tokenized stocks: on-chain pool price against the Chainlink price, sorted
 *  by how far apart they are. */
export function Stocks() {
  usePageMeta("Stock premiums");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [state, setState] = useState<MarketState>(() => marketState(new Date()));

  useEffect(() => {
    let live = true;
    const stocks = STOCKS as Stock[];
    const token0 = new Map<string, Address>();
    const load = async () => {
      if (token0.size === 0) {
        const t0 = await Promise.all(stocks.map((s) => pc.readContract({ address: s.pool, abi: poolAbi, functionName: "token0" })));
        stocks.forEach((s, i) => token0.set(s.pool, t0[i]));
      }
      const [eth, usdg] = await Promise.all([ETH_USD_FEED, USDG_USD_FEED].map((f) => pc.readContract({ address: f, abi: feedAbi, functionName: "latestRoundData" })));
      const quoteUsd = { WETH: Number(eth[1]) / 1e8, USDG: Number(usdg[1]) / 1e8 };
      const out = await Promise.all(stocks.map(async (s) => {
        const [slot0, round] = await Promise.all([
          pc.readContract({ address: s.pool, abi: poolAbi, functionName: "slot0" }),
          pc.readContract({ address: s.feed, abi: feedAbi, functionName: "latestRoundData" }),
        ]);
        const stockIs0 = token0.get(s.pool)!.toLowerCase() === s.token.toLowerCase();
        const poolUsd = poolPriceUsd(slot0[0], stockIs0, 18, s.quote === "USDG" ? 6 : 18, quoteUsd[s.quote]);
        const navUsd = Number(round[1]) / 1e8;
        return { ...s, poolUsd, navUsd, prem: premium(poolUsd, navUsd), feedAt: Number(round[3]) };
      }));
      if (!live) return;
      out.sort((a, b) => Math.abs(b.prem) - Math.abs(a.prem));
      setRows(out);
      setFailed(false);
      setState(marketState(new Date()));
    };
    load().catch(() => live && setFailed(true));
    const id = setInterval(() => load().catch(() => live && setFailed(true)), 30_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const widest = useMemo(() => rows?.[0], [rows]);
  return (
    <div className="dp-shell dp-board">
      <div className="lh-cmdbar">
        <span className="lh-cmdlabel dp-mstate">{STATE_LABEL[state]}</span>
        {widest && <span className="lh-cmdlabel dp-mstate">· widest {widest.symbol} {fmtPrem(widest.prem)}</span>}
      </div>
      {failed && rows === null ? (
        <div className="dp-notice dp-bad"><h3>Can't reach Robinhood Chain.</h3></div>
      ) : rows === null ? (
        <div className="lh-loading" role="status"><i /><span>Loading…</span></div>
      ) : (
        <div className="lh-list dp-stocks" role="table" aria-label="Stock premiums">
          <div className="lh-dhead" role="row">
            <span role="columnheader">Stock</span>
            <span role="columnheader" className="n">Pool</span>
            <span role="columnheader" className="n">Chainlink</span>
            <span role="columnheader" className="n">Premium</span>
            <span role="columnheader" className="n">Feed</span>
            <span role="columnheader" className="n">Depth</span>
          </div>
          {rows.map((r) => (
            <div key={r.symbol} role="row" className="lh-drow">
              <span role="cell" className="lh-dname"><span><b>{r.symbol}</b><small>{r.name} · {r.quote} {r.fee / 10_000}%</small></span></span>
              <span role="cell" className="n">${r.poolUsd.toFixed(2)}</span>
              <span role="cell" className="n">${r.navUsd.toFixed(2)}</span>
              <span role="cell" className="n" style={{ color: Math.abs(r.prem) < 0.01 ? undefined : r.prem > 0 ? "var(--up)" : "var(--down)" }}>{fmtPrem(r.prem)}</span>
              <span role="cell" className="n">{ago(r.feedAt)} ago</span>
              <span role="cell" className="n">{fmtUsdV(r.depthUsd)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtPrem(p: number): string {
  return `${p >= 0 ? "+" : ""}${(100 * p).toFixed(2)}%`;
}
