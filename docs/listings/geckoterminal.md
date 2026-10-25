# GeckoTerminal: DoublePlus as a launchpad on Robinhood Chain

Goal: every DoublePlus coin gets a public GeckoTerminal chart from its first
curve trade, as Pons (`pons-v2`) and others already have. After graduation the
coin's Uniswap v4 pool is indexed under `uniswap-v4-robinhood` with no extra
work.

- Cost: free. The form also offers an Express Listing for USD 15,000, which we
  skip.
- Form: https://about.geckoterminal.com/dex-chain-listing, button "Get Listed"
  (the Google Form
  https://docs.google.com/forms/d/e/1FAIpQLSeOAlwKZKTj6LFJfukUWSYS9XUIwtvITX9W5C5ZgUIC4NgX0Q/viewform).
- Route: **"Launchpad Addition"**. It asks for example transactions and the
  contract addresses, and GeckoTerminal indexes our events itself. The
  "DEX Addition" route with an API adapter is the slow queue (up to 3 months,
  per the form). Our adapter (`gecko/`, https://gecko.doubleplus.fun) stays
  live, and we name it in the remarks in case they would rather use it.

## Form answers

| Field | Answer |
|---|---|
| Email | yours |
| Telegram handle | yours (they use it for follow-ups) |
| What would you like to request? | Launchpad Addition |
| Launchpad name | DoublePlus |
| Launchpad URL | https://doubleplus.fun |
| Launchpad Twitter/X | https://x.com/DoublePlusFund |
| Telegram handle (again) | yours |
| Sample of buy swap | https://robinhoodchain.blockscout.com/tx/0x504480e1e4cd9108348bcf53362fee2b8b2e6a78604a87594bee7344bdac1224 |
| Sample of sell swap | none on mainnet yet (see below) |
| Sample pool/bonding curve initialization event | https://robinhoodchain.blockscout.com/tx/0x6bc3f31d99ae892947b317645800cd2dbd262d2e95d2612853c9298ee27d678d (`Launched`, $DOUBLEPLUS) |
| Sample graduation event | none on mainnet yet (see below) |
| Can quote token be changed? | No |
| How are fees charged | see the block below |
| Building on Uniswap V4 via hooks? | Yes |
| Program IDL | N/A |
| Program / Contract address | see the block below |
| Following GeckoTerminal on X? | follow @GeckoTerminal first, then Yes |
| Do-follow linkback to GeckoTerminal? | Yes, if you're willing to add a link on the site |
| Dedicated referral link | leave empty |

### Sell and graduation samples

No coin has sold or graduated on mainnet yet: $DOUBLEPLUS has 10 buys and no
sells. Choose one:

- **A real sell sample:** sell a small amount of $DOUBLEPLUS from the coin
  page. It costs keeper-sized gas (about 0.000004 ETH) plus the 1% fee on what
  you sell. Then paste that transaction's link.
- **Or no sample:** paste the line below in both fields.

```
None on mainnet yet: no DoublePlus coin has sold or graduated. Event in the verified source: https://repo.sourcify.dev/4663/0x60e0DD86327F1dA36565c79aAe9f87070415963b (CurveSell / Graduated, VentureFactory)
```

### How are fees charged

```
1% on every curve buy and 1% on every curve sell, taken in ETH: on a buy the fee is deducted from the ETH sent before tokens are priced (emitted as FeeAccrued just before CurveBuy in the same transaction); on a sell it is deducted from the ETH paid out (the feeWei field of CurveSell). Traders with a referrer pay 10% less. After graduation the Uniswap v4 hook charges 0.75% per swap plus the coin's creator tax (0-4%).
```

### Program / Contract address

```
Factory and bonding curve (all coins, ETH quote only): 0x60e0DD86327F1dA36565c79aAe9f87070415963b, start block 94774769
Router: 0x4C9C61F8EA81a66C43c6D24D11B61c5dA334220e
Uniswap v4 hook (graduated pools): 0x99a402348944ADC92A77471d63Bf93370A652044
Events: Launched(token, creator, pair, taxBps, targetRaiseWei, deadline, vesting); CurveBuy(token, buyer, ethIn, tokensOut, priceWei); CurveSell(token, seller, ethOut, tokensIn, priceWei, feeWei); Graduated(token, poolId, raisedWei, founderCutWei, pairSeeded)
```

### Additional remark

```
DoublePlus is a launchpad on Robinhood Chain. Every coin (1B supply) opens on a linear bonding curve against ETH inside the factory and graduates into a Uniswap v4 pool with locked liquidity in the same transaction that fills the curve. All contracts are verified on Sourcify.

We also run an adapter that follows GeckoTerminal's Integration API Standards v0.1, if that is easier for you: https://gecko.doubleplus.fun (/latest-block, /asset, /pair, /events; up to 10,000 blocks per /events call; dexKey "doubleplus"; pair id = coin address; curve fee reported as feesIn/feesOut; an exit empties the curve pair at graduation).
```

## How the adapter was tested (2026-10-25)

- Live mainnet, via `wrangler dev` and then the deployed Worker: replayed
  every factory event since the start block in 10k-block calls. The 10
  $DOUBLEPLUS trades came back with unique (block, txnIndex, eventIndex),
  exactly one asset in and one out each, and a positive price. The final price
  matched `curveState` exactly; the ETH reserve matched to within 7 wei, which
  is the factory's 1-wei round-up per buy.
- Mainnet fork: launched a coin, bought 0.3 ETH, sold 10M, then bought 2 ETH to
  graduate. The fees came out as 1% each way, the graduating buy counted only
  the ETH the curve took, the curve closed at exactly 1.8 ETH with 0 coins left,
  and the exit emptied the pair.

Not covered: refunds after a missed target raise aren't emitted (they don't
change the curve price; such coins never graduate).
