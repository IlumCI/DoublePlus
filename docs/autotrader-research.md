# Auto-trader research notes

Gathered 2026-10-08. What the trader is built on, and where each idea came from.
Claims marked *heuristic* are trader folklore or vendor numbers: starting values
to tune, not facts.

## The idea

Catch buy cascades early and leave just before the dump waves.

- **Entry:** a coin is about to cascade when its buys start exciting more buys
  (self-exciting Hawkes flow), new wallets keep arriving, buy sizes are varied
  (people, not one bot), and the coin has a real link on its page.
- **Exit:** sell right before the 1st or 2nd dump wave, not on micro-sells.
  - Wave 1 is the snipers and bundles leaving.
  - Wave 2 is insiders selling into a milestone (graduation, round market cap,
    the attention peak).
  - Jeets selling small at 1.5–2x are noise the curve absorbs.

## Pons, measured from the chain

- **Contracts:** factory `0x7ed598bc…ec7e`, meme hook `0xe5e70264…e044`, one
  curve contract per coin. Events: `TokenLaunched`, `CurveBuy`, `CurveSell`,
  `SnipeTaxCharged`, `CurveCompleted`, `PoolGraduated`, and `PoolRegistered` on
  the hook.
- **The curve, checked exact to 1e-16 on 4,000 trades:** constant product with
  virtual reserves Q0 = 0.4 × threshold (1.68 ETH for the 4.2 ETH threshold)
  and T0 = 1B tokens. At the threshold, 5/7 of supply is sold.
  - A buy adds `quoteIn − fee − tax` to Q.
  - A sell takes `Q·tok/(T+tok)` from Q, and the seller receives that minus fee
    and tax.
- **Costs:** the fee is 1%. Each coin has its own creator tax of 0–3%; the median
  is 1–2%.
- **Pair tokens:** about 84% of launches pair with native ETH. The rest pair with
  USDG or stocks and use their own thresholds.
- **Activity (2026-10-08, the 6 h before 15:00 UTC):**
  - 371 launches, 8.1k curve buys, 6.3k sells and 2 graduations.
  - About a third of coins never see a second buy.
- **Socials:** `socials()` and `description()` on the token. 80% link one X URL,
  sometimes a post rather than a profile. None link Telegram, a website or
  GitHub.
- **Chain:** blocks are about 100 ms and gas costs 0.02 gwei (≈ $0.01 a swap).
  The sequencer is FCFS with no public mempool. The node keeps only recent state,
  so replays are rebuilt from logs.
- **Robinhood Chain has no USDC.** The stablecoin is USDG (Paxos), and its deepest
  pool is WETH/USDG 0.01% on Uniswap V3.

## Hawkes flow (sources in the original brief)

- **The model:** a bivariate buy/sell process, marked by trade size
  (m = (v/v̄)^0.4), with exponential kernels for O(1) recursive updates. α_ij is
  how many type-i trades one type-j trade triggers. The branching ratio n is the
  spectral radius of A.
- **Fitting:** fixed β, then EM for μ and α on a rolling window (Filimonov &
  Sornette 2012, arXiv 1201.3572; Bacry et al., arXiv 1502.04592).
- **The trap:** a regime shift in the baseline (every launch is one) makes even a
  Poisson stream look critical, with n ≈ 1 (arXiv 1308.6756).
  - Trade on the change in n and on cross-sectional rank, not on raw n.
  - Treat n ≥ 0.95 as an artefact or a blow-off top.
- **Signals:**
  - ER = λb/(λb+λs): who is pushing.
  - EB = 1 − μb/λb: the share of buys triggered by other buys.
  - A sell surprise z-score against the compensator.

## The crowd

| Mood | What it looks like in the flow |
|---|---|
| Attention / FOMO (Barber & Odean 2008) | buy gaps shrinking, first-time wallets rising, buy size rising after green |
| Herding | buys bunched seconds after a call; several independent wallets within a minute |
| Jeets (disposition effect) | small sells at 1.5–2x; the dip gets bought |
| Bagholding | price bleeding on low sell volume, holder count flat |
| Panic | sell gaps collapsing and sell size growing trade over trade |
| Round numbers (Bhattacharya et al. 2012) | stalls and selling at $100k / $500k / $1M market cap and at graduation |
| Exit liquidity | insiders sell into the biggest new-buyer cohort: the graduation, trending and call peaks |

**Before wave 1:**
- Snipers and bundles still hold.
- The dev or bundles move tokens to fresh wallets.
- The deployer makes small test sells.

**Before wave 2 (heuristic):**
- The buy count rises while the median buy size shrinks.
- Sells grow and come from old cost bases.
- Price makes a new high on less net buying.
- A milestone is close.

**The dip that gets bought:** many small unrelated sellers, and new buyers keep
coming.

**The dip that doesn't:** a few large or linked sellers, and the arrival of
first-time buyers is falling.

## What breaks backtests

- **Survivorship:** build the universe from launch events and keep the dead coins.
- **Look-ahead:** compute features with the live code on a point-in-time replay.
- **Latency:** fill after a delay, at the state after the trades already in that
  block.
- **Wash bots:** they inflate intensity and unique counts. Collapse same-block,
  same-size bursts, and discount wallets that round-trip.
- **Big accounts:** a paper account doesn't move the real market, so it overstates
  what large balances can do. Cap each fill at a price impact the curve can carry.
