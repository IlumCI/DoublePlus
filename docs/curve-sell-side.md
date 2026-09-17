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

- Curve buys: **no protocol fee** (a held position stays fully refundable).
- Curve sells: allowed at any time, **proceeds capped at the seller's
  pro-rata cost basis**, protocol fee charged on the proceeds.
- Refund on failure: unchanged, full cost basis of tokens still held.

The cap is not a UX preference, it is a solvency requirement — see below.
Consequence worth stating plainly: during a Guaranteed raise the curve is an
**exit, not a profit venue**. You can always get out; you cannot extract more
than you put in until the token actually graduates into the pool.

### Mode B — `Open` (pump.fun shape)

No target, no deadline, no refund, no all-or-nothing. Graduates on a fixed
threshold (`soldWhole >= CURVE_SUPPLY_WHOLE`, or an FDV threshold).

- Curve buys **and** sells both charged.
- Sell proceeds **uncapped** — real speculation, real profit and loss.
- No founder cut of a raise; the creator earns a share of curve fees instead.

Escrow solvency is trivial here: there is no refund liability, and buys pay
`curveCost + 1` while sells receive at most `curveCost`, so the escrow is
monotonically non-negative by construction.

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
| `curveBuyFeeBps` | **Mode B only** | 100 (1%) | ≤ 300, immutable |
| `creationFeeWei` | both | small flat | admin-settable, capped |
| `creatorCurveShareBps` | Mode B | 500–2000 of the fee | ≤ 5000 |
| `refShareBps` | both | 2000 of the fee | existing hook value |
| `sweepDelaySecs` | Mode A | 365 days | ≥ 180 days |

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
| curve buy | — | `curveBuyFeeBps` |
| curve sell | `curveSellFeeBps` | `curveSellFeeBps` |
| raise fails | — (sweep after 365d) | n/a |
| graduation | — | — |
| pool trades | 1% platform fee | 1% platform fee |

Mode A monetises exits and graduated volume while keeping the refund promise
literally true. Mode B monetises everything and is where the churn revenue is.

## Two places where maximum extraction backfires

Stated as business risk, not objection:

1. **`sweepUnclaimed` on a short window** converts a trust product into a
   liability and hands critics the headline. The revenue is small relative to
   curve fees; the reputational cost lands on the Guaranteed mode, which is
   the whole wedge. 365 days plus a visible claim page keeps the line item
   without the exposure.
2. **Charging buy-side fees in Mode A** breaks "100% refunded", which is the
   only structural claim separating this from a memecoin launchpad. The
   revenue it adds is a fraction of what Mode B produces from the same users.
   Keep Mode A's buy side free and let Mode B carry the extraction.

## Work items

1. `RaiseMode` in `LaunchParams`; mode-aware guards in `buy`/`finalize`/`abort`.
2. `sell()` with pro-rata cost-basis accounting and the Mode A cap.
3. Curve fee plumbing to `platformTreasury` with the referrer split.
4. `creationFeeWei` on `launch()`.
5. High-water lock on target crossing.
6. `sweepUnclaimed()` behind `sweepDelaySecs`.
7. Tests: escrow solvency under randomised buy/sell sequences; cap enforcement;
   `sum(spentWei) == raisedWei` invariant; high-water lock race; Mode B
   uncapped profit path; fee accrual to treasury and referrer.
8. Web: sell panel on the raise phase, mode badge on cards, wizard mode choice,
   claim page for aborted raises.
