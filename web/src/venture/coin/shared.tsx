import { toEventSelector, zeroAddress, type WalletClient } from "viem";

import { confirmTx, hookAbi, VENTURE, venturePc, sendTx } from "../client";
import { storedRef } from "../referral";
import { short } from "../ui";
import type { Toast } from "../../store";


const DECLINED = "venture.ref.declined";

/** Bind the referrer from a followed ?ref= link, inside the wallet's first
 *  trade. The hook only takes the binding from the wallet itself, so it is one
 *  extra confirmation before that trade, never a separate step to find. Does
 *  nothing once bound, without a stored link, or after a decline this session;
 *  never throws, so the trade goes ahead either way. */
export async function bindReferral(wc: WalletClient, pushToast: (t: Omit<Toast, "id">) => void): Promise<void> {
  const ref = storedRef();
  const me = wc.account?.address;
  if (!ref || !me || ref.toLowerCase() === me.toLowerCase()) return;
  try { if (sessionStorage.getItem(DECLINED)) return; } catch { /* storage unavailable */ }
  try {
    const bound = await venturePc.readContract({ address: VENTURE.hook, abi: hookAbi, functionName: "referrerOf", args: [me] });
    if (bound !== zeroAddress) return;
    pushToast({ kind: "info", title: `Linking ${short(ref)}'s referral: 10% off your fees` });
    await confirmTx(await sendTx(wc, { address: VENTURE.hook, abi: hookAbi, functionName: "setReferrer", args: [ref], chain: wc.chain, account: wc.account }));
  } catch {
    try { sessionStorage.setItem(DECLINED, "1"); } catch { /* storage unavailable */ }
  }
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

export { LAUNCH_WINDOW_SECS } from "../protocol";

/** Measured on a mainnet fork: a plain curve buy uses ~119k gas, the filling
 *  buy that graduates ~788k. */
export const GRADUATING_BUY_GAS = 1_200_000n;

export const GRADUATED_TOPIC = toEventSelector("Graduated(address,bytes32,uint256,uint256,uint256)");
