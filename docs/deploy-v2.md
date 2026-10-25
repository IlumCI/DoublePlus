# Deploying v2: coins that earn from the first curve trade

v2 is a whole new system (factory, hook, router, limit orders, payouts, boosts,
and the new VentureCurveDesk). v1 stays live: $DOUBLEPLUS and anything else
launched on it keep trading there, and the site, keeper, chat API and
GeckoTerminal adapter run both systems. New launches go to v2.

## What v2 changes

On v1 a coin's founder tax, dividends, pot and jackpot start at graduation; on
the curve there is only the flat 1% fee. On v2, from the first curve trade:

- **Founder tax** (the coin's 0–4% buy and sell tax) on every curve trade, split
  by the coin's policy:
  - dev share and holder dividends paid in the same trade;
  - the jackpot module's share builds the jackpot;
  - the liquidity and market-making shares load a buyback.
- **Buyback:** the keeper fires it once it holds 0.002 ETH, at a random moment up
  to 15 minutes later. It buys the coin and burns it: on the curve for open
  curves, in the pool after graduation. A target raise's buyback waits for
  graduation.
- **Pot:** 20% of the curve fee builds the last-buyer pot (1 hour timer, 0.005 ETH
  minimum buy), as in the pool.
- **Every-Nth-buy jackpot** on the curve.
- **Payouts in WETH:** every curve payout (referrer, creator share, dev,
  treasury, pot, jackpot) is paid in WETH inside the trade. Nothing waits for
  `withdrawFees()` any more; the factory's ledger only holds creation fees,
  founder cuts and sweeps.

Curve fee split on v2 (1% buy, 1% sell):

| Share | Referred trader | Open curve | Target raise |
|---|---|---|---|
| Referrer | 20% | — | — |
| Creator | — | 20% (`creatorCurveShareBps`) | — |
| Pot | 20% | 20% | 20% |
| Treasury | the rest | the rest | the rest |

Tested:
- 57 unit tests (7 new for the desk) and 12 mainnet-fork tests, including a pool
  buyback after graduation and a buyback that fills an open curve;
- the deploy script on a fork, then the site on that fork (both systems' coin
  pages and the board);
- the keeper and adapter end to end on a fork (see the commit).

## Cost

Deploy: about 18.8M gas, about 0.00038 ETH at today's 0.02 gwei. The deployer
(`0x201678B2840eB3EE5d097ff71f0412bCf847ba45`) holds 0.00016 ETH, so send it
**0.0006 ETH** from the admin wallet first. setParams from the admin wallet: under
0.000002 ETH.

## Steps

1. **Fund the deployer:** send 0.0006 ETH from the admin wallet to
   `0x201678B2840eB3EE5d097ff71f0412bCf847ba45`.

2. **Deploy.** It mines the hook salt, deploys and wires everything, keeps the v1
   record as `deployments/venture-robinhood.0x60e0DD86.json` and writes v2 to
   `deployments/venture-robinhood.json`. It prints the setParams call for the
   admin.
   ```
   ! cd /home/lummy/Projects/DoublePlus/contracts && ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com ROBINHOOD_CHAIN_ID=4663 ADMIN=0x16d762c8644883C8169Ed950EE383dCb90F9Fbf2 TREASURY=0x16d762c8644883C8169Ed950EE383dCb90F9Fbf2 PAYOUT_KEEPER=0x89B69eeC7cE3a01C84a0f2Ef77B89A484ccf5456 PLATFORM_FEE_BPS=75 REF_SHARE_BPS=2000 CURVE_BUY_FEE_BPS=100 CURVE_SELL_FEE_BPS=100 MIN_TARGET_ETH=1 POT_MIN_BUY_ETH=0.005 GRADUATION_RAISE_ETH=1.8 CREATION_FEE_ETH=0.0003 npx hardhat run scripts/deploy-venture.ts --network robinhood
   ```

3. **setParams** (admin wallet). Serve the admin page and open it with the new
   factory, then set creation fee 0.0003, graduation 1.8, sweep 365 days and
   creator curve share 20%:
   ```
   ! cd /home/lummy/Projects/DoublePlus/contracts/admin && python3 -m http.server 8790
   ```
   `http://localhost:8790/set-params.html?factory=<new factory from deployments/venture-robinhood.json>`

4. **Verify the contracts on Sourcify** (no gas):
   ```
   ! cd /home/lummy/Projects/DoublePlus/contracts && npx hardhat compile && node --import tsx scripts/verify-venture-sourcify.ts
   ```

5. **Point the site and chat API at both systems.** This writes v2 as
   `VITE_VENTURE_*` (with `VITE_VENTURE_DESK`), v1 as `VITE_VENTURE_V1_*`, and
   both factories into the chat API's `FACTORY`. Then deploy both:
   ```
   ! cd /home/lummy/Projects/DoublePlus && node web/scripts/venture-env.mjs mainnet && cd web && npm run build -- --mode venture && ../api/node_modules/.bin/wrangler deploy && cd ../api && npx wrangler deploy
   ```

6. **Keeper.** Its build bundles every `deployments/venture-robinhood*.json`:
   ```
   ! cd /home/lummy/Projects/DoublePlus/keeper && npx wrangler deploy
   ```

7. **GeckoTerminal adapter.** Set `V2_FACTORY`, `V2_CURVE_DESK` and
   `V2_START_BLOCK` in `gecko/wrangler.toml` from the new
   `deployments/venture-robinhood.json` (I can do this once it exists), then:
   ```
   ! cd /home/lummy/Projects/DoublePlus/gecko && ../api/node_modules/.bin/wrangler deploy
   ```

8. **Commit both deployment records** (I'll do this).

9. **Tell GeckoTerminal.** The application named the v1 factory. Send the
   v2 addresses through the same form with "Network/DEX/Launchpad Information
   Update" → "Change of Factory and Router Address", or in the Telegram thread
   they open.
