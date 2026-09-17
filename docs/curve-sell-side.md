# Curve sell side + curve fees — next contract round

Status: spec, not implemented. Targets `VentureFactory.sol`, with one new
launch parameter and two new entry points. No change to the curve math: the
existing `curveCost` integral is already symmetric, so the sell side reuses it.

## Why

Three separate complaints resolve to one missing mechanism:

1. **No exit during the raise.** Between `buy()` and the deadline a backer
   cannot leave at any price. The refund is a patch over that hole.
2. **"Refunds aren't free-market."** Correct, but only because there is no
   market to be free. A reversible curve is the market.
3. **Zero revenue on non-graduating listings.** The pre-graduation phase is
   where ~98% of activity lives and the protocol currently charges nothing on
   it. pump.fun takes ~1% on every curve trade in both directions and earned
   $800M+ across 11.9M launches at a sub-2% graduation rate; graduation is
   incidental to that business.

## Two raise modes, chosen at launch

`LaunchParams` gains `RaiseMode mode`.

### Mode A — `Guaranteed` (what exists today, plus an exit)

All-or-nothing, target, deadline, full refund on failure. The wedge: this is
the mode that supports "100% refunded" and the startup/research positioning.

- Curve buys: **0.5% entry fee** to `platformTreasury`, charged on the way in
  and not refundable.
- Curve sells: allowed at any time, **proceeds capped at the seller's
  pro-rata cost basis**, protocol fee charged on the proceeds.
- Refund on failure: full cost basis of the tokens still held — that is, every
  wei that actually entered the curve. The entry fee is already spent.

The cap is not a UX preference, it is a solvency requirement — see below.
Consequence worth stating plainly: during a Guaranteed raise the curve is an
**exit, not a profit venue**. You can always get out; you cannot extract more
than you put in until the token actually graduates into the pool.

### Mode B — `Open` (pump.fun shape)

No target, no deadline, no refund, no all-or-nothing. Graduates when
`raisedWei >= graduationRaiseWei` — see the threshold analysis below.

- Curve buys **and** sells both charged (same 0.5% entry fee, or higher — the
  cap is 3%).
- Sell proceeds **uncapped** — real speculation, real profit and loss.
- No founder cut of a raise; the creator earns a share of curve fees instead.

Escrow solvency is trivial here: there is no refund liability, and buys pay
`curveCost + 1` while sells receive at most `curveCost`, so the escrow is
monotonically non-negative by construction.

## Graduation threshold: pick the lowest viable one

The threshold is a revenue decision, and it resolves against one asymmetry:

**The curve is a bounded-revenue venue. The pool is not.**

Curve buy volume is capped by construction — the curve can absorb at most
`curveCost(0 -> CURVE_SUPPLY_WHOLE)` before it is exhausted, so lifetime curve
buy revenue is bounded at roughly `0.5% x target`, times whatever churn the
sell side adds. Pool volume has no such ceiling: a pool can trade many
multiples of its own liquidity, indefinitely, and every one of those trades
pays the full 1% platform fee.

The per-trade rate points the same way. A curve round trip pays 0.5% in and
1% out. A pool round trip pays 1% and 1%. The pool is the higher-rate venue
*and* the uncapped one.

So the profit-maximising threshold is **the lowest one that still produces a
pool deep enough to trade.** Every block a token spends on the curve is volume
earning 0.5% in a venue that will run out, instead of 1% in one that will not.

### Floor on the threshold

Two things stop it going to zero:

1. **Minimum viable depth.** A pool holding 0.2 ETH moves double digits on a
   0.05 ETH click. No one trades it, so it earns nothing — graduating a token
   into a pool too thin to use destroys the revenue the move was meant to
   capture. Depth must comfortably absorb the quick-amount buttons the UI
   offers (0.05 / 0.1 / 0.5 / 1 ETH).
2. **Graduation gas.** `finalize()` seeds a Uniswap V4 pool, and a keeper pays
   for it. Lifetime pool revenue must exceed that cost. On Robinhood Chain
   (an Orbit L3) gas is cheap enough that depth dominates this bound, but it
   is not zero and it scales with listing count.

### Denominate it in ETH, not supply or FDV

- `soldWhole >= CURVE_SUPPLY_WHOLE` — rejected. The ETH raised at full curve
  depends on each token's `p0` and slope, so identical thresholds produce
  wildly different pool depths. Some tokens would graduate into dust.
- FDV threshold — rejected. It makes a critical state transition depend on the
  ETH/USD oracle. A stale or manipulated price then gates graduation, which
  adds an attack surface to the one function that moves everyone's money.
- `raisedWei >= graduationRaiseWei` — **take this.** It is denominated in the
  exact quantity that becomes liquidity, so pool depth is predictable and
  identical across every listing.

### Make it tunable, not immutable

The optimum is empirical: it depends on the trade-size distribution and the
churn rate, neither of which is known before launch. Baking a guess in as
`immutable` is the anti-profit choice — it forecloses ever moving to the
actual optimum.

`graduationRaiseWei` should be an admin-settable factory parameter with a hard
bounded range, applied to new launches only so a live raise never has its
finish line moved. Start it low, instrument graduated-pool revenue against
time-on-curve, and tune. The ability to re-tune is worth more than any number
chosen up front.

Instrument these from day one, or the tuning is guesswork:
per-token curve fee accrued, pool fee accrued, time on curve, pool volume in
the first 24h post-graduation, and the share of listings that never graduate.

## Buy fee mechanics

The fee is taken off the incoming value *first*; the remainder buys on the
curve. This keeps `raisedWei` equal to ETH actually escrowed and leaves the
existing rounding and excess-return logic untouched.

```
fee      = msg.value * curveBuyFeeBps / BPS
netValue = msg.value - fee
q        = tokensForValue(token, netValue)
spend    = curveCost(token, q, c.soldWhole) + 1
if (spend > netValue) spend = netValue

spentWei[t][u] += spend          // net of fee: what is really in escrow
c.raisedWei    += spend
pay fee to platformTreasury, less the referrer share
return netValue - spend to the buyer, as buy() already does
```

`spentWei` therefore records **net** contribution, not gross spend. That is
what keeps `sum(spentWei) == raisedWei` true and the escrow solvent: had it
recorded gross, refund liability would exceed escrow by exactly the fee take
and the last backers to claim would find the contract short.

Effect on a backer of a failed raise: they get back everything that entered
the curve and lose the 0.5% entry fee. On a 1 ETH buy that is 0.005 ETH.

## The solvency constraint (why Mode A caps sells)

Let, for one token:

- `B` = sum of all buy spends
- `S` = sum of all gross sell proceeds (fee is taken out of `S`, so `S` is the
  total leaving escrow)
- `C` = cost basis attributable to the tokens that were sold

Escrow held `E = B - S`. Refund liability `L = B - C`.

```
E >= L   <=>   B - S >= B - C   <=>   C >= S
```

**Refunds stay fully funded if and only if gross sell proceeds never exceed
the cost basis of the tokens sold.** Without the cap, an early buyer can let
later buyers push the curve up, sell into their ETH at a profit, and leave the
escrow short of what the remaining backers are owed — a rug executed through
the refund mechanism rather than against it. The cap makes the guarantee
arithmetic rather than aspirational.

Surplus behaviour: when the curve would pay more than cost basis, the excess
stays in escrow and becomes pool liquidity at graduation. Early sellers
forfeit their gain to the remaining holders.

## New entry points

```solidity
enum RaiseMode { Guaranteed, Open }

/// Sell `qWhole` tokens back to the curve. `minEthOut` is enforced.
function sell(address token, uint256 qWhole, uint256 minEthOut)
    external nonReentrant returns (uint256 ethOut);

/// Sweep escrow left unclaimed long after an aborted raise.
function sweepUnclaimed(address token) external returns (uint256 amount);
```

### `sell` — order of operations

```
require mode-appropriate state (curve live, not finalized, not aborted)
q          = min(qWhole, boughtTokens[t][msg.sender] / 1e18)   // curve claim only
require q > 0
costBasisQ = spentWei[t][u] * q * 1e18 / boughtTokens[t][u]    // pro-rata
gross      = curveCost(t, q, c.soldWhole - q)                  // same integral
if (mode == Guaranteed) gross = min(gross, costBasisQ)
fee        = gross * curveSellFeeBps / BPS
ethOut     = gross - fee
require ethOut >= minEthOut

spentWei[t][u]     -= costBasisQ
boughtTokens[t][u] -= q * 1e18
c.soldWhole        -= q
c.raisedWei        -= gross          // raisedWei stays == ETH actually escrowed

pull q*1e18 tokens from the seller, return them to factory inventory
pay fee to platformTreasury (less the referrer share, as the hook does)
pay ethOut to the seller
```

Two invariants to assert in tests:

- `sum(spentWei[t][*]) == c.raisedWei` still holds after any sequence of
  buys and sells.
- `address(this).balance >= sum over live tokens of raisedWei`.

### Curve claims are not transferable

`sell()` and `refund()` both key off `boughtTokens[t][msg.sender]`, so tokens
acquired by plain ERC-20 transfer carry no curve claim. This is already true
of `refund()` today and is the cause of the stranded-ETH case: move your
tokens, lose your claim, and the ETH sits in the factory forever.

`sweepUnclaimed(token)` is the remedy: after an abort plus a long window, the
residue goes to `platformTreasury`. Set the window at **365 days** and surface
an open claim UI the whole time — see the caveat section.

## Target measurement with a non-monotonic `raisedWei`

Sells make `raisedWei` fall, which breaks three existing guards. Fix with a
**high-water lock**: the first time `raisedWei >= targetRaiseWei`, the curve
closes to *both* buys and sells and `finalize()` becomes permissionless.

- `buy()` — already reverts `CurveClosed` at target. Unchanged.
- `sell()` — must revert `CurveClosed` under the same condition, otherwise a
  seller can pull the raise back under target after it crossed and make an
  already-funded raise abortable.
- `abort()` — unchanged; it cannot fire because the state froze at crossing.

This removes the race entirely rather than mitigating it. The alternative,
evaluating the target only at the deadline, invites a griefing sell of one wei
below target in the final block. Mode B has no target, so no lock applies.

## Fee parameters

| Name | Scope | Suggested | Bound |
|---|---|---|---|
| `curveSellFeeBps` | both modes | 100 (1%) | ≤ 300, immutable at factory deploy |
| `curveBuyFeeBps` | both modes | **50 (0.5%)** | ≤ 300, immutable |
| `creationFeeWei` | both | small flat | admin-settable, capped |
| `creatorCurveShareBps` | Mode B | 500–2000 of the fee | ≤ 5000 |
| `refShareBps` | both | 2000 of the fee | existing hook value |
| `sweepDelaySecs` | Mode A | 365 days | ≥ 180 days |
| `graduationRaiseWei` | Mode B | start low, then tune | admin-settable, bounded |

Sell stays at 1% against the 0.5% buy. The asymmetry is deliberate and points
the same way as the threshold analysis: exiting on the curve costs twice what
entering does, so the cheap path is to hold to graduation and trade in the
pool, which is the venue that pays the protocol more and never runs out of
inventory.

Curve fees route through the same referrer split the hook already uses, so a
referred trader pays the referrer on curve volume too, not only pool volume.

Anti-grief note: in Mode A the sell fee *is* the churn defence — a round trip
always loses the fee and the 1-wei buy rounding, and can never gain, so there
is nothing to farm. Mode B needs both-sided fees because there churn is
profitable by design.

## Revenue by phase

| Event | Mode A | Mode B |
|---|---|---|
| `launch()` | creation fee | creation fee |
| curve buy | 0.5% | 0.5% |
| curve sell | `curveSellFeeBps` | `curveSellFeeBps` |
| raise fails | entry fees already taken (+ sweep after 365d) | n/a |
| graduation | — | — |
| pool trades | 1% platform fee | 1% platform fee |

Both modes now earn on every buy, every sell and every pool trade, so a
listing that never graduates is no longer a zero-revenue listing. Mode B still
carries the larger share because its churn is profitable and therefore
repeated.

## Copy that must change in the same release

The 0.5% entry fee is a decision taken deliberately for revenue. Its one
consequence is that "refunded in full" stops being literally true: a backer on
a failed raise recovers everything that entered the curve and loses the entry
fee. Six user-visible strings assert the stronger claim today and must ship
their correction in the same release as the contract, not before — changing
them earlier would advertise a fee that is not yet charged:

| File | Line | Current |
|---|---|---|
| `web/src/venture/Board.tsx` | 117 | "Full refund if it misses" |
| `web/src/venture/Board.tsx` | 149 | "100% / refunded when a raise misses target" |
| `web/src/venture/Docs.tsx` | 96 | "Raise misses target, everyone is refunded in full" |
| `web/src/venture/Docs.tsx` | 161 | "misses target → everyone refunded" |
| `web/src/venture/Venture.tsx` | 289 | "every backer is refunded in full, automatically" |
| `web/src/lib/brand.ts` | 76 | "refunds in full if it misses target" (also the OG meta) |

The replacement claim is still materially stronger than any memecoin
launchpad, which refunds nothing at all: **every wei you put into the curve
comes back; the 0.5% entry fee does not.** Phrase it as an entry fee rather
than a deduction from the refund — it is charged at the door, so a backer's
recorded position is already net and their refund really is 100% of it.

## One remaining extraction caveat

`sweepUnclaimed` on a short window converts a trust product into a liability
and hands critics a headline, for revenue that is small next to curve fees.
365 days plus a visible claim page keeps the line item without the exposure.

## Work items

1. `RaiseMode` in `LaunchParams`; mode-aware guards in `buy`/`finalize`/`abort`.
2. `sell()` with pro-rata cost-basis accounting and the Mode A cap.
3. Curve fee plumbing to `platformTreasury` with the referrer split.
4. `curveBuyFeeBps` at 50 on both modes, taken off incoming value before the
   curve quote; `creationFeeWei` on `launch()`.
5. High-water lock on target crossing; `graduationRaiseWei` as a bounded
   admin-settable parameter, read at launch and frozen per listing.
6. `sweepUnclaimed()` behind `sweepDelaySecs`.
7. Tests: escrow solvency under randomised buy/sell sequences; cap enforcement;
   `sum(spentWei) == raisedWei` invariant; high-water lock race; Mode B
   uncapped profit path; fee accrual to treasury and referrer.
8. Web: sell panel on the raise phase, mode badge on cards, wizard mode choice,
   claim page for aborted raises.
9. Web: the six refund strings above, shipped with the contract, plus an entry
   fee line in the trade panel so the 0.5% is quoted before signing.
