# PR title

Add DoublePlus TVL adapter (Robinhood Chain)

# PR body

#### Please enable "Allow edits by maintainers" while putting up the PR.

## (Needs to be filled only for new listings)

##### Name (to be shown on DefiLlama):
DoublePlus

##### Twitter Link:
https://x.com/DoublePlusFund

##### List of audit links if any:
None

##### Website Link:
https://doubleplus.fun

##### Logo (High resolution, will be shown with rounded borders):
https://doubleplus.fun/doubleplus-logo.png (1200x1200 PNG)

##### Current TVL:
About $2 (one coin, still on its bonding curve)

##### Treasury Addresses (if the protocol has treasury)
0x16d762c8644883C8169Ed950EE383dCb90F9Fbf2 (Robinhood Chain)

##### Chain:
Robinhood Chain

##### Coingecko ID (so your TVL can appear on Coingecko, leave empty if not listed): (https://api.coingecko.com/api/v3/coins/list)


##### Coinmarketcap ID (so your TVL can appear on Coinmarketcap, leave empty if not listed): (https://api.coinmarketcap.com/data-api/v3/map/all?listing_status=active,inactive,untracked&start=1&limit=10000)


##### Short Description (to be shown on DefiLlama):
Coin launchpad on Robinhood Chain. Coins launch on a bonding curve, either open or as a raise with a target that refunds if missed; when the curve fills, the coin gets a Uniswap v4 pool in the same transaction with its liquidity locked. Creators earn up to 4% of trades and holders earn dividends.

##### Token address and ticker if any:
None

##### Category (full list at https://defillama.com/categories) \*Please choose only one:
Launchpad

##### Oracle Provider(s): Specify the oracle(s) used (e.g., Chainlink, Band, API3, TWAP, etc.):
None

##### Implementation Details: Briefly describe how the oracle is integrated into your project:
No oracle. Curve pricing is set by the curve formula; the ETH/USD price used to size a curve's start price is supplied at launch and bounded by fixed limits in the factory.

##### Documentation/Proof: Provide links to documentation or any other resources that verify the oracle's usage:
N/A

##### forkedFrom (Does your project originate from another project):
None

##### methodology (what is being counted as tvl, how is tvl being calculated):
Counts the native ETH held by the DoublePlus factory (0x60e0DD86327F1dA36565c79aAe9f87070415963b), which escrows bonding-curve raises before a coin graduates (plus fees owed), and the WETH side of every Uniswap v4 pool a graduated coin was given. Pools are listed from the factory (allTokens and listings, which returns each coin's pool id), and reserves are rebuilt on chain from tick liquidity and the current price via the Uniswap v4 StateView. Pool liquidity is owned by the factory and cannot be withdrawn. Launched coins are not counted. Marked doublecounted because graduated pools sit in the Uniswap v4 PoolManager, which the Uniswap V4 listing also counts.

##### Github org/user (Optional, if your code is open source, we can track activity):


##### Does this project have a referral program?
Yes. A trader bound to a referrer pays a reduced fee, and the referrer receives a share of the protocol fee on that trader's trades.
