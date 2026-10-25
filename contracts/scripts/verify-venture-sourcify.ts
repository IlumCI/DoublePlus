// Verifies a venture system's contracts on Sourcify (and through it on the
// chain's Blockscout). No transaction and no gas: one request per contract,
// then a check that each matched.
//
//   npx hardhat compile
//   node --import tsx scripts/verify-venture-sourcify.ts [deployments/venture-robinhood.json]
//
// Each contract is submitted with the solc input of the build that holds it,
// so the factory and the hook (compiled with their own optimizer settings)
// match too. Sourcify reads the constructor arguments from the creation
// transaction itself.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const API = "https://sourcify.dev/server";
const NAMES: Record<string, string> = {
  hookDeployer: "HookDeployer",
  curveDesk: "VentureCurveDesk",
  hook: "VentureFeeHook",
  factory: "VentureFactory",
  router: "VentureRouter",
  updates: "VentureUpdates",
  limitOrders: "VentureLimitOrders",
  payouts: "VenturePayouts",
  boosts: "VentureBoosts",
  tokenDeployer: "VentureTokenDeployer",
  vestingDeployer: "VestingDeployer",
};

const root = join(__dirname, "..");
const dep = JSON.parse(readFileSync(join(root, process.argv[2] ?? "deployments/venture-robinhood.json"), "utf8"));
const infos = readdirSync(join(root, "artifacts/build-info")).map((f) => JSON.parse(readFileSync(join(root, "artifacts/build-info", f), "utf8")));

/** The newest build that compiled `name`, and the source path it lives at. */
function buildOf(name: string) {
  for (const info of infos.slice().reverse()) {
    for (const [file, out] of Object.entries(info.output?.contracts ?? {})) {
      if ((out as Record<string, unknown>)[name]) return { info, file };
    }
  }
  throw new Error(`no build holds ${name}; run npx hardhat compile`);
}

async function main() {
  const chainId = dep.chainId;
  for (const [key, name] of Object.entries(NAMES)) {
    const address = dep.contracts[key];
    if (!address) continue;
    const got = await (await fetch(`${API}/v2/contract/${chainId}/${address}`)).json();
    if (got.match) { console.log(`${key} ${address}: already verified (${got.match})`); continue; }
    const { info, file } = buildOf(name);
    const body = { stdJsonInput: info.input, compilerVersion: info.solcLongVersion, contractIdentifier: `${file}:${name}` };
    const r = await fetch(`${API}/v2/verify/${chainId}/${address}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    console.log(`${key} ${address}: submitted (${r.status})${r.ok ? "" : ` ${(await r.text()).slice(0, 200)}`}`);
  }
  // The matches land a few seconds after the submissions.
  await new Promise((ok) => setTimeout(ok, 30_000));
  for (const key of Object.keys(NAMES)) {
    const address = dep.contracts[key];
    if (!address) continue;
    const got = await (await fetch(`${API}/v2/contract/${chainId}/${address}`)).json();
    console.log(`${key}: ${got.match ?? "not matched yet (run again in a minute)"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
