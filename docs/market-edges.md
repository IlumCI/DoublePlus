# Legal structural edges in the trenches

Gathered 2026-10-08. Two sources:

- **Measured:** our own measurements from Pons tapes (`autotrader/src/edges.mjs`).
- **Research:** a sourced research brief.

Labels: **E** = published evidence, **R** = industry-reported figures, **H** = our reasoning.

## What our data says (Pons, 6 h, 313 ETH-paired launches)

**The average buyer loses.** These are all curve buys, sold back after a hold:

| Bought at age | 30 s hold | 5 min hold | 30 min hold |
|---|---|---|---|
| 0–10 s | +1.6% | +2.4% | −9.2% |
| 10–60 s | **+4.4%** (53% up) | −10.4% | −16.8% |
| 1–5 min | −5.4% | −2.7% | −16.5% |
| 5–30 min | −4.3% | −16.7% | −28.8% |
| 30 min+ | −6.3% | −11.1% | −22.9% |

- **Overall:** holding 30 minutes, the mean buyer is −21% and the median −25%. 4% doubled; the top 1% made +222%. It is a lottery.
- **The only positive seat** is the first minute, flipped within 30 s: the sniper and jeet seat, won on latency.

**The creator side is the house.**
- 313 launches cost ~0.16 ETH and collected ~4.8 ETH in tax.
- About half covered their launch cost.
- The top 5 took 54% of all creator tax.
- Caveat: this assumes Pons' event `tax` goes to the creator.

**Random entries vs the strategy** (200 random runs each, same book and exits):

| Entries | Median account | Per trade | Win rate |
|---|---|---|---|
| Pure chance (any coin, any time) | −14.4% | −5.2% | 18% |
| Chance among coins passing the cost/creator filters | −2.0% | −1.6% | 29% |
| The strategy (in-sample tape) | +25% | +13.3% | — |

- Random timing loses about the cost of trading.
- The filters remove most of that loss.
- The strategy beat 99.5–100% of random runs, but on the tape it was tuned on. Only out-of-sample results count.

## Randomness

- Each fair flip stays 50/50; nothing is ever "due" (the gambler's fallacy).
- Over many flips, the *share* of heads converges to 50%, while the *gap* between heads and tails grows like √n.
- True randomness exists: hardware RNGs use thermal, quantum and decay noise.
- Randomness cannot turn negative EV positive. The Kelly fraction of a negative-EV bet is zero. (E: Kelly 1956; random-portfolio results come from small-cap and value tilts, not randomness — Clare et al., Arnott et al. 2013.)
- Where randomness does pay: as a mixed strategy against adversaries. Jittered timing and size hide a real edge from copy-traders and front-runners. It protects an edge; it doesn't create one.

## Ranked edges for DoublePlus

| # | Edge | Why it lasts | Needs | Status |
|---|---|---|---|---|
| 1 | **The house fee:** curve fee, pool platform fee, limit-order and payout tips | Revenue doesn't depend on any coin surviving (pump.fun: ~$775M lifetime; Axiom: $100M in 4 months) [R] | Flow | live in contracts |
| 2 | **Owning and routing retail flow:** charge arbitrage more than retail (hook surge fee), best-execution routing with a disclosed fee | Retail flow is uninformed; LPs earn on noise and lose to arbitrage (FLAIR, arXiv 2306.09421) [E] | Hook work | surge fee done; routing open |
| 3 | **Attention products:** featured slots, boosts, paid creator extras | DexScreener earned ~$5.4M/mo on profiles and boosts [R] | UI | open |
| 4 | **LP on stock-token and major pairs**, with fees that widen while markets are closed | 100 ms blocks and low gas cut LVR (arXiv 2305.14604) [E]; stock tokens have low volatility | $25–250k inventory, a fee hook | open |
| 5 | **Weekend stock-token premium:** sell inventory into premiums that close at Monday's first mint | Supply only changes on weekdays; HIMS ran to ~2× and collapsed within 12 min of the Monday mint [R] | Inventory, monitoring, small size | open (measure first) |
| 6 | **Referral annuity:** about 0.3% of downstream volume via KOL partners, disclosed | Distribution compounds [R] | Partners | referral system live |
| 7 | **A few high-intent house coins:** modest tax, disclosed ask-ladder for the creator bag | Legally short lottery skew; fees concentrate in coins with attention [E/H] | Content, community | DoublePlus token |
| 8 | **Graduation and keeper rewards:** being first to complete permissionless steps | Small and latency-bound [H] | Keeper | partly (our keeper) |

**Deprioritise:**
- CEX-DEX arbitrage on majors: professionals win it (arXiv 2401.01622).
- JIT liquidity: there's no mempool on this chain.
- Random or discretionary memecoin trading: negative EV after costs.
- Points farming at scale.

## Bright lines

- Any creator snipe-tax whitelist is shown on the market screen.
- No hidden deployer-funded wallets.
  - Pine documented 15k+ tokens sniped by the deployer's own funded wallets — the textbook insider dump.
- Rebates never exceed fees in a way one person can farm.
  - The flywheel's wash cap already enforces this.
- A memecoin's market cap is never quoted off a squeezed stock-token price without showing NAV.
- SEC staff (Feb 2025) said typical meme coins aren't securities, but fraud law still applies.

## Open measurements (all doable from our own chain data)

- Stock-token pool price vs Chainlink on weekends and after hours.
- Post-graduation returns on Pons.
- Net LP returns in memecoin pools.
- Whether Pons' `tax` field is paid to the creator.
