import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Rotates protocol privileges independently of deployments.
 *
 * Grants roles on Launchpad, FeeDistributor and Treasury to NEW_ADMIN and,
 * when REVOKE_FROM is set, removes them from the old holder. The signer must
 * currently hold DEFAULT_ADMIN_ROLE on each contract (i.e. run it with the
 * current platform admin's key, or execute the same calls from the multisig).
 *
 * Usage:
 *   NEW_ADMIN=0x... [REVOKE_FROM=0x...] [ROLES=admin,liquidity,operator,treasurer] \
 *     npx hardhat run scripts/transfer-admin.ts --network robinhood
 *
 * ROLES defaults to all four. Grant-before-revoke ordering plus post-checks
 * guarantee the protocol is never left without an admin.
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const newAdmin = process.env.NEW_ADMIN;
  const revokeFrom = process.env.REVOKE_FROM;
  if (!newAdmin || !ethers.isAddress(newAdmin)) throw new Error("Set NEW_ADMIN to a valid address");
  if (revokeFrom && !ethers.isAddress(revokeFrom)) throw new Error("REVOKE_FROM is not a valid address");

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment file for network '${network.name}'`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const ADMIN = ethers.ZeroHash;
  const roleIds: Record<string, string> = {
    admin: ADMIN,
    liquidity: ethers.id("LIQUIDITY_MANAGER_ROLE"),
    operator: ethers.id("OPERATOR_ROLE"),
    treasurer: ethers.id("TREASURER_ROLE"),
  };
  const selected = (process.env.ROLES ?? "admin,liquidity,operator,treasurer")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r in roleIds);

  const targets = [
    {
      name: "Launchpad",
      contract: await ethers.getContractAt("Launchpad", d.contracts.launchpad),
      roles: ["admin", "liquidity", "operator"],
    },
    {
      name: "FeeDistributor",
      contract: await ethers.getContractAt("FeeDistributor", d.contracts.feeDistributor),
      roles: ["admin"],
    },
    {
      name: "Treasury",
      contract: await ethers.getContractAt("Treasury", d.contracts.treasury),
      roles: ["admin", "treasurer"],
    },
  ];

  console.log(`Signer: ${signer.address}`);
  console.log(`Granting to ${newAdmin}${revokeFrom ? `, revoking from ${revokeFrom}` : ""}`);

  for (const t of targets) {
    const roles = t.roles.filter((r) => selected.includes(r));
    for (const roleName of roles) {
      const role = roleIds[roleName];
      if (!(await t.contract.hasRole(role, newAdmin))) {
        await (await t.contract.grantRole(role, newAdmin)).wait();
      }
      if (!(await t.contract.hasRole(role, newAdmin))) {
        throw new Error(`${t.name}: grant of ${roleName} to ${newAdmin} failed`);
      }
      console.log(`${t.name}: ${roleName} granted to ${newAdmin}`);

      if (revokeFrom) {
        if (await t.contract.hasRole(role, revokeFrom)) {
          await (await t.contract.revokeRole(role, revokeFrom)).wait();
        }
        if (await t.contract.hasRole(role, revokeFrom)) {
          throw new Error(`${t.name}: revoke of ${roleName} from ${revokeFrom} failed`);
        }
        console.log(`${t.name}: ${roleName} revoked from ${revokeFrom}`);
      }
    }
  }

  console.log("Role rotation complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
