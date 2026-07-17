import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Verifies contracts through Blockscout's native API v2 using the exact
 * standard-JSON compiler input from hardhat's build-info. More reliable on
 * Blockscout instances than the etherscan-compatible endpoint.
 */
async function main() {
  const networkName = process.env.HARDHAT_NETWORK ?? "robinhood";
  const blockscout = (process.env.BLOCKSCOUT_URL ?? "").replace(/\/$/, "");
  if (!blockscout) throw new Error("BLOCKSCOUT_URL not set");

  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${networkName}.json`), "utf8")
  );
  const c = deployment.contracts;

  // Latest build info contains the full solc input for all our contracts.
  const buildInfoDir = path.join(__dirname, "..", "artifacts", "build-info");
  const infos = fs
    .readdirSync(buildInfoDir)
    .map((f) => path.join(buildInfoDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const buildInfo = JSON.parse(fs.readFileSync(infos[0], "utf8"));
  const solcInput = JSON.stringify(buildInfo.input);
  const compilerVersion = `v${buildInfo.solcLongVersion}`;
  console.log(`Using compiler ${compilerVersion} from ${path.basename(infos[0])}`);

  const abi = ethers.AbiCoder.defaultAbiCoder();
  const graduationCap = BigInt(process.env.GRADUATION_CAP_USD_8 ?? String(40_000n * 10n ** 8n));
  const ethUsd = BigInt(process.env.ETH_USD_PRICE_8!);

  const targets: Array<{ name: string; file: string; address: string; args: string }> = [
    { name: "TokenFactory", file: "contracts/TokenFactory.sol", address: c.tokenFactory, args: "" },
    {
      name: "Treasury",
      file: "contracts/Treasury.sol",
      address: c.treasury,
      args: abi.encode(["address"], [deployment.deployer]).slice(2),
    },
    {
      name: "FeeDistributor",
      file: "contracts/FeeDistributor.sol",
      address: c.feeDistributor,
      args: abi.encode(["address"], [deployment.deployer]).slice(2),
    },
    {
      name: "Launchpad",
      file: "contracts/Launchpad.sol",
      address: c.launchpad,
      args: abi
        .encode(
          [
            "address",
            "address",
            "address",
            "address",
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
          ],
          [
            deployment.deployer,
            c.tokenFactory,
            deployment.uniswap.factory,
            deployment.uniswap.positionManager,
            deployment.uniswap.swapRouter,
            deployment.uniswap.weth,
            c.feeDistributor,
            c.treasury,
            graduationCap,
            ethUsd,
          ]
        )
        .slice(2),
    },
  ];

  for (const t of targets) {
    console.log(`Verifying ${t.name} at ${t.address} ...`);
    const form = new FormData();
    form.append("compiler_version", compilerVersion);
    form.append("contract_name", `${t.file}:${t.name}`);
    if (t.args) {
      form.append("constructor_args", t.args);
      form.append("autodetect_constructor_args", "false");
    } else {
      form.append("autodetect_constructor_args", "true");
    }
    form.append("files[0]", new Blob([solcInput], { type: "application/json" }), "input.json");

    const res = await fetch(
      `${blockscout}/api/v2/smart-contracts/${t.address}/verification/via/standard-input`,
      { method: "POST", body: form }
    );
    const body = await res.text();
    console.log(`  submit: ${res.status} ${body.slice(0, 160)}`);
  }

  // Poll for verification status.
  await new Promise((r) => setTimeout(r, 20_000));
  for (const t of targets) {
    const res = await fetch(`${blockscout}/api/v2/smart-contracts/${t.address}`);
    const data: any = await res.json();
    console.log(
      `${t.name}: verified=${Boolean(data.is_verified)} name=${data.name ?? "-"}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
