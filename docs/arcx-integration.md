# arcx.fun launchpad - indexer and bot integration (Arc mainnet)

arcx.fun launches tokens directly into Uniswap V3 pools on the DyorSwap V3
factory on Arc. Everything needed to index launches, price pools, and route
swaps is below.

## Chain

- Chain: Arc mainnet, chainId 5042
- Native gas token: USDC (18 decimals at the RPC level; ERC-20 interface at
  `0x3600000000000000000000000000000000000000` with 6 decimals)
- Explorer: https://arc-mainnet.cloud.blockscout.com

## Contracts

| Contract | Address |
| --- | --- |
| Launchpad factory (ArcLaunchpadFactory) | `0xb6fEf7807587158B5d36EbE9a7c09F342C41929f` |
| Token deployer | `0xd9fe5F1fade896B7ceC8002D05A4E03D4da0600b` |
| Swap router (ArcSwapRouter) | `0x154B31f895DbBaDB47Cb2bc865Fa29f5109B7634` |
| DyorSwap V3 factory (pools live here) | `0xF0Db7b58379503491d857DB50Ac9ECE64C653918` |
| Quote asset: native USDC ERC-20 interface | `0x3600000000000000000000000000000000000000` |

## Discovering launches

Events on the launchpad factory (one set per launch):

```
TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, uint256 totalSupply)
PoolCreated(address indexed token, address indexed quote, address pool, uint24 feeTier, uint160 sqrtPriceX96, uint256 marketCapUsd8)
```

Log-free enumeration (works even where eth_getLogs is restricted):

- `totalTokens() -> uint256`
- `allTokens(uint256 index) -> address`
- `listings(address token) -> (address creator, address quote, address pool, int24 tickLower, int24 tickUpper, uint64 createdAt, bool tokenIsToken0)`

Token metadata lives on the token itself: `name()`, `symbol()`,
`totalSupply()` (always 1,000,000,000e18), and `metadataURI()` (JSON string
with description, image data URI, and social links).

## Pools

Every token trades in one standard Uniswap V3 pool on the DyorSwap factory:

- Pair: token vs native USDC (`0x3600...`), fee tier 10000 (1%), tickSpacing 200
- Pool address: `IUniswapV3Factory.getPool(token, 0x3600..., 10000)`, also in
  `listings()`
- Pool bytecode is canonical Uniswap V3 (CREATE2-verifiable with the standard
  init code hash), so standard V3 tooling works unchanged: slot0 for price,
  Swap events for trades
- Tokens are plain OpenZeppelin ERC-20s: fixed supply, no taxes, no
  blocklists, ownership renounced at birth

## Fees

- The 1% V3 pool fee is the only trading cost.
- Accrued pool fees are distributed by the factory's permissionless
  `harvestFees(token)`: 80% to the token's creator, 20% to the platform.

## Swapping

Any standard V3 router bound to the DyorSwap factory works. The public
ArcSwapRouter also exposes native-USDC entry points:

- `buy(address token, uint256 minOut)` payable in native USDC
- `sell(address token, uint256 amountIn, uint256 minOut)` returning native USDC

## Contact

- Site: https://arcx.fun
- X: https://x.com/steadypads
