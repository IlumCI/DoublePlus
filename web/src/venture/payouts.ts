import { encodePacked, type Hex } from "viem";

import { env } from "../lib/env";
import { VENTURE } from "./client";

/** What a 5x holder can be paid in. kind mirrors VenturePayouts.Kind:
 *  0 ETH, 1 the coin itself, 2 a Uniswap V3 route out of WETH. Routes were
 *  checked against the mainnet quoter (2026-10-08); the testnet has no V3. */
export interface PayoutChoice { key: string; label: string; kind: 0 | 1 | 2; path: Hex }

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const hop = (fee: number, token: string): [number, string] => [fee, token];
const STOCKS: [string, [number, string][]][] = [
  ["NVDA", [hop(500, "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC")]],
  ["TSLA", [hop(100, USDG), hop(500, "0x322F0929c4625eD5bAd873c95208D54E1c003b2d")]],
  ["AAPL", [hop(500, "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9")]],
  ["GOOGL", [hop(100, USDG), hop(500, "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3")]],
  ["AMZN", [hop(100, USDG), hop(3000, "0x12f190a9F9d7D37a250758b26824B97CE941bF54")]],
  ["META", [hop(100, USDG), hop(3000, "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35")]],
  ["MSFT", [hop(100, USDG), hop(3000, "0xe93237C50D904957Cf27E7B1133b510C669c2e74")]],
  ["SPY", [hop(100, USDG), hop(500, "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C")]],
];

function route(hops: [number, string][]): Hex {
  const types: ("address" | "uint24")[] = ["address"];
  const values: (string | number)[] = [VENTURE.weth];
  for (const [fee, token] of hops) { types.push("uint24", "address"); values.push(fee, token); }
  return encodePacked(types, values as never);
}

export function payoutChoices(symbol: string): PayoutChoice[] {
  const base: PayoutChoice[] = [
    { key: "eth", label: "ETH", kind: 0, path: "0x" },
    { key: "coin", label: `$${symbol}`, kind: 1, path: "0x" },
  ];
  if (env.chainId !== 4663) return base;
  return [
    ...base,
    { key: "usdg", label: "USDG", kind: 2, path: route([hop(100, USDG)]) },
    ...STOCKS.map(([sym, hops]) => ({ key: sym.toLowerCase(), label: sym, kind: 2 as const, path: route(hops) })),
  ];
}

/** Which choice a stored preference is. */
export function choiceFor(choices: PayoutChoice[], kind: number, path: Hex): PayoutChoice {
  return choices.find((c) => c.kind === kind && (c.kind !== 2 || c.path.toLowerCase() === path.toLowerCase())) ?? choices[0];
}
