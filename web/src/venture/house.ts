import { useEffect, useState } from "react";
import { type Address, zeroAddress } from "viem";

import { venturePc } from "./client";

/** $DOUBLEPLUS, relaunched on Flap. The board pins it on top and links out
 *  to Flap; the first launch (on our v1 factory) is left off the board. */
export const HOUSE = {
  token: "0xc40f1686f7252a372ea98164dd750897f83c7777" as Address,
  replaces: "0xc44cfd968a38c6b16a8be4677bbb87d0ebb42add",
  portal: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09" as Address,
  url: "https://flap.sh/robinhood/0xc40f1686f7252a372ea98164dd750897f83c7777",
  name: "DoublePlusFun",
  symbol: "DOUBLEPLUS",
  logo: "/doubleplus-logo.png",
  createdAt: 1793206180,
  supply: 1_000_000_000,
};

const stateAbi = [{
  type: "function", name: "getTokenV9Safe", stateMutability: "view", inputs: [{ type: "address" }],
  outputs: [{ type: "tuple", components: [
    { name: "status", type: "uint8" }, { name: "reserve", type: "uint256" }, { name: "circulatingSupply", type: "uint256" },
    { name: "price", type: "uint256" }, { name: "tokenVersion", type: "uint8" }, { name: "r", type: "uint256" },
    { name: "h", type: "uint256" }, { name: "k", type: "uint256" }, { name: "dexSupplyThresh", type: "uint256" },
    { name: "quoteTokenAddress", type: "address" }, { name: "nativeToQuoteSwapEnabled", type: "bool" },
    { name: "extensionID", type: "bytes32" }, { name: "buyTaxRate", type: "uint256" }, { name: "sellTaxRate", type: "uint256" },
    { name: "pool", type: "address" }, { name: "progress", type: "uint256" }, { name: "lpFeeProfile", type: "uint8" },
    { name: "dexId", type: "uint8" }, { name: "bondingCurveFeeRate", type: "uint16" },
  ] }],
}] as const;

export interface HouseState {
  /** Fully diluted market cap, in ETH. */
  mcapEth: number;
  /** Bonding-curve progress, 0–100. */
  progressPct: number;
  /** Graduated to a DEX pool. */
  listed: boolean;
}

/** Flap's own price for the coin (wei per whole coin) and curve progress. */
export function useHouseCoin(): HouseState | null {
  const [s, setS] = useState<HouseState | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => venturePc.readContract({ address: HOUSE.portal, abi: stateAbi, functionName: "getTokenV9Safe", args: [HOUSE.token] })
      .then((t) => {
        if (!live) return;
        setS({
          mcapEth: (Number(t.price) / 1e18) * HOUSE.supply,
          progressPct: Number(t.progress) / 1e16,
          listed: t.pool !== zeroAddress,
        });
      })
      .catch(() => undefined);
    read();
    const t = setInterval(read, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return s;
}
