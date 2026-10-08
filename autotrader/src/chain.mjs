// Robinhood Chain mainnet addresses and event shapes the trader reads.
// Pons V2 addresses are from Bitquery's Pons API docs, checked on-chain.
import { ethers } from "ethers";

export const RPC = process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;
export const provider = () => new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true, batchMaxCount: 50 });

export const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

export const PONS = {
  factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  hook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
};

export const iface = new ethers.Interface([
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
  "event SnipeTaxCharged(address indexed recipient, uint256 amount)",
  "event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)",
  "event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)",
  "event HookFeeCollected(bytes32 indexed poolId, address currency, uint256 feeAmount, uint256 taxAmount)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
export const topic = (name) => iface.getEvent(name).topicHash;
