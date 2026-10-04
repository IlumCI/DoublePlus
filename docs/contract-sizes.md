# Venture contract sizes

Recorded 2026-10-04, after the last-buyer pot and `refundMany` (commit `5288d89`).
The EVM refuses to deploy runtime code over **24,576 bytes**.

Refresh with `npx hardhat compile && node scripts/size-ablate.cjs factory|hook`
(from `contracts/`). That recompiles with groups of function bodies replaced by
`revert()` and reports how much smaller each makes the contract. Groups that
share helpers overlap, so rows add up to a little more than the whole.

## The system

| Contract | Runtime bytes | Headroom |
|---|---|---|
| VentureFactory | 24,395 | **181** |
| VentureFeeHook | 16,308 | 8,268 |
| VentureTokenDeployer (embeds QuiverToken's initcode) | 9,706 | 14,870 |
| QuiverToken (one per coin) | 5,634 | 18,942 |
| VentureRouter | 5,112 | 19,464 |
| VestingDeployer (embeds FounderVesting) | 2,706 | 21,870 |
| FounderVesting (one per coin) | 1,996 | 22,580 |
| VentureUpdates | 675 | 23,901 |

The factory is compiled with `runs: 1` (size over gas) to fit at all; see the
override in `hardhat.config.ts`.

## VentureFactory (24,395)

| Feature | Bytes | Share |
|---|---|---|
| Graduation: pool create, Uniswap price math (TickMath, sqrt), liquidity add | ~6,600 | 27% |
| Launch: validation, curve setup, founder vesting, token deploy | ~5,400 | 22% |
| 43 public getters (16 constants, 13 immutables, 8 mappings, rest state) | ~2,800 | 12% |
| Curve buy + sell | ~2,800 | 12% |
| Failed-raise path: abort, refund, refundMany, sweep (refundMany alone ~500–600) | ~2,000 | 8% |
| Curve fee split + withdraw | ~1,300 | 5% |
| Dispatcher and math shared across features | ~2,500 | 10% |
| Views and admin (curveState, terms, setParams, pause) | ~900 | 4% |

## VentureFeeHook (16,308)

Rougher: almost everything hangs off `afterSwap`, so stubbing a helper also
removes code after it.

| Feature | Bytes |
|---|---|
| afterSwap fee engine itself | ~4,500 |
| Quote walls + auto-liquidity bands | ~2,900 |
| Last-buyer pot (exact: 13,602 → 16,308 when it was added) | 2,706 |
| Wall recenter | ~1,800 |
| Pool config, dev wallet | ~1,600 |
| Founder-tax bucket split | ~1,400 |
| In-pool conversions | ~600 |
| Dividends | ~400 |
| Referrals | ~130 |
| Unused IHooks stubs | ~60 |

## If the factory needs room

1. Make the 16 public constants `internal` and keep the web/keeper copies:
   ~1 KB, no behaviour change. Check the site and keepers for direct reads first.
2. Move graduation into its own contract, like the token and vesting deployers:
   ~6 KB. Costs a redeploy, a little gas per graduation, and audit surface.
3. Move launch validation into a helper: 2–3 KB.

New features that fit in the hook have ~8 KB there.
