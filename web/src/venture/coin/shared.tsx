import { useEffect, useState } from "react";
import { useWalletClient } from "wagmi";
import { toEventSelector } from "viem";

import { confirmTx, hookAbi, VENTURE, venturePc } from "../client";
import { storedRef } from "../referral";
import { short } from "../ui";
import { useWallet, errorText } from "../../lib/useWallet";
import { useUi } from "../../store";


/** One-tap referral binding: shown when a ?ref= link was followed and the
 *  connected wallet has not bound a referrer yet. */
export function ReferralBanner() {
  const { address: me, isConnected } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [bound, setBound] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = storedRef();

  useEffect(() => {
    if (!me) return;
    venturePc.readContract({ address: VENTURE.hook, abi: hookAbi, functionName: "referrerOf", args: [me] })
      .then((r) => setBound(String(r))).catch(() => undefined);
  }, [me, busy]);

  if (!isConnected || !ref || !me || ref.toLowerCase() === me.toLowerCase()) return null;
  if (!bound || bound !== "0x0000000000000000000000000000000000000000") return null;

  const activate = async () => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: VENTURE.hook, abi: hookAbi, functionName: "setReferrer", args: [ref], chain: wc.chain, account: wc.account });
      await confirmTx(hash);
      pushToast({ kind: "success", title: "Linked. Your fees are 10% lower now.", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Linking failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="dp-chit" style={{ margin: "0 14px 12px", borderColor: "var(--up-dim)" }}>
      You came from {short(ref)}'s link. Link up and you pay 10% less in fees; it takes one small transaction.{" "}
      <button style={{ background: "none", border: "none", color: "var(--up)", padding: 0, font: "inherit" }} disabled={busy} onClick={activate}>
        {busy ? "Confirm in wallet…" : "Link up"}
      </button>
    </div>
  );
}

/** Price impact beside a quote: quiet when small, plain words when large. */
export function Impact({ pct, curve }: { pct: number; curve?: boolean }) {
  if (pct < 1) return null;
  // On the curve a rising price is the design, and splitting a buy costs the
  // same, so it is stated as the average price rather than flagged.
  if (curve) {
    const above = (100 / (100 - Math.min(pct, 99)) - 1) * 100;
    return <span style={{ color: "var(--faint)" }}> · average price {above.toFixed(above < 10 ? 1 : 0)}% above the current price</span>;
  }
  const big = pct >= 10;
  return (
    <span style={{ color: big ? "var(--down)" : "var(--faint)" }}>
      {" "}· price impact {pct.toFixed(pct < 10 ? 1 : 0)}%{big ? ". Buying less gets a better average price." : ""}
    </span>
  );
}

/** VentureFactory.LAUNCH_WINDOW_SECS. */
export const LAUNCH_WINDOW_SECS = 60;

/** Measured on a mainnet fork: a plain curve buy uses ~119k gas, the filling
 *  buy that graduates ~788k. */
export const GRADUATING_BUY_GAS = 1_200_000n;

export const GRADUATED_TOPIC = toEventSelector("Graduated(address,bytes32,uint256,uint256,uint256)");
