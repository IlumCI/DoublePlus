# What has kept working on-chain since 2022, and what we tested

Gathered 2026-10-08. Two inputs: a sourced research brief, and what we tested on our own Pons tapes. The tapes are 6 h of replay plus two live hours. Labels: **E** is evidence, **H** is heuristic.

## The literature in one paragraph

Memecoin markets are player-versus-player with a house cut: about 62% of pump.fun wallets lost money, 1% made more than $10k, and the platforms took the revenue [E]. The reliable patterns by horizon:

- **Seconds:** order flow continues. This is the Hawkes leg the strategy reads.
- **Minutes to weeks on small coins:** prices reverse. Coins that just spiked give it back (MAX/lottery effect, Grobys & Junttila; Zaremba; Fičura) [E].
- **Majors at 1–4 week horizons:** momentum works, but it is crash-prone and weak since 2022 (Liu & Tsyvinski) [E].

Copying "smart money" yields about 3% per trade at best after frictions, because of latency and bait wallets (arXiv 2601.08641) [E]. Block-zero sniping is a latency monopoly [E]. LP on memecoins loses to arbitrage and drift (arXiv 2404.05803) [E]. Shannon's-demon rebalancing and memecoin stat-arb are dead after a ~6% round trip.

## What we tested

| Idea | Source | Result on our tapes |
|---|---|---|
| Cost-aware Hawkes entry + dump-wave exits (current) | ours | +4.4% mean per 3-h window for a 0.1 ETH account; 13 trades total |
| First-minute flip (buy at 10–60 s, sell 15–60 s later) | our raw data showed +4.4% for the real buyers | **−6% to −9%**: at 0.4–1.2 s latency we arrive after the in-block buyers; the edge is latency rent |
| Resting ask ladder 1.3/1.7/2.5× | selling into FOMO, short lottery premium | neutral (wave-top exit already sells strength) |
| Tight ladder 1.12/1.25× | research brief | neutral to slightly worse |
| Only coins with 0–1% tax (round trip ≤ 4%) | research brief | too few trades left to judge |
| No entries after 3× from launch | reversal/MAX literature | no change here; kept on (harmless, evidence-backed) |

## What it takes to know

- A 2% mean edge with 40% per-trade dispersion needs about **1,600 trades** for t ≈ 2.
- We have 13. Every number above is inside the noise.
- Getting there needs days to weeks of tape and live paper, judged by bootstrap confidence intervals and by tax bucket.

## The core asymmetry, applied to the auto-trader

The strategy's edge is unproven. The product's edge isn't:

1. **Charge for it.** Every bot that made money made it on fees: Axiom earned $100M in 4 months on ~1% per trade [R]. The auto-trader charges a disclosed fee on its users' trades or profits, and DoublePlus holders share it. That fee doesn't depend on any one trade winning.
2. **Trade on our own launchpad first.** On DoublePlus coins, the platform-fee share of the bot's own trading comes back to the treasury, lowering its effective round trip.
   - This must be disclosed: it is the house trading on public information only.
3. **Sell into FOMO, never chase it.** Use ladders and wave-top exits; the no-chase rule stays on.
4. **Keep its moves unpredictable.** Jitter timing and size so copy bots can't front-run its exits.
   - Randomness protects an edge; it does not create one.
