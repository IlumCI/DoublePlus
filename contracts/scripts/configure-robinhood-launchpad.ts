import { ethers } from "hardhat";

/**
 * Post-deploy wiring for the Robinhood Chain launchpad: price the WETH quote
 * at the real ETH/USD rate (the constructor defaults every wrapped native to
 * $1.00, which is only right on dollar-gas chains), hand the factory to the
 * long-term owner, then return leftover deploy gas.
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt(
    "StableLaunchpadFactory",
    process.env.FACTORY!,
  );
  const weth = process.env.WRAPPED_NATIVE!;
  const owner = process.env.NEW_OWNER!;
  const price8 = BigInt(process.env.ETH_USD_PRICE_8!);

  await (await factory.setQuoteAsset(weth, true, price8)).wait();
  console.log("WETH quote priced at", Number(price8) / 1e8, "USD");

  await (await factory.transferOwnership(owner)).wait();
  console.log("ownership ->", await factory.owner());

  const bal = await ethers.provider.getBalance(signer.address);
  const fee = (await ethers.provider.getFeeData()).gasPrice! * 30000n;
  if (bal > fee) {
    await (await signer.sendTransaction({ to: owner, value: bal - fee, gasLimit: 21000 })).wait();
    console.log("swept", ethers.formatEther(bal - fee), "ETH to owner");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
