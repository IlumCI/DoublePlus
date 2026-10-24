// Writes token-source.json: the compiler input every launched coin's code is
// built from, cut down to the files QuiverToken actually imports (the same
// bytecode, a fraction of the size), for the keeper to hand Sourcify. Rerun
// after `npx hardhat compile` whenever QuiverToken or its imports change:
//   node make-token-source.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const KEY = "contracts/v4/QuiverToken.sol";
const dir = new URL("../contracts/artifacts/build-info/", import.meta.url);
// The build whose QuiverToken is the one launched coins actually run: its
// creation code is embedded in the deployed TokenDeployer. Builds of other
// versions can sit beside it, and the newest file is not necessarily it.
const dep = JSON.parse(readFileSync(new URL("../contracts/deployments/venture-robinhood.json", import.meta.url), "utf8"));
const rpc = process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [dep.contracts.tokenDeployer, "latest"] }) });
const onchain = (await res.json()).result.slice(2);
const j = readdirSync(dir).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")))
  .find((b) => { const c = b.output.contracts[KEY]?.QuiverToken; return c && onchain.includes(c.evm.bytecode.object); });
if (!j) throw new Error(`no build-info holds the QuiverToken deployed at ${dep.contracts.tokenDeployer}; run npx hardhat compile in contracts/`);
const meta = JSON.parse(j.output.contracts[KEY].QuiverToken.metadata);
const sources = Object.fromEntries(Object.keys(meta.sources).map((s) => [s, { content: j.input.sources[s].content }]));
writeFileSync(new URL("token-source.json", import.meta.url), JSON.stringify({
  compilerVersion: j.solcLongVersion,
  contractIdentifier: `${KEY}:QuiverToken`,
  stdJsonInput: { language: "Solidity", sources, settings: { ...j.input.settings, outputSelection: { "*": { "*": ["metadata"] } } } },
}));
console.log(`token-source.json: ${Object.keys(sources).length} files, solc ${j.solcLongVersion}`);
