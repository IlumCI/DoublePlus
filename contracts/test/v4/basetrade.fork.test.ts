import { expect } from "chai";
import { ethers } from "hardhat";

// Live Base mainnet addresses (fork target).
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const SLIPSTREAM_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const FACTORY_V2 = "0xEA3dC62EbB16CAEB848c316a89D54a90Fc348301";
const HOOK = "0x5130c8Fb3B2F8fc1018F78fCC4223aFE8BAD6044";
const COIN = "0xb200000000000000000000d7386d4D98A2386Ff6"; // live 5090
const NVDAC = "0xb20000000000000000000078ee7ce2fE4908108C";

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function deposit() payable",
];
const slipAbi = [
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

/**
 * StockFlyRouter verification on a Base fork.
 *
 * NOTE: Base's tokenized stocks (NVDAc, ...) and the launched coins are native
 * B-20 tokens — Rust *precompiles* at 0xb2… addresses. No EVM fork (hardhat
 * included) can execute a precompile, so any swap touching a B-20 token reverts
 * on a fork ("invalid opcode"), and the full ETH→coin chain cannot be
 * fork-tested end to end. This is the same reason the factory/hook suites use
 * MockB20 stand-ins. What we CAN verify on a fork:
 *   1. the router constructs against the live factory and binds the real hook;
 *   2. the Aerodrome Slipstream interface the router calls is correct (a real
 *      WETH→USDC hop through it, both regular ERC-20s).
 * The stock↔coin v4 leg is byte-identical to FlyRouter's (proven in
 * stockfly*.fork tests with MockB20). Full end-to-end confirmation is a small
 * live round-trip after deploy.
 */
describe("StockFlyRouter: construction + Aerodrome Slipstream leg (Base fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") {
    it.skip("requires FORK=1 against a Base RPC", () => {});
    return;
  }

  it("binds the live factory + hook and routes WETH→USDC through Slipstream", async () => {
    const [me] = await ethers.getSigners();

    const router = await (await ethers.getContractFactory("StockFlyRouter")).deploy(
      POOL_MANAGER,
      FACTORY_V2,
      WETH,
      SLIPSTREAM_ROUTER,
    );
    await router.waitForDeployment();

    // 1. Router bound the real deployment.
    expect((await router.poolManager()).toLowerCase()).to.equal(POOL_MANAGER.toLowerCase());
    expect((await router.factory()).toLowerCase()).to.equal(FACTORY_V2.toLowerCase());
    expect((await router.hook()).toLowerCase()).to.equal(HOOK.toLowerCase());
    expect((await router.aeroRouter()).toLowerCase()).to.equal(SLIPSTREAM_ROUTER.toLowerCase());

    // The live factory lists the 5090 coin as pairing NVDAc (regular reads).
    const factory = await ethers.getContractAt(
      ["function listings(address) view returns (address,address,uint16,uint64,bytes32)"],
      FACTORY_V2,
    );
    expect((await factory.listings(COIN))[1].toLowerCase()).to.equal(NVDAC.toLowerCase());

    // 2. The Aerodrome Slipstream router the contract calls really works:
    //    wrap 0.05 ETH and swap WETH→USDC through it (both regular ERC-20s).
    const weth = await ethers.getContractAt(erc20Abi, WETH);
    const usdc = await ethers.getContractAt(erc20Abi, USDC);
    const slip = await ethers.getContractAt(slipAbi, SLIPSTREAM_ROUTER);
    await (await weth.deposit({ value: ethers.parseEther("0.05") })).wait();
    await (await weth.approve(SLIPSTREAM_ROUTER, ethers.MaxUint256)).wait();
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    await (
      await slip.exactInputSingle({
        tokenIn: WETH, tokenOut: USDC, tickSpacing: 1, recipient: me.address,
        deadline, amountIn: ethers.parseEther("0.05"), amountOutMinimum: 0, sqrtPriceLimitX96: 0,
      })
    ).wait();
    const usdcOut = (await usdc.balanceOf(me.address)) as bigint;
    expect(usdcOut, "Slipstream WETH→USDC produced USDC").to.be.greaterThan(0n);
    // eslint-disable-next-line no-console
    console.log(`      Slipstream WETH→USDC: 0.05 ETH -> ${ethers.formatUnits(usdcOut, 6)} USDC`);
  });
});
