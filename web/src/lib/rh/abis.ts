// Minimal ABIs for the Robinhood-chain pair=reward fork (RhFactory / RhHook /
// RhRouter). The launched coin pairs against a chosen stock or meme token, and
// that token is both the pool quote and the holder reward.

export const factoryAbi = [
  {
    type: "event",
    name: "Launched",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "pair", type: "address", indexed: true },
      { name: "taxBps", type: "uint16", indexed: false },
      { name: "poolId", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataURI", type: "string" },
          { name: "pair", type: "address" },
          { name: "taxBps", type: "uint16" },
          { name: "pairUsdPrice8", type: "uint256" },
        ],
      },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "poolId", type: "bytes32" },
    ],
  },
  { type: "function", name: "totalTokens", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "listings",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "pair", type: "address" },
      { name: "taxBps", type: "uint16" },
      { name: "createdAt", type: "uint64" },
      { name: "poolId", type: "bytes32" },
    ],
  },
  { type: "function", name: "pairListed", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "anyPairEnabled", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "launchesPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "TOTAL_SUPPLY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setLaunchesPaused", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },
  { type: "function", name: "listPair", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "delistPair", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "setAnyPairEnabled", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },
  { type: "function", name: "protocolAdmin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "unwindPosition", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint16" }, { type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  // Base-stock factory (StockFlyFactoryV2): B-20 coins carry no on-chain
  // metadataURI, so the factory is the registry. Also exposes the per-coin
  // holder-reward vault.
  { type: "function", name: "metadataURIOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "string" }] },
  { type: "function", name: "rewardVaultOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

// StockFlyFactoryV2.launch: adds burnBps + liquidityBps to the base tuple, so
// part of the creator share can auto-burn the coin and single-side liquidity.
// The chosen `pair` is the tokenized stock holders earn (not forced to WETH).
export const baseFactoryLaunchAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataURI", type: "string" },
          { name: "pair", type: "address" },
          { name: "taxBps", type: "uint16" },
          { name: "pairUsdPrice8", type: "uint256" },
          { name: "burnBps", type: "uint16" },
          { name: "liquidityBps", type: "uint16" },
        ],
      },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "poolId", type: "bytes32" },
    ],
  },
] as const;

// StockFlyFactoryV3.launch: fixed 2% tax (no per-coin choice), no burn/liquidity
// slices. The tuple carries a `feeRecipient` — where the creator's 50% share of
// the trade tax is pushed each trade (defaults to msg.sender when zero). The
// chosen `pair` is the tokenized stock/ETH/USDC holders earn.
export const baseFactoryV3LaunchAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataURI", type: "string" },
          { name: "pair", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "pairUsdPrice8", type: "uint256" },
        ],
      },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "poolId", type: "bytes32" },
    ],
  },
] as const;

// StockFlyFactoryV3 read-only views: authoritative pool spot (decimals-aware)
// plus the per-coin fee recipient the frontend surfaces on the token page.
export const baseFactoryV3ViewsAbi = [
  {
    type: "function",
    name: "poolSpot",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tokenIsCurrency0", type: "bool" },
      { name: "pairDecimals", type: "uint8" },
    ],
  },
  { type: "function", name: "feeRecipientOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "rewardVaultOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

// StockRewardVault: per-coin holder-reward vault. Holders claim their share of
// the paired stock with a Merkle proof the keeper publishes; `claimed` guards
// double claims and `distributable` is the stock not yet committed to an epoch.
export const stockRewardVaultAbi = [
  { type: "function", name: "stock", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "coin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "epochCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "distributable", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimed", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "epochId", type: "uint256" },
      { name: "index", type: "uint256" },
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [],
  },
] as const;

// Uniswap V4 periphery StateView: canonical pool-state reads without logs.
export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

export const tokenAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "metadataURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "creator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "taxBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "rewardToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "totalRewardsDistributed", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingRewards", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sellTaxBpsOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint16" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export const hookAbi = [
  { type: "function", name: "harvest", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "harvestBounded", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "tokenFees", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pairFees", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "genesis", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "communityPot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "topTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address[3]" }] },
  { type: "function", name: "tokenVol", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "traderVol", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "traderClaimable", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimTrader", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochResolved", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "platformTreasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "setPlatformTreasury", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;

// StockTradeRouter: pair-denominated coin<->pair trading through the coin's own
// v4 pool. The caller trades the coin against its pair token (USDC or a stock).
export const stockTradeRouterAbi = [
  { type: "function", name: "buy", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  // Native-ETH convenience, for coins paired with WETH.
  { type: "function", name: "buyWithEth", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sellForEth", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

// RhRouter: one-tap ETH<->pair<->coin. The V3 path (WETH->...->pair) is passed
// as bytes; empty when the pair token is WETH.
export const routerAbi = [
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "address" }, { type: "bytes" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

// Uniswap V4 PoolManager Swap event (source of price + trades).
export const poolSwapEvent = {
  type: "event",
  name: "Swap",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128", indexed: false },
    { name: "amount1", type: "int128", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "liquidity", type: "uint128", indexed: false },
    { name: "tick", type: "int24", indexed: false },
    { name: "fee", type: "uint24", indexed: false },
  ],
} as const;

// Uniswap V4 PoolManager Initialize event (initial pool price at launch).
export const poolInitEvent = {
  type: "event",
  name: "Initialize",
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "currency0", type: "address", indexed: true },
    { name: "currency1", type: "address", indexed: true },
    { name: "fee", type: "uint24", indexed: false },
    { name: "tickSpacing", type: "int24", indexed: false },
    { name: "hooks", type: "address", indexed: false },
    { name: "sqrtPriceX96", type: "uint160", indexed: false },
    { name: "tick", type: "int24", indexed: false },
  ],
} as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
