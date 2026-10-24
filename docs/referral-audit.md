# Referral system review (2026-10-24)

Scope: `VentureFeeHook` (binding, pool payouts), `VentureFactory` (curve fees),
`VentureRouter` and its on-behalf callers, the site (link capture, linking,
Portfolio, docs copy). State at review: 0 wallets bound, 0 referral payouts.

## How it works (verified)

- A wallet binds a referrer once with `hook.setReferrer(ref)`: no self-referral,
  no change later. The site captures `?ref=0x…` on landing (first one sticks)
  and shows a "Link up" prompt on the trade and raise panels; binding is one
  small transaction the referred wallet signs.
- Bound wallets pay 10% less of the platform fee and of the curve fees
  (`REFEREE_DISCOUNT_BPS`, a constant).
- The referrer gets 20% (`refShareBps`, immutable) of the discounted fee:
  - **pool:** paid inside the swap by the hook, in the fee currency: the coin on
    buys, WETH (not ETH) on sells. A recipient that can't take the transfer in
    100k gas gets PoolManager ERC-6909 claims instead (`PayoutDeferred`).
  - **curve:** credited in the factory (`FeeAccrued`), withdrawn with
    `withdrawFees()` from Portfolio.
- Per unit of volume a referrer earns 0.135% of pool volume and 0.18% of curve
  volume.

Tested: the pool path on a mainnet fork (`venture.fork.test.ts`, "funds on the
curve…": referrer, pot and treasury split 20/20/60 of the fee, the coin on
buys); the curve path against the live factory on a fork (0.01 ETH buy credited
the referrer exactly 0.000018 ETH); the Portfolio against that fork.

## Findings

1. **Self-referral cuts treasury income by about a third.** Anyone can bind a
   second wallet of their own as referrer. Their pool fee then nets to 0.54%
   (0.675% paid, 0.135% back) instead of 0.75%, and the treasury's share of the
   trade falls from 0.60% to 0.405% (−32.5%); on the curve −32.5% (open) or −28% (target raise). Contract
   constants, so it can't change without a new system. It is the normal cost
   of a two-sided referral; the weekly flywheel's wash cap already nets the
   referral share out.
2. **Attribution on `buyFor`/`sellFor` is caller-supplied.** Anyone can name any
   bound wallet as the trader and take its 10% discount (paying its referrer).
   Worth no more than finding 1. Limit orders, payouts and the autotrader rely
   on this path by design.
3. **Portfolio undercounted earnings** (fixed). "Referral earnings" counted only
   WETH pool payouts: curve shares and coin-paid shares were left out, and coin
   payouts were listed as "Pair currency" with a raw address and ETH
   formatting.
4. **The Portfolio referral link pointed at `/desk?ref=…`** (fixed), landing new
   people on an empty Portfolio. It now points at the home page.
5. **A failed referral log query blanked the holdings table** (fixed): it shared
   a `catch` with the portfolio load.
6. **Copy said every payout lands in the same transaction** (fixed in Portfolio
   and How it works): only pool trades do.
7. **How it works and the sidebar promise a Monday payout** that isn't running
   on mainnet (the open flywheel item in CLAUDE.md). Not changed here.

## Fixed in this pass

- Portfolio: earnings = WETH pool payouts + curve shares on coins the wallet
  didn't create (the treasury is excluded, since all its curve income is
  `FeeAccrued` too); coin payouts listed by ticker with a link; "N linked" from
  `ReferrerBound`; link to the home page; isolated error handling.
- Copy in Portfolio and How it works says where each kind of earning lands.
- **Linking is automatic.** The "Link up" banner is gone. A wallet that arrived
  through a `?ref=` link and has no referrer binds it inside its first trade
  (curve buy or sell, pool buy or sell, limit order): one extra confirmation,
  about 0.000001 ETH of gas, then the trade, which already gets the discount.
  A decline isn't asked again that session, and the trade goes ahead either
  way. It can't be signature-free: `setReferrer` only binds `msg.sender`.
  Tested on a fork: following a link and pressing Buy bound the referrer and
  credited them 0.000018 ETH on a 0.01 ETH buy.
