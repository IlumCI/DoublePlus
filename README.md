# Safehood: Token Launchpad for Robinhood Chain

A production-grade token launchpad that launches tokens **directly into Uniswap V3**. No bonding curve, no simulation: one transaction deploys a real ERC-20, creates and initializes a real Uniswap V3 pool, seeds it single-sided with the full supply (launching is free, no upfront liquidity), and opens trading immediately. Anti-whale limits protect the market until the token reaches a 40,000 USD market cap, then lift automatically on-chain.

## Live deployment (Robinhood Chain mainnet, chain id 4663)

| Contract | Address |
| --- | --- |
| Launchpad | [`0xe893ca05D3F1235de22630504DcEa9e029294900`](https://robinhoodchain.blockscout.com/address/0xe893ca05D3F1235de22630504DcEa9e029294900) |
| TokenFactory | [`0x5Cf777e19a6CD4B10c3Aa317a2B8E8bCC5F46364`](https://robinhoodchain.blockscout.com/address/0x5Cf777e19a6CD4B10c3Aa317a2B8E8bCC5F46364) |
| FeeDistributor | [`0x8E0b175a36ee0854Cc2dC7AeC4B3f90857A059ca`](https://robinhoodchain.blockscout.com/address/0x8E0b175a36ee0854Cc2dC7AeC4B3f90857A059ca) |
| Treasury | [`0xD401Ed3C128eaE756323e7EAE27B40407c7d499B`](https://robinhoodchain.blockscout.com/address/0xD401Ed3C128eaE756323e7EAE27B40407c7d499B) |

| Meridian One (MRD1) | [`0x5e64880D20d6b827096611C3C06D9BA38e2C2DAD`](https://robinhoodchain.blockscout.com/address/0x5e64880D20d6b827096611C3C06D9BA38e2C2DAD) |
| MRD1 / WETH pool (1% tier) | `0x8795eeB0cc2203d01140F9340B9402b69b4eE077` |

Pools are created on the chain's canonical Uniswap V3 at the 1% fee tier (factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`, position manager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`) and pair against the canonical bridged WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, so every launch is visible to DexScreener, snipers and any tooling watching the standard event stream.

All protocol contracts are source-verified on Blockscout. The Uniswap V3 stack was deployed from the canonical build artifacts because no adopted canonical deployment existed on the chain. Every admin role is held by the platform admin wallet; the deployer retains zero privileges. Web app: https://safehood.fun (the indexer backend still needs hosting for feed/chart data; launching and trading work directly against the chain).

## How a launch works

1. The creator fills in name, symbol, description, logo, website, X, Telegram and optional links, plus an optional first buy. Everything else is a fixed protocol rule and launching costs only gas.
2. `Launchpad.createToken` (single transaction, fixed protocol rules: 1B supply, 0.3% pool tier, 1% trading fee, 2% max transaction and 2% max wallet until the 40,000 USD market cap, 2,000 USD starting market cap):
   - deploys the ERC-20 through the `TokenFactory` (full supply, 18 decimals)
   - creates and initializes the Uniswap V3 pool at the fixed 2,000 USD starting market cap
   - mints a single-sided position holding the full supply just above the starting price; the position NFT is held by the launchpad (protocol-managed liquidity), and buyers' native currency fills the pool as price moves into the range
   - enables trading immediately, with anti-whale limits active
3. Trading runs through `buy`/`sell` on the launchpad (fixed 1% fee, pushed 100% to the creator on every trade) or directly against the pool (limits still enforced by the token itself).
4. The moment any trade pushes the market cap over the graduation threshold, the token contract permanently removes the max transaction limit, max wallet limit and buy cooldown. No admin involvement, no keeper: the check runs inside the token's own transfer path.

## Repository layout

| Package | What it is |
| --- | --- |
| `contracts/` | Solidity 0.8.26 + Hardhat. `Launchpad`, `LaunchToken`, `TokenFactory`, `FeeDistributor`, `Treasury`, Uniswap V3 interfaces, 24 integration tests that run against the real Uniswap V3 factory/router/position manager bytecode, deploy + Blockscout verify scripts |
| `backend/` | Blockchain indexer (viem), SQLite storage, OHLC candle aggregation (1m/5m/15m/1h/4h/1d), Express REST API, WebSocket streaming (`candle:update`, `trade:update`, `price:update`, `token:launched`) |
| `sdk/` | TypeScript SDK: `createToken`, `buyToken`, `sellToken`, all read functions, WebSocket subscriptions, React hooks (`@launchpad/sdk/react`) |
| `web/` | React + TypeScript + Tailwind + TradingView Lightweight Charts + TanStack Query + Zustand + wagmi. Explore feed, live trading page with real OHLC candles, single-step launch flow, hidden role-gated admin console |

## Contracts

- **`LaunchToken`**: fixed-supply ERC-20. While `limitsActive`, every transfer enforces `maxTxAmount`, `maxWalletAmount` and the optional per-wallet buy cooldown (infrastructure addresses are exempt). Each transfer also checks the live pool market cap through the launchpad and flips limits off permanently once the graduation cap is crossed. `checkGraduation()` is public so anyone can trigger the check too.
- **`Launchpad`**: factory + trading router + liquidity manager.
  - Trading: `buy(token, minOut, deadline)` payable and `sell(token, amountIn, minOut, deadline)`; the fixed 1% fee is delivered in native currency to the creator through the `FeeDistributor`.
  - Market data views: `marketCapWeth`, `marketCapUsd`, `tradingLimits`, `poolInfo`, `nativeUsdPrice` (Chainlink-compatible feed with manual fallback).
  - Protocol-owned liquidity (role `LIQUIDITY_MANAGER_ROLE`): `collectFees(token)` collects accrued pool fees; `collectFees(token, liquidityBps)` additionally settles up to 100% of the position principal, at any time; `addLiquidity(token, tokenAmount)` payable deepens the position. All proceeds go to the `Treasury`; every action emits `FeesCollected` or `LiquidityAdded`.
  - Admin (role-gated): pause/resume launches, feature tokens, set price feed.
- **`FeeDistributor`**: pushes 100% of every trading fee to the token creator automatically, with a pull-payment fallback (`withdraw`) for contract wallets that reject transfers; lifetime accounting per creator and per token.
- **`Treasury`**: role-gated custody for withdrawn liquidity, LP fees and platform revenue.

Security: OpenZeppelin AccessControl + ReentrancyGuard, custom errors, checks-effects-interactions, no upgradeable proxies, no owner mint. **Disclosure shown in the UI: liquidity is protocol-managed, not locked or burned.** The graduation check reads the live pool spot price, which is manipulable within a block; it only gates anti-whale limits, never funds.

### Build and test

```bash
npm install
npm run compile          # hardhat compile
npm test                 # 24 integration tests against real Uniswap V3 bytecode
```

### Wallet architecture

The protocol owns its infrastructure; no individual wallet can hold it hostage. Four concerns, each rotatable independently:

| Concern | Holder | Rotation |
| --- | --- | --- |
| Deployments | Dedicated platform deployer wallet (`scripts/generate-deployer.ts`, key in gitignored `.env.deployer`) | Generate a new one any time; it has zero on-chain privileges after deployment |
| Protocol admin | `PLATFORM_ADMIN` (team multisig) holds DEFAULT_ADMIN, liquidity manager, operator and treasurer roles | `scripts/transfer-admin.ts` grants to a new holder and revokes the old, grant-before-revoke |
| Protocol assets | `Treasury` contract (LP withdrawals, collected pool fees) | Treasurer role moves with the admin rotation |
| Trading fees | Pushed 100% to token creators by `FeeDistributor` | Never touch the deployer or the admin |

The deploy script deploys with the deployer as a temporary admin purely for wiring, then grants every role to `PLATFORM_ADMIN` and renounces the deployer's roles, verifying each step on-chain. If the deployer key leaks or is lost afterwards, nothing about the running protocol is affected.

### Deploy to Robinhood Chain

Robinhood Chain is an Arbitrum Orbit chain; set the official RPC endpoint and chain id for the environment you target, plus the canonical Uniswap V3 deployment addresses on that chain:

```bash
cd contracts
npx hardhat run scripts/generate-deployer.ts   # one-time: platform deployer wallet
cp .env.example .env     # fill in RPC, chain id, Uniswap V3 addresses, PLATFORM_ADMIN
# fund the deployer address printed above, then:
npx hardhat run scripts/deploy.ts --network robinhood
```

The script deploys TokenFactory, Treasury, FeeDistributor and Launchpad, wires them together, hands all roles to `PLATFORM_ADMIN`, strips the deployer, and writes `deployments/robinhood.json`.

### Verify on Blockscout

`hardhat.config.ts` registers the chain's Blockscout instance as a custom explorer (`BLOCKSCOUT_URL` in `.env`). After deploying:

```bash
npx hardhat run scripts/verify.ts --network robinhood
```

This verifies all four protocol contracts with their constructor arguments. LaunchToken instances share bytecode, so verifying one verifies the code for all of them on Blockscout; the script prints the exact command.

## Backend

```bash
cd backend
cp .env.example .env     # RPC, contract addresses, start block
npm run build && npm start
```

- REST: `GET /api/tokens`, `/api/tokens/:address`, `/api/candles?token=&interval=1m`, `/api/trades?token=`, `/api/holders?token=`, `/api/stats`, `/api/creators/:address`, `/api/creators/:address/revenue`, `/api/lp-events`
- WebSocket `/ws`: subscribe with `{"op":"subscribe","channel":"candle:update","token":"0x...","interval":"1m"}`; channels are `candle:update`, `trade:update`, `price:update`, `token:launched`
- Candles are aggregated from real on-chain trades at index time; the API only serves preaggregated data, and the active candle streams incrementally so charts update without refetching.

## Web app

```bash
cd web
cp .env.example .env.local   # chain, contract addresses, API/WS URLs
npm run dev                  # or: npm run build && npm run preview
```

Wallets: MetaMask and any injected EIP-1193 wallet out of the box; WalletConnect activates when `VITE_WALLETCONNECT_PROJECT_ID` is set. All transactions are signed by the user's wallet; the app never handles private keys and displays nothing that is not backed by chain or indexer state.

## Full local stack (end to end)

```bash
npm install
# 1. chain
cd contracts && npx hardhat node
# 2. deploy Uniswap V3 + launchpad + demo token with trades
cd contracts && npx hardhat run scripts/localnet.ts --network localhost
# 3. backend
cd backend && cp .env.example .env  # point at localnet (see deployments/localnet.json)
npm run build && npm start
# 4. web
cd web && npm run gen:env && npm run dev
```

## SDK

See `sdk/README.md` for the full API. Quick taste:

```ts
const client = new LaunchpadClient({ chain, addresses, apiUrl, wsUrl });
client.connectWallet(walletClient);
await client.createToken({ name, symbol, initialLiquidityWei: parseEther("1") });
await client.buyToken(token, parseEther("0.1"));
client.subscribeToCandles(token, "1m", ({ candle }) => chartSeries.update(candle));
```

## Known operational notes

- The USD graduation threshold needs a native/USD price source: point `setPriceFeed` at a Chainlink-compatible aggregator when one exists on Robinhood Chain, otherwise keep the operator-updated fallback price fresh.
- The 24h volume/holder counters come from the indexer; the source of truth for balances, fees and liquidity is always the chain.
- This codebase has not been audited. Test on the Robinhood Chain testnet before deploying with real value.
