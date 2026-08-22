import { useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useTokens } from "@launchpad/sdk/react";

import { client } from "../../lib/client";
import { BASE_USDC, BASE_WETH } from "../../lib/base/routes";
import { env } from "../../lib/env";
import { fmtUsd, shortAddr } from "../../lib/format";
import { useWallet } from "../../lib/useWallet";
import { useUi } from "../../store";
import { KoiIcon } from "./KoiIcon";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// The Base network brandmark badge shown on each holding avatar.
const BaseMark = () => (
  <svg viewBox="0 0 40 40" aria-hidden>
    <circle cx="20" cy="20" r="20" fill="#fff" />
    <path d="M24 2.45 A18 18 0 1 0 24 37.55 Z" fill="#0052FF" />
  </svg>
);

// The fundable assets on Base, shown as holdings with their USD value.
const ASSETS: { key: string; sym: string; name: string; address: Address; decimals: number }[] = [
  { key: "eth", sym: "ETH", name: "Ethereum", address: ZERO, decimals: 18 },
  { key: "usdc", sym: "USDC", name: "USD Coin", address: BASE_USDC, decimals: 6 },
  { key: "weth", sym: "WETH", name: "Wrapped Ether", address: BASE_WETH, decimals: 18 },
];

type Holding = { key: string; sym: string; name: string; amount: number; usd: number };

/**
 * Wallet slide-up, matching the reference external-wallet drawer: an address +
 * copy header with the total USD balance, a Copy / Explorer / Disconnect row, a
 * Holdings list (asset icon, symbol, name, USD value, amount), and a "Your
 * koi.fun tokens" section listing the coins this wallet launched.
 */
export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { address, isConnected, connectFirst, disconnect } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const { data: tokens } = useTokens(client, { sort: "volume", limit: 80 });

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; return () => { document.body.style.overflow = ""; }; }, [open]);

  // Asset balances + USD values for the header total and Holdings list.
  useEffect(() => {
    if (!open || !address) { setHoldings([]); setTotal(0); return; }
    let live = true;
    (async () => {
      const rows = await Promise.all(ASSETS.map(async (a) => {
        const [bal, price] = await Promise.all([
          (client as any).assetBalance(a.address, address as Address) as Promise<bigint>,
          (client as any).assetUsdPrice(a.address).catch(() => 0) as Promise<number>,
        ]);
        const amount = Number(formatUnits(bal, a.decimals));
        return { key: a.key, sym: a.sym, name: a.name, amount, usd: amount * (price || 0) };
      }));
      if (!live) return;
      const held = rows.filter((r) => r.amount > 0);
      setHoldings(held);
      setTotal(held.reduce((s, r) => s + r.usd, 0));
    })().catch(() => {});
    return () => { live = false; };
  }, [open, address]);

  const explorer = env.explorerUrl || "https://basescan.org";
  const copyAddr = () => { if (address) { navigator.clipboard?.writeText(address); pushToast({ kind: "info", title: "Address copied" }); } };

  const mine = (tokens ?? []).filter((t) => t.creator?.toLowerCase() === address?.toLowerCase());

  const fmtAmt = (n: number) => (n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : n.toPrecision(6).replace(/\.?0+$/, ""));

  if (!open) return null;

  return (
    <div className="kf-sheet-backdrop" onClick={onClose}>
      <div className="kf-sheet kf-wallet" role="dialog" aria-label="Wallet" onClick={(e) => e.stopPropagation()}>
        <div className="kf-sheet-grip" />
        <div className="kf-wallet-head">
          <div className="kf-wallet-id">
            <h2 className="kf-wallet-title">Wallet</h2>
            {address ? (
              <button className="kf-wallet-addr" onClick={copyAddr}>
                {shortAddr(address)} <KoiIcon name="wallet" size={13} />
              </button>
            ) : null}
          </div>
          <div className="kf-wallet-headright">
            {isConnected ? <span className="kf-wallet-total">{fmtUsd(total)}</span> : null}
            <button className="kf-wallet-x" aria-label="Close" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </div>

        {!isConnected ? (
          <div className="kf-wallet-empty">
            <p>Sign in or connect a wallet to see your holdings.</p>
            <button className="kf-submit" onClick={connectFirst}>Connect wallet</button>
          </div>
        ) : (
          <>
            <div className="kf-wallet-actions">
              <button onClick={copyAddr}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                Copy
              </button>
              <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></svg>
                Explorer
              </a>
              <button onClick={() => { disconnect(); onClose(); }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                Disconnect
              </button>
            </div>

            <div className="kf-wallet-holdings">
              <div className="kf-wallet-hh">Holdings</div>
              {holdings.length === 0 ? (
                <p className="hint">No balances on Base yet.</p>
              ) : (
                holdings.map((h) => (
                  <div key={h.key} className="kf-wallet-hrow">
                    <span className="kf-wallet-hav">{h.sym.slice(0, 1)}<BaseMark /></span>
                    <span className="kf-wallet-hmid">
                      <span className="kf-wallet-hsym">{h.sym}</span>
                      <span className="kf-wallet-hname">{h.name}</span>
                    </span>
                    <span className="kf-wallet-hright">
                      <span className="kf-wallet-husd">{fmtUsd(h.usd)}</span>
                      <span className="kf-wallet-hamt">{fmtAmt(h.amount)}</span>
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="kf-wallet-tokens">
              <div className="kf-wallet-th"><span>Your {`basedstonk`} tokens</span><span>{mine.length}</span></div>
              {mine.length === 0 ? (
                <p className="hint">This wallet hasn't deployed or received fees from any basedstonk tokens yet.</p>
              ) : (
                mine.map((t) => (
                  <a key={t.address} className="kf-wallet-hrow" href={`/token/${t.address}`}>
                    <span className="kf-wallet-hav">{t.symbol.slice(0, 1)}<BaseMark /></span>
                    <span className="kf-wallet-hmid">
                      <span className="kf-wallet-hsym">{t.symbol}</span>
                      <span className="kf-wallet-hname">{t.name}</span>
                    </span>
                    <span className="kf-wallet-hright">
                      <span className="kf-wallet-husd">{Number(t.marketCapUsd) > 0 ? fmtUsd(t.marketCapUsd) : "—"}</span>
                    </span>
                  </a>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
