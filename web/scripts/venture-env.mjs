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
    rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com",
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
  VITE_VENTURE_START_BLOCK: String(d.startBlock),
  VITE_WETH_ADDRESS: d.contracts.weth,
  VITE_PLATFORM_FEE_BPS: String(d.platformFeeBps),
  VITE_REF_SHARE_BPS: String(d.refShareBps),
  // Mainnet prices ETH live; the testnet's explorer can't, so it keeps its fallback.
  ...(which === "mainnet" ? { VITE_ETH_USD_8_FALLBACK: "" } : {}),
};

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
  s = s.replace(/^FACTORY\s*=.*$/m, `FACTORY = "${d.contracts.factory}"`);
  s = s.replace(/^RPC_URL\s*=.*$/m, `RPC_URL = "${NET.rpc}"`);
  fs.writeFileSync(wrangler, s);
  console.log("updated api/wrangler.toml (redeploy: cd api && npx wrangler deploy)");
}
