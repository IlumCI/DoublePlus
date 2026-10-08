// Builds the stock-token table the premium tracker reads: each tokenized stock
// on Robinhood Chain with its Chainlink feed and its deepest Uniswap V3 pool
// (against USDG or WETH). Writes web/src/venture/stocks.json.
//
//   node src/stocks-config.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";

import { provider, USDG, WETH } from "./chain.mjs";

const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";

const p = provider();
const routes = JSON.parse(readFileSync(new URL("../../contracts/config/rh-stock-routes.json", import.meta.url), "utf8"));
const tokenOf = new Map(routes.map((r) => [r.symbol.toUpperCase(), r]));
const feeds = await (await fetch(FEEDS_URL)).json();
const factory = new ethers.Contract(V3_FACTORY, ["function getPool(address,address,uint24) view returns (address)"], p);
const erc = (a) => new ethers.Contract(a, ["function balanceOf(address) view returns (uint256)"], p);
const agg = (a) => new ethers.Contract(a, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], p);
const ethUsd = Number((await agg(ETH_USD_FEED).latestRoundData())[1]) / 1e8;

const out = [];
for (const f of feeds) {
  const m = /^Robinhood ([A-Z.]+)\s*[-/]\s*USD$/.exec(f.name);
  if (!m) continue;
  const sym = m[1];
  const r = tokenOf.get(sym);
  if (!r) { console.log(`skip ${sym}: no token address`); continue; }
  let best = null;
  for (const [quote, qsym] of [[USDG, "USDG"], [WETH, "WETH"]]) {
    for (const fee of [100, 500, 3000, 10000]) {
      const pool = await factory.getPool(r.address, quote, fee);
      if (pool === ethers.ZeroAddress) continue;
      const bal = await erc(quote).balanceOf(pool);
      const usd = qsym === "USDG" ? Number(bal) / 1e6 : (Number(bal) / 1e18) * ethUsd;
      if (!best || usd > best.depthUsd) best = { pool, quote: qsym, fee, depthUsd: Math.round(usd) };
    }
  }
  if (!best || best.depthUsd < 5000) { console.log(`skip ${sym}: no pool with real depth`); continue; }
  out.push({ symbol: sym, name: r.name, token: r.address, feed: f.proxyAddress, ...best });
  console.log(`${sym.padEnd(6)} ${best.quote} ${best.fee} depth $${best.depthUsd.toLocaleString()}`);
}
out.sort((a, b) => b.depthUsd - a.depthUsd);
writeFileSync(new URL("../../web/src/venture/stocks.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${out.length} stocks`);
