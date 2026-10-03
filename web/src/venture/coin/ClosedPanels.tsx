import { useEffect, useState } from "react";
import { useWalletClient } from "wagmi";

import { confirmTx, ercAbi, factoryAbi, VENTURE, venturePc, type Venture as VentureT } from "../client";
import { fmtEth, fmtTok } from "../ui";
import { useWallet, errorText } from "../../lib/useWallet";
import { useUi } from "../../store";


export function GraduatePanel({ v }: { v: VentureT }) {
  const { isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const graduate = async () => {
    if (!isConnected) return connectFirst();
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "finalize", args: [v.address], chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: "Graduating…", txHash: hash });
      await confirmTx(hash);
      pushToast({ kind: "success", title: "Graduated. Trading is open.", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Graduation failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const founderCut = (v.raisedWei * BigInt(v.founderRaiseBps)) / 10_000n;
  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-phead"><span>Fully funded</span><span className="dp-badge dp-soon">target reached</span></div>
      <div className="dp-pbody">
        <p style={{ fontSize: 13, color: "var(--dim)", margin: "0 0 12px" }}>
          {fmtEth(v.raisedWei, 4)} ETH raised. Anyone can trigger graduation: the founder is paid their{" "}
          {(v.founderRaiseBps / 100).toFixed(1)}% cut ({fmtEth(founderCut, 4)} ETH), the rest becomes locked
          liquidity, and trading opens.
        </p>
        <button className="dp-tb-go dp-buy" disabled={busy} onClick={graduate}>
          {busy ? "Graduating…" : "Trigger graduation"}
        </button>
      </div>
    </div>
  );
}

export function FailPanel({ v }: { v: VentureT }) {
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0n);
  const [bought, setBought] = useState(0n);

  useEffect(() => {
    if (!me) return;
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "spentWei", args: [v.address, me] })
      .then((x) => setSpent(x as bigint)).catch(() => undefined);
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "boughtTokens", args: [v.address, me] })
      .then((x) => setBought(x as bigint)).catch(() => undefined);
  }, [me, v.address, busy]);

  const act = async (fn: "abort" | "refund") => {
    if (!isConnected) return connectFirst();
    if (!wc) return;
    setBusy(true);
    try {
      if (fn === "refund") {
        const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account!.address, VENTURE.factory] })) as bigint;
        if (allowance < bought) {
          const a = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.factory, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await confirmTx(a);
        }
      }
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn, args: [v.address], chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: fn === "abort" ? "Closing the round…" : "Refunding…", txHash: hash });
      await confirmTx(hash);
      pushToast({ kind: "success", title: fn === "abort" ? "Round closed. Refunds are open." : "Refunded. Your ETH is back in your wallet.", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: `${fn === "abort" ? "Close" : "Refund"} failed`, body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-phead"><span>Refund</span><span className="dp-badge dp-dead">raise failed</span></div>
      <div className="dp-pbody">
        <p style={{ fontSize: 13, color: "var(--dim)", margin: "0 0 12px" }}>
          It missed its target. Give back your ${v.symbol} and get back the ETH you paid, less the
          0.5% buy fee. The creator's locked tokens were burned.
        </p>
        {!v.aborted ? (
          <button className="dp-tb-go dp-buy" style={{ background: "var(--up-dim)" }} disabled={busy} onClick={() => act("abort")}>
            {busy ? "Confirm in wallet…" : "Open refunds"}
          </button>
        ) : spent > 0n ? (
          <button className="dp-tb-go dp-buy" disabled={busy} onClick={() => act("refund")}>
            {busy ? "Confirm in wallet…" : `Reclaim ${fmtEth(spent, 5)} ETH`}
          </button>
        ) : (
          <p className="dp-agate">Nothing to reclaim from this wallet.</p>
        )}
        {v.aborted && spent > 0n && <p className="dp-tb-note">Requires returning your full {fmtTok(bought)} ${v.symbol}.</p>}
      </div>
    </div>
  );
}
