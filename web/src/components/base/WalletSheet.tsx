import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useTokens } from "@launchpad/sdk/react";

import { client } from "../../lib/client";
import { BASE_USDC, BASE_WETH } from "../../lib/base/routes";
import { env } from "../../lib/env";
import { shortAddr } from "../../lib/format";
import { ensureSdkWallet, errorText, useWallet } from "../../lib/useWallet";
import { useUi } from "../../store";
import { KoiIcon } from "./KoiIcon";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// The three fundable assets on Base, mirroring the reference "Send ETH, WETH
// or USDG" — here ETH / USDC / WETH.
const ASSETS: { key: string; label: string; address: Address; decimals: number }[] = [
  { key: "eth", label: "ETH", address: ZERO, decimals: 18 },
  { key: "usdc", label: "USDC", address: BASE_USDC, decimals: 6 },
  { key: "weth", label: "WETH", address: BASE_WETH, decimals: 18 },
];

const balAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Wallet slide-up, mirroring the reference drawer: an address + balance header,
 * a Deposit / Send switch, a Holdings list, and an explorer link + disconnect.
 * Send moves ETH / USDC / WETH on Base; Deposit shows the receive address.
 */
export function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { address, isConnected, connectFirst, disconnect } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const { data: tokens } = useTokens(client, { sort: "volume", limit: 60 });

  const [view, setView] = useState<"send" | "deposit">("send");
  const [asset, setAsset] = useState(ASSETS[0]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [bals, setBals] = useState<Record<string, bigint>>({});
  const [holdings, setHoldings] = useState<{ addr: string; sym: string; name: string; bal: bigint }[]>([]);

  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; return () => { document.body.style.overflow = ""; }; }, [open]);

  // Balances of the three fundable assets, for the header and Max.
  useEffect(() => {
    if (!open || !address) return;
    let live = true;
    (async () => {
      const entries = await Promise.all(
        ASSETS.map(async (a) => [a.key, await (client as any).assetBalance(a.address, address as Address)] as const),
      );
      if (live) setBals(Object.fromEntries(entries));
    })().catch(() => {});
    return () => { live = false; };
  }, [open, address]);

  // Coin holdings: the coins this wallet holds a non-zero balance of.
  useEffect(() => {
    if (!open || !address || !tokens?.length) return;
    let live = true;
    (async () => {
      const res = await client.publicClient.multicall({
        allowFailure: true,
        contracts: tokens.map((t) => ({ address: t.address as Address, abi: balAbi, functionName: "balanceOf", args: [address as Address] })),
      });
      const held: { addr: string; sym: string; name: string; bal: bigint }[] = [];
      res.forEach((r, i) => {
        const bal = r.status === "success" ? (r.result as bigint) : 0n;
        if (bal > 0n) held.push({ addr: tokens[i].address, sym: tokens[i].symbol, name: tokens[i].name, bal });
      });
      if (live) setHoldings(held);
    })().catch(() => {});
    return () => { live = false; };
  }, [open, address, tokens]);

  const assetBal = bals[asset.key] ?? 0n;
  const fmtBal = (v: bigint, d: number) => {
    const n = Number(formatUnits(v, d));
    return n >= 1 ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : n.toPrecision(3).replace(/\.?0+$/, "");
  };

  const explorer = env.explorerUrl || "https://basescan.org";
  const copy = (v: string) => { navigator.clipboard?.writeText(v); pushToast({ kind: "info", title: "Copied", body: shortAddr(v) }); };

  const send = async () => {
    if (busy) return;
    if (!isConnected) return connectFirst();
    if (!/^0x[a-fA-F0-9]{40}$/.test(to.trim())) return pushToast({ kind: "error", title: "Enter a valid address" });
    let value: bigint;
    try { value = parseUnits(amount.trim() || "0", asset.decimals); } catch { return pushToast({ kind: "error", title: "Enter a valid amount" }); }
    if (value <= 0n) return pushToast({ kind: "error", title: "Enter an amount" });
    if (value > assetBal) return pushToast({ kind: "error", title: "Amount exceeds balance" });
    setBusy(true);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const hash = await (client as any).transferAsset(asset.address, to.trim() as Address, value);
      pushToast({ kind: "success", title: `Sent ${amount} ${asset.label}`, txHash: hash });
      setAmount(""); setTo("");
    } catch (err) {
      pushToast({ kind: "error", title: "Send failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const total = useMemo(() => holdings.length, [holdings]);

  if (!open) return null;

  return (
    <div className="kf-sheet-backdrop" onClick={onClose}>
      <div className="kf-sheet kf-wallet" role="dialog" aria-label="Wallet" onClick={(e) => e.stopPropagation()}>
        <div className="kf-sheet-grip" />
        <div className="kf-wallet-head">
          <div>
            <h2 className="kf-wallet-title">Wallet</h2>
            {address ? (
              <button className="kf-wallet-addr" onClick={() => copy(address)}>
                {shortAddr(address)} <KoiIcon name="wallet" size={13} />
              </button>
            ) : null}
          </div>
          <div className="kf-wallet-bal">
            <span className="k">Balance</span>
            <span className="v">{fmtBal(bals.eth ?? 0n, 18)} ETH</span>
          </div>
        </div>

        {!isConnected ? (
          <div className="kf-wallet-empty">
            <p>Connect a wallet to see your balance and holdings.</p>
            <button className="kf-submit" onClick={connectFirst}>Connect wallet</button>
          </div>
        ) : (
          <>
            <div className="kf-seg2 kf-wallet-seg">
              <button className={view === "deposit" ? "on" : ""} onClick={() => setView("deposit")}>Deposit</button>
              <button className={view === "send" ? "on" : ""} onClick={() => setView("send")}>Send</button>
            </div>

            {view === "deposit" ? (
              <div className="kf-field">
                <label>Deposit to your wallet</label>
                <p className="hint" style={{ marginTop: 0 }}>Send ETH, USDC or WETH on Base to this address.</p>
                <button className="kf-wallet-recv" onClick={() => address && copy(address)}>
                  <span>{address}</span>
                  <KoiIcon name="wallet" size={16} />
                </button>
              </div>
            ) : (
              <div className="kf-field kf-wallet-send">
                <label>Send on Base</label>
                <div className="kf-seg2 kf-wallet-assets">
                  {ASSETS.map((a) => (
                    <button key={a.key} className={asset.key === a.key ? "on" : ""} onClick={() => setAsset(a)}>{a.label}</button>
                  ))}
                </div>
                <input type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} />
                <div className="kf-wallet-amtrow">
                  <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" />
                  <button className="kf-wallet-max" onClick={() => setAmount(formatUnits(assetBal, asset.decimals))}>Max</button>
                </div>
                <p className="hint">Balance {fmtBal(assetBal, asset.decimals)} {asset.label}</p>
                <button className="kf-submit" disabled={busy} onClick={send}>{busy ? "Confirm in wallet…" : `Send ${asset.label}`}</button>
              </div>
            )}

            <div className="kf-wallet-holdings">
              <div className="kf-wallet-hh">Holdings{total ? ` · ${total}` : ""}</div>
              {holdings.length === 0 ? (
                <p className="hint">No coin holdings yet.</p>
              ) : (
                holdings.map((h) => (
                  <a key={h.addr} className="kf-wallet-hrow" href={`/token/${h.addr}`}>
                    <span className="kf-wallet-hsym">{h.sym}</span>
                    <span className="kf-wallet-hname">{h.name}</span>
                    <span className="kf-wallet-hbal">{fmtBal(h.bal, 18)}</span>
                  </a>
                ))
              )}
            </div>

            <div className="kf-wallet-foot">
              <a href={`${explorer}/address/${address}`} target="_blank" rel="noreferrer">Explorer</a>
              <button onClick={() => { disconnect(); onClose(); }}>Disconnect</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
