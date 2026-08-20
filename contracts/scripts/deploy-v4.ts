import { ethers, network } from "hardhat";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";

// Live Uniswap V4 on Robinhood Chain.
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n); // afterSwap | afterSwapReturnDelta
const FLAG_MASK = (1n << 14n) - 1n;

type Stock = { symbol: string; name: string; address: string; fee: number; tickSpacing: number };
type Cfg = {
  weth: string;
  usdg: string;
  wethUsdgPool: { fee: number; tickSpacing: number; hooks: string };
  stocks: Stock[];
};

function mine(deployer: string, initCodeHash: string, match: (addr: string) => boolean, max = 4_000_000n): string {
  for (let i = 0n; i < max; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if (match(addr)) return salt;
  }
  throw new Error("salt not found");
}

async function main() {
  const [signer] = await ethers.getSigners();
  const cfg: Cfg = JSON.parse(readFileSync(join(__dirname, "../config/v4-stocks.json"), "utf8"));

  // The deployer owns the contracts only during setup (listing stocks, wiring
  // routes); ownership is renounced at the end. The immutable protocolAdmin is
  // the ONLY privilege that survives renounce (it gates the Factory LP unwind).
  const protocolAdmin = process.env.PROTOCOL_ADMIN;
  if (!protocolAdmin) throw new Error("Set PROTOCOL_ADMIN — the immutable protocol admin (LP unwind role).");
  const treasury = process.env.TREASURY ?? protocolAdmin; // protocol fee sink (WETH)
  const price8 = BigInt(process.env.WETH_USD_PRICE8 ?? String(3000n * 10n ** 8n));
  const vanity = process.env.VANITY !== "0"; // factory address ends in 4663
  const renounce = process.env.RENOUNCE === "1"; // renounce owner after setup

  console.log("deployer (setup owner):", signer.address);
  console.log("protocolAdmin:", protocolAdmin, "| treasury:", treasury, "| WETH/USD(8):", price8.toString());
  console.log("renounce after setup:", renounce);

  // 1. CREATE2 deployer used to place the hook (flags) and factory (vanity).
  const Deployer = await ethers.getContractFactory("HookDeployer");
  const c2 = await Deployer.deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  // 2. Hook — owner is the deployer during setup, transferred to admin after.
  const Hook = await ethers.getContractFactory("QuiverHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address"],
    [POOL_MANAGER, signer.address, treasury, cfg.weth],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  console.log("mining hook flags…");
  const hookSalt = mine(c2Addr, ethers.keccak256(hookInit), (a) => (BigInt(a) & FLAG_MASK) === HOOK_FLAGS);
  const hookAddr = ethers.getCreate2Address(c2Addr, hookSalt, ethers.keccak256(hookInit));
  await (await c2.deploy(hookSalt, hookInit)).wait();
  const hook = await ethers.getContractAt("QuiverHook", hookAddr);
  console.log("hook:", hookAddr);

  // 3. Factory — vanity address ending 4663.
  const Factory = await ethers.getContractFactory("QuiverFactory");
  const facArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "address", "uint256"],
    [signer.address, protocolAdmin, POOL_MANAGER, hookAddr, cfg.weth, price8],
  );
  const facInit = ethers.concat([Factory.bytecode, facArgs]);
  console.log(vanity ? "mining factory vanity …4663…" : "deploying factory…");
  const facSalt = mine(
    c2Addr,
    ethers.keccak256(facInit),
    (a) => !vanity || a.toLowerCase().endsWith("4663"),
  );
  const facAddr = ethers.getCreate2Address(c2Addr, facSalt, ethers.keccak256(facInit));
  await (await c2.deploy(facSalt, facInit)).wait();
  const factory = await ethers.getContractAt("QuiverFactory", facAddr);
  console.log("factory:", facAddr);

  // Uniswap V4 PoolKeys REQUIRE currency0 < currency1. Sort every key we build,
  // or its poolId points at a non-existent pool and swaps revert PoolNotInitialized.
  const poolKey = (a: string, b: string, fee: number, tickSpacing: number) => {
    const [currency0, currency1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    return { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress };
  };

  // 4. Wire the hook and the WETH->USDG reward hop.
  await (await hook.setFactory(facAddr)).wait();
  const wethUsdgKey = poolKey(cfg.weth, cfg.usdg, cfg.wethUsdgPool.fee, cfg.wethUsdgPool.tickSpacing);
  await (await hook.setQuoteRoute(cfg.usdg, wethUsdgKey)).wait();

  // 5. List every stock with its sorted USDG/stock pool key.
  for (const s of cfg.stocks) {
    const stockKey = poolKey(cfg.usdg, s.address, s.fee, s.tickSpacing);
    await (await factory.listStock(s.address, stockKey)).wait();
    console.log("listed stock:", s.symbol);
  }

  // 6. Renounce ownership on both contracts. Every owner-only function is then
  //    permanently disabled; only the Factory's protocolAdmin-gated LP unwind
  //    survives. Gated behind RENOUNCE=1 so a deploy can be checked first.
  if (renounce) {
    await (await hook.renounceOwnership()).wait();
    await (await factory.renounceOwnership()).wait();
    console.log("ownership renounced — protocolAdmin retains only LP unwind");
  } else {
    console.log("ownership NOT renounced (owner =", signer.address, "); set RENOUNCE=1 to renounce");
  }

  const out = {
    network: network.name,
    chainId: 4663,
    startBlock: await ethers.provider.getBlockNumber(),
    deployer: signer.address,
    protocolAdmin,
    treasury,
    renounced: renounce,
    wethUsdPrice8: price8.toString(),
    v4: { poolManager: POOL_MANAGER, weth: cfg.weth, usdg: cfg.usdg },
    contracts: { create2Deployer: c2Addr, hook: hookAddr, factory: facAddr },
    stocks: cfg.stocks.map((s) => ({ symbol: s.symbol, address: s.address })),
  };
  const path = join(__dirname, "../deployments/quiver-v4.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log("saved", path);
  console.log("\nverify with:\n  npx hardhat verify --network robinhood", hookAddr, POOL_MANAGER, signer.address, treasury, cfg.weth);
  console.log("  npx hardhat verify --network robinhood", facAddr, signer.address, protocolAdmin, POOL_MANAGER, hookAddr, cfg.weth, price8.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
