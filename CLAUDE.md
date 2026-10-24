# DoublePlus — working guide

The business in this repo is **DoublePlus** (doubleplus.fun), the `venture` flavor (`VITE_BRAND=venture`): a coin launchpad live on **Robinhood Chain mainnet (4663)**. The other flavors (hoodheist, basedstonk, hammr, arcx, steadypads) are legacy. Leave them alone unless asked. README.md is the operations manual for all flavors; this file is the short version for DoublePlus and how we work on it.

## How we work

- **The user deploys and sends mainnet transactions; Claude prepares them.** Give the exact command with absolute paths, as `! <command>` when it isn't interactive. Commands that prompt (`wrangler secret put`) go in the user's own terminal.
- **Commit as** `git -c user.name=IlumCI -c user.email=ilumbackup@gmail.com commit`, with no trailers and no Co-Authored-By lines. **Never push**: give the user `! cd /home/lummy/Projects/DoublePlus && git push`. Branch: `venture/mainnet-prep`.
- **Be conservative with ETH.** The user has little. Quote gas costs before asking for a transaction, and never suggest spending ETH to fake activity.
- **At most two subagents at a time.** Do small things directly.
- **Never print or commit keys**: `contracts/.env.deployer` (deployer), `keeper/.env.keeper` (keeper), and the Worker secrets.
- **Test the real thing before saying it works.** Use a fork (anvil with a dRPC upstream, because public RPCs prune history), a local `wrangler dev`, or the live chain read-only, and look at the actual coin page. Launch-day bugs (no copyable contract address, the wrong chart on open curves) got through because a real coin page was never opened.
- **Files the user keeps go in the repo** (`docs/…`, `brand/…`), never `/tmp`. **Anything sent to a third party uses public links** (for example https://doubleplus.fun/doubleplus-logo.png), never local paths. Copy-paste text goes in a code block.
- **UI rules:**
  - Longhorn-desktop look, dark only.
  - Compact: no new cards or boxes; fold information into the existing market screen.
  - No warnings, disclaimers or explainers in the copy. A blocked action still states its real number and cause.
  - No UK geofence, and nothing framed as "risk management".
- **Before adding to VentureFactory, check its size**: 24,395 of 24,576 bytes, 181 spare. Use `node scripts/size-ablate.cjs factory` in `contracts/`.

## What is live

| Piece | Where | Deploy |
|---|---|---|
| Site | Cloudflare Worker `doubleplus-site` on doubleplus.fun and www (`web/wrangler.toml`, `web/worker.mjs`). Static SPA; the Worker answers `/venture/0x…` with per-coin link previews, `/og/0x….<ext>` with coin logos, and `/sitemap.xml`. | `cd web && ../api/node_modules/.bin/wrangler deploy` |
| Chat API | Worker `doubleplus-api` on api.doubleplus.fun (`api/`), backed by Supabase `dzqrdtgjddxaacipbbjk`. Secrets: `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`. | `cd api && npx wrangler deploy` |
| Keeper | Worker `doubleplus-keeper` (`keeper/worker.mjs`), cron every minute; a Durable Object holds the lease and memory. Details below. | `cd keeper && npx wrangler deploy` |
| Contracts | `contracts/deployments/venture-robinhood.json` (authoritative), start block 94774769, all verified on Sourcify. | redeploy only (see below) |

What the keeper does on each run:
- graduates filled curves and refunds missed raises;
- pushes dividends and stock payouts;
- recenters the market-making walls, pays last-buyer pots and fills limit orders;
- checks that the factory is solvent;
- verifies new coins on Sourcify (`keeper/sourcify.mjs`);
- posts every launch and graduation to Telegram and Discord (`keeper/feed.mjs`).

Its gas caps are 0.0005 ETH a run and 0.002 ETH a day. Secrets: `KEEPER_PRIVATE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (Telegram is live), and `DISCORD_WEBHOOK_URL` (not set yet). Robinhood's own RPC throttles Cloudflare (429), so Daybreak goes first.

Main addresses:

| Contract or wallet | Address |
|---|---|
| Factory | `0x60e0DD86327F1dA36565c79aAe9f87070415963b` |
| Hook | `0x99a402348944ADC92A77471d63Bf93370A652044` |
| Router | `0x4C9C61F8EA81a66C43c6D24D11B61c5dA334220e` |
| Limit orders | `0xC45a21ebD14f7f108D56e2463a656830E02267c8` |
| Admin and treasury | `0x16d762c8644883C8169Ed950EE383dCb90F9Fbf2` (the user's wallet; it signs `setParams`, `pause` and `withdrawFees`) |
| Keeper wallet | `0x89B69eeC7cE3a01C84a0f2Ef77B89A484ccf5456` |
| Deployer | `0x201678B2840eB3EE5d097ff71f0412bCf847ba45` |

`setParams` as set: creation fee 0.0003 ETH, graduation 4 ETH, sweep 365 days, creator curve share 20%.

Coins so far: **$DOUBLEPLUS** `0xc44cFd968A38C6B16A8Be4677bbB87d0eBB42add`, an open curve. The only backer is the user, so it isn't expected to graduate on its own.

## How the product works (facts for copy and support)

- **Every coin opens at a $750 market cap.** That's `START_MCAP_USD_8`, fixed in the contract. The price then rises in a straight line until the curve's target is reached.
- **Graduation market cap** ≈ 2 × raise × ETH price ÷ 0.6, minus $750. The curve sells 60% of the 1B supply.
- **Open curve:** no target set by the creator, no refunds. It graduates at `graduationRaiseWei` (4 ETH, adjustable, frozen into each coin at launch).
- **Target raise:** the creator sets the target, with a 1 ETH floor (`minTargetWei`). If it misses by the deadline (14 days at most), every backer is refunded. A bigger raise means a pool that opens at a higher market cap: this is the "invest into a project for it to rocket" mode.
- **At graduation,** the coin gets a Uniswap v4 pool in the same transaction, and the liquidity is locked forever. There is no withdrawal path, and `venture.lock.test.ts` checks that.
- **Anti-snipe:**
  - In the first minute, a wallet can buy at most 1% of the target.
  - On the pool, trades pay a sniper fee of 15% for the first 5 seconds after graduation, then 5% up to 15 seconds.
- **Creators** earn up to 4% of every trade through their coin's fee policy, plus 20% of the curve fees on open curves.
- **Holders** earn dividends with tiers up to 10×, and from 5× they can be paid in tokenized stocks.
- **Also built in:** limit orders, a last-buyer pot, chat on every coin, and referrals.

## How the business makes money

- **Platform fee:** 0.75% of every pool trade, in the hook. Of that, 20% goes to the trader's referrer (if they have one), 20% to the coin's last-buyer pot, and the rest to the treasury.
- **Curve fees:** 1% on buys and 1% on sells. On open curves the creator gets 20% and the treasury the rest. These collect in the factory until the treasury calls `withdrawFees()`.
- **Creation fee:** 0.0003 ETH per launch.
- **Running costs:** the $5/month Workers plan, keeper gas (capped as above, about 0.000004 ETH per transaction), and the domain. Nothing else is paid.

## Growth plan (as agreed)

1. **Automation does the visible work.**
   - Coin links preview the coin.
   - Every coin is verified on Sourcify automatically.
   - Launches and graduations post to the Telegram channel, and to Discord once its webhook is set.
   - The sitemap gets coin pages indexed.
2. **Free listings,** prepared in `docs/listings/`:
   - DefiLlama adapter PR
   - Alchemy Dapp Store
   - awesome-robinhood-chain
   - Robinhood's own ecosystem page, via DM to @RobinhoodCrypto (sent)
3. **X (@DoublePlusFund) is the main channel.**
   - The launch video is `~/Projects/doubleplus-video/promo/out/doubleplus-launch.mp4` (posted 2026-10-24).
   - Links go in replies, not the main post.
4. **Pitch both sides:** creators (including pump creators) and traders/holders. Lead with the RWA angle (stock payouts) when talking to Robinhood.
5. **Paid listings** (the DexScreener profile at about $299, DEXTools, Trust Wallet) are skipped until there's volume. DexScreener and GeckoTerminal list a coin free once it graduates.

## Open items

- **The weekly flywheel isn't running on mainnet.** This is the epoch buyback of the top 3 coins and the trader rebates in `.github/workflows/venture-keepers.yml`. The workflow defaults to testnet and the repo has no `VENTURE_KEEPER_PK`, yet the site's sidebar advertises a weekly payout. Turning it on needs:
  - the secret;
  - the `VENTURE_CHAIN_ID=4663` variable and a mainnet `VENTURE_RPC_URL`;
  - a funded wallet.

  Decide with the user.
- Optional: lower `graduationRaiseWei` to 1–2 ETH so early coins can graduate (one `setParams` transaction from the treasury; affects new launches only).
- Ideas not built yet: an "Add to wallet" button on coin pages, Blockscout token info for $DOUBLEPLUS (the creator wallet signs once), GeckoTerminal token info after graduation, auto-posting to X (check API pricing first).
- `contracts/contracts/autotrader/` and the `hardhat.config.ts` change are the user's uncommitted work in progress; they aren't deployed and aren't part of DoublePlus. Don't commit them unless asked.

## Traps

- **A new factory means a whole new system.** The hook, router, limit orders, payouts, boosts, updates and both deployers are bound to the factory's address. Existing coins stay on the old contracts. `setParams` values don't carry over, so re-run them after every deploy.
- **If QuiverToken or its imports change,** run `node make-token-source.mjs` in `keeper/` before redeploying the keeper. It picks the build that matches the on-chain TokenDeployer; the newest build-info on disk isn't necessarily it.
- **The venture build drops every public file not on the allowlist** in `web/vite.config.ts` (`ventureDist`). Add a new public file there, or it won't ship.
- **Coin descriptions live on-chain and can't be edited.** Display code cleans them (`safe.ts`).
- **Robinhood Chain's block gas limit is huge,** so a transaction without an explicit gas limit can fail as "insufficient funds".
