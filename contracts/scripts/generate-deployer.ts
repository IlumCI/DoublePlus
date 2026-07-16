import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

/**
 * Generates the platform deployer wallet.
 *
 * This wallet belongs to the protocol, not to any individual. It exists only
 * to sign contract deployments: the deploy script hands every admin role to
 * PLATFORM_ADMIN (ideally a team multisig) and renounces the deployer's own
 * roles, so this key holds zero privileges the moment deployment finishes.
 * Losing or rotating it never affects the running protocol.
 *
 * The key is written to contracts/.env.deployer (gitignored) and is never
 * printed. Run this on a machine the core team controls; back the file up in
 * the team's secret manager, not in the repository.
 */
async function main() {
  const outFile = path.join(__dirname, "..", ".env.deployer");
  if (fs.existsSync(outFile)) {
    throw new Error(
      `${outFile} already exists. Refusing to overwrite an existing deployer key; ` +
        "move it away first if you really want a new one."
    );
  }

  const wallet = Wallet.createRandom();
  fs.writeFileSync(
    outFile,
    [
      "# Platform deployer wallet. DO NOT COMMIT. Store a copy in the team secret manager.",
      `# Generated ${new Date().toISOString()}`,
      `DEPLOYER_ADDRESS=${wallet.address}`,
      `PRIVATE_KEY=${wallet.privateKey}`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );

  console.log("Platform deployer wallet generated.");
  console.log(`Address: ${wallet.address}`);
  console.log(`Key written to ${outFile} (gitignored, mode 600). The key was not printed.`);
  console.log("");
  console.log("Next steps:");
  console.log("1. Back .env.deployer up in the team secret manager.");
  console.log("2. Fund the address with enough native currency for deployment gas.");
  console.log("3. Set PLATFORM_ADMIN in .env to the team multisig that should own the protocol.");
  console.log("4. Deploy: npx hardhat run scripts/deploy.ts --network robinhood");
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exitCode = 1;
});
