import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Points the venture build and the chat API at a deployment.
//
//   node web/scripts/venture-env.mjs testnet   (deployments/venture-testnet.json)
//   node web/scripts/venture-env.mjs mainnet   (deployments/venture-robinhood.json)
//
// Rewrites the VITE_VENTURE_* lines (and WETH, fees, start block, chain) in
// web/.env.venture and web/.env.venture.example, and FACTORY / RPC_URL in
// api/wrangler.toml. Other lines are left as they are. Redeploy the worker
// afterwards: cd api && npx wrangler deploy.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const which = process.argv[2];
const NET = {
  testnet: {
    file: "venture-testnet.json", chainId: 46630, name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com",
  },
  mainnet: {
    file: "venture-robinhood.json", chainId: 4663, name: "Robinhood Chain",
    // Robinhood's own RPC first: it alone serves the long log ranges history
    // and the keeper read. The others carry balances, quotes and trades if
    // it goes down (Daybreak serves logs 2k blocks at a time; dRPC's free
    // plan serves none).
    rpc: "https://rpc.mainnet.chain.robinhood.com,https://robinhood.daybreak-rpc.network,https://robinhood.drpc.org", explorer: "https://robinhoodchain.blockscout.com",
  },
}[which];
if (!NET) {
  console.error("usage: node web/scripts/venture-env.mjs testnet|mainnet");
  process.exit(1);
}
const depPath = path.join(root, "contracts", "deployments", NET.file);
if (!fs.existsSync(depPath)) {
  console.error(`missing ${depPath}; deploy first`);
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(depPath, "utf8"));
if (d.chainId !== NET.chainId) {
  console.error(`${NET.file} is for chain ${d.chainId}, expected ${NET.chainId}`);
  process.exit(1);
}

const values = {
  VITE_CHAIN_ID: String(NET.chainId),
  VITE_CHAIN_NAME: `"${NET.name}"`,
  VITE_RPC_URL: NET.rpc,
  VITE_EXPLORER_URL: NET.explorer,
  VITE_VENTURE_FACTORY: d.contracts.factory,
  VITE_VENTURE_TOKEN_DEPLOYER: d.contracts.tokenDeployer,
  VITE_VENTURE_HOOK: d.contracts.hook,
  VITE_VENTURE_ROUTER: d.contracts.router,
  VITE_VENTURE_UPDATES: d.contracts.updates,
  VITE_VENTURE_LIMIT_ORDERS: d.contracts.limitOrders ?? "",
  VITE_VENTURE_PAYOUTS: d.contracts.payouts ?? "",
  VITE_VENTURE_BOOSTS: d.contracts.boosts ?? "",
  VITE_VENTURE_DESK: d.contracts.curveDesk ?? "",
  VITE_VENTURE_START_BLOCK: String(d.startBlock),
  VITE_WETH_ADDRESS: d.contracts.weth,
  VITE_PLATFORM_FEE_BPS: String(d.platformFeeBps),
  VITE_REF_SHARE_BPS: String(d.refShareBps),
  // Testnet launches are sized at a scaled ETH price, so a curve's $750
  // start costs ~0.0002 ETH instead of ~0.25; mainnet always reads it live.
  VITE_LAUNCH_ETH_USD_8: which === "testnet" ? "186500000000000" : "0",
};

// A redeploy keeps the previous system's record as <file>.<factory>.json
// (deploy-venture.ts), and its coins stay live there: the site runs it as
// VITE_VENTURE_V1_*, and the chat API takes both factories.
const prev = fs.readdirSync(path.dirname(depPath))
  .filter((f) => f.startsWith(NET.file.replace(/\.json$/, ".")) && f !== NET.file)
  .map((f) => JSON.parse(fs.readFileSync(path.join(path.dirname(depPath), f), "utf8")))
  .filter((p) => p.chainId === NET.chainId && p.contracts?.factory !== d.contracts.factory)
  .sort((x, y) => y.startBlock - x.startBlock)[0];
if (prev) {
  const c = prev.contracts;
  Object.assign(values, {
    VITE_VENTURE_V1_FACTORY: c.factory, VITE_VENTURE_V1_TOKEN_DEPLOYER: c.tokenDeployer, VITE_VENTURE_V1_HOOK: c.hook,
    VITE_VENTURE_V1_ROUTER: c.router, VITE_VENTURE_V1_UPDATES: c.updates, VITE_VENTURE_V1_LIMIT_ORDERS: c.limitOrders ?? "",
    VITE_VENTURE_V1_PAYOUTS: c.payouts ?? "", VITE_VENTURE_V1_BOOSTS: c.boosts ?? "", VITE_VENTURE_V1_DESK: c.curveDesk ?? "",
    VITE_VENTURE_V1_START_BLOCK: String(prev.startBlock),
  });
}
const factories = [d.contracts.factory, ...(prev ? [prev.contracts.factory] : [])].join(",");

function patchEnv(file) {
  if (!fs.existsSync(file)) return;
  let s = fs.readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    s = re.test(s) ? s.replace(re, line) : `${s.trimEnd()}\n${line}\n`;
  }
  fs.writeFileSync(file, s);
  console.log(`updated ${path.relative(root, file)}`);
}
patchEnv(path.join(root, "web", ".env.venture"));
patchEnv(path.join(root, "web", ".env.venture.example"));

const wrangler = path.join(root, "api", "wrangler.toml");
if (fs.existsSync(wrangler)) {
  let s = fs.readFileSync(wrangler, "utf8");
  s = s.replace(/^FACTORY\s*=.*$/m, `FACTORY = "${factories}"`);
  s = s.replace(/^RPC_URL\s*=.*$/m, `RPC_URL = "${NET.rpc}"`);
  fs.writeFileSync(wrangler, s);
  console.log("updated api/wrangler.toml (redeploy: cd api && npx wrangler deploy)");
}
