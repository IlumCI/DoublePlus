import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Generates web/.env.local from the localnet deployment written by
// contracts/scripts/localnet.ts, for local full-stack development.
const here = path.dirname(fileURLToPath(import.meta.url));
const deploymentPath = path.join(here, "..", "..", "contracts", "deployments", "localnet.json");
if (!fs.existsSync(deploymentPath)) {
  console.error("No localnet deployment found. Run the localnet script first:");
  console.error("  cd contracts && npx hardhat run scripts/localnet.ts --network localhost");
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
const env = `VITE_CHAIN_ID=${d.chainId}
VITE_CHAIN_NAME=Localnet
VITE_RPC_URL=http://127.0.0.1:8545
VITE_EXPLORER_URL=
VITE_NATIVE_SYMBOL=ETH
VITE_LAUNCHPAD_ADDRESS=${d.contracts.launchpad}
VITE_FEE_DISTRIBUTOR_ADDRESS=${d.contracts.feeDistributor}
VITE_TREASURY_ADDRESS=${d.contracts.treasury}
VITE_TOKEN_FACTORY_ADDRESS=${d.contracts.tokenFactory}
VITE_WETH_ADDRESS=${d.uniswap.weth}
VITE_API_URL=http://localhost:8080
VITE_WS_URL=ws://localhost:8080/ws
`;
fs.writeFileSync(path.join(here, "..", ".env.local"), env);
console.log("Wrote web/.env.local for localnet");
