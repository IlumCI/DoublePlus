# GeckoTerminal: DoublePlus as a launchpad DEX on Robinhood Chain

Goal: every DoublePlus coin gets a public GeckoTerminal chart from its first
curve trade, as Pons (`pons-v2`), Frontier and others already have. After
graduation the coin's Uniswap v4 pool is indexed under `uniswap-v4-robinhood`
with no extra work.

- Cost: free ("Listing on GeckoTerminal is FREE", CoinGecko support).
- Route: our curve isn't a supported fork, so it uses the API-adapter method
  (GeckoTerminal Integration API Standards v0.1). Review takes 5–10 working days.
- Form: https://about.geckoterminal.com/dex-chain-listing (or the request
  button at the bottom right of geckoterminal.com). Pick the "Non-EVM Network /
  Dex Addition" option. That is the adapter route, even for EVM DEXes that
  aren't forks.

## Before submitting

Deploy the adapter (Worker `doubleplus-gecko`, source in `gecko/`):

```
cd /home/lummy/Projects/DoublePlus/gecko && npm install && ../api/node_modules/.bin/wrangler deploy
```

Then check it answers: https://gecko.doubleplus.fun/latest-block

## Form answers

| Field | Answer |
|---|---|
| Request type | Non-EVM Network / Dex Addition (API adapter) |
| Network | Robinhood Chain (GeckoTerminal network id `robinhood`, chain id 4663) |
| DEX name | DoublePlus |
| DEX type | Launchpad (linear bonding curve that graduates to a locked Uniswap v4 pool) |
| Website | https://doubleplus.fun |
| X | https://x.com/DoublePlusFund |
| Logo | https://doubleplus.fun/doubleplus-logo.png (1200×1200), https://doubleplus.fun/doubleplus-avatar.png (400×400) |
| Adapter base URL | https://gecko.doubleplus.fun |
| Endpoints | `/latest-block`, `/asset?id=`, `/pair?id=`, `/events?fromBlock=&toBlock=` |
| Factory contract | `0x60e0DD86327F1dA36565c79aAe9f87070415963b` (verified on Sourcify) |
| Uniswap v4 hook (graduated pools) | `0x99a402348944ADC92A77471d63Bf93370A652044` |
| Start block | 94774769 |
| Example coin | $DOUBLEPLUS `0xc44cFd968A38C6B16A8Be4677bbB87d0eBB42add`, https://doubleplus.fun/venture/0xc44cFd968A38C6B16A8Be4677bbB87d0eBB42add |

Notes to paste in the description:

```
DoublePlus is a launchpad on Robinhood Chain. Every coin (1B supply) opens on a linear bonding curve against ETH inside our factory contract, and graduates into a Uniswap v4 pool with locked liquidity in the same transaction that fills the curve.

Adapter: https://gecko.doubleplus.fun (GeckoTerminal Integration API Standards v0.1).
- One pair per coin: pair id = the coin's address, dexKey "doubleplus", assets are the coin and WETH (0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73), ordered alphabetically by address.
- Swaps come from the factory's CurveBuy and CurveSell events. The 1% curve fee is reported as feesIn on buys and feesOut on sells; amounts and reserves are decimalized and exact.
- Reserves are the ETH held by the curve and the coins left on it, rebuilt from each event with the curve's immutable price parameters.
- At graduation the adapter emits an exit that empties the curve pair; trading continues in the coin's Uniswap v4 pool (hook 0x99a402348944ADC92A77471d63Bf93370A652044), which you index as Uniswap V4 (Robinhood).
- /events accepts up to 100,000 blocks per request. Start block 94774769.
```

## How the adapter was tested (2026-10-25)

- Live mainnet, via `wrangler dev`: replayed every factory event since the start
  block (29 calls of 100k blocks). The 10 $DOUBLEPLUS trades came back with
  unique (block, txnIndex, eventIndex), exactly one asset in and one out each,
  and a positive price. The final price matched `curveState` exactly; the ETH
  reserve matched to within 7 wei, which is the factory's 1-wei round-up per buy.
- Mainnet fork: launched a coin, bought 0.3 ETH, sold 10M, then bought 2 ETH to
  graduate. The fees came out as 1% each way, the graduating buy counted only
  the ETH the curve took, the curve closed at exactly 1.8 ETH with 0 coins left,
  and the exit emptied the pair.

Not covered: refunds after a missed target raise aren't emitted (they don't
change the curve price; such coins never graduate).
