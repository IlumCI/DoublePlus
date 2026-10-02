# Launchpad monorepo — operations

Private repo. One codebase that builds **six launchpad brands** across four chains,
selected at build time by `VITE_BRAND`. Every contract generation ever deployed
still lives in `contracts/`, because the deployments are still live and the
keepers still service them.

This file is the operations manual: what is running, how to deploy it, how to
keep it alive. It does not explain the contracts — read those in
`contracts/contracts/`, and the venture design rationale in
`docs/curve-sell-side.md`.

---

## What is live right now

| Flavor (`VITE_BRAND`) | Brand / domain | Chain | Contracts artifact | Keeper |
| --- | --- | --- | --- | --- |
| `copair` | **hoodheist.fun** — production | Robinhood 4663 | `robinhood-flywheel.json` | Vercel cron `/api/keeper`, 10 min |
| `base` | basedstonk.fun | Base 8453 | `base-stockfly-v3.json` | GH Actions `base-keeper.yml`, 30 min |
| `venture` | **doubleplus.fun** — active development, mainnet launch pending | Robinhood **testnet** 46630 | `venture-testnet.json` | GH Actions `venture-keepers.yml`, 15 min + weekly |
| `hammr` | hammr | Robinhood 4663 | `robinhood-hammr.json` | none |
| `arc` | arcx.fun | Arc 5042 | `arc-v3-launchpad.json` | none (permissionless `harvestFees`) |
| `steadypads` | steadypads.vercel.app | Stable 988 | `stable-launchpad.json` | none |

Also deployed on Robinhood 4663 and still reachable by address, without a
current front end: `robinhood-diamond`, `robinhood-hood`, `robinhood-earn`,
`robinhood-rh-final`, `robinhood-rh-buyback`, `robinhood-rh-fork`, `quiver-v4`,
`robinhood-launchpad`.

**doubleplus has no mainnet deployment.** `venture-testnet.json` is the only
venture artifact that exists.

### Two things the files get wrong

1. `web/.env.production.local` is the production build config, and its comments
   name `RhFinalFactory / RhFinalHook`. That is wrong. The addresses in it
   (`0x44F0fEF2…`, `0xa775543d…`, start block `34558420`) are
   **`robinhood-flywheel.json`** — `FlyFactory` + `FlywheelHook`. Production runs
   the flywheel model: weekly buyback-and-burn of the epoch's top-3 coins, 30% of
   fees to traders pro-rata by routed volume. Trust the addresses, not the comment.
2. The `web/.env.*.example` files are stale. `.env.base.example` points at
   StockFly **V2** while CI deploys V3; `.env.venture.example` points at a
   superseded venture factory. **The deployment JSONs in `contracts/deployments/`
   are authoritative.**
   Regenerate an env file from the JSON, never the other way round.

---

## Deploying the web app

One Vite app, one flavor per build. Config arrives as `VITE_*` variables, which
are **inlined into the client bundle at build time** — nothing here is secret,
and nothing secret may be added.

### Production (copair / hoodheist)

`web/.env.production.local` is committed and is picked up automatically by any
production build.

```bash
npm install
npm run build --workspace @launchpad/sdk
cd web && npm run build
bash deploy/assemble.sh
npx vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"   # from web/, uses .vercel/output
```

`assemble.sh` is required, not optional. It builds `.vercel/output` in Build
Output API v3 form and is what attaches the serverless functions and the keeper
cron:

| Route | Source | Purpose |
| --- | --- | --- |
| `/api/rpc` | `deploy/api-rpc/index.mjs` | same-origin JSON-RPC relay |
| `/api/usd` | `deploy/api-usd/index.mjs` | same-origin USD price relay |
| `/api/bridge-in` | `deploy/api-bridge-in/` | Base → Arc USDC leg |
| `/api/bridge-out` | `deploy/api-bridge-out/` | Arc → Base USDC leg |
| `/api/keeper` | `deploy/api-keeper/` | **cron `*/10 * * * *`** — production keeper |

A plain `vercel deploy web/dist` ships the site **without the keeper cron**.
Rewards stop flowing and nobody gets an error. Do not do it.

Server-side env required on the Vercel project:

- `KEEPER_PK` — funded keeper wallet (gas, and the buyback pot)
- `CRON_SECRET` — authenticates cron calls to `/api/keeper`
- `RELAYER_PRIVATE_KEY` — bridge relayer, only if the bridge legs are in use
- optional: `HARVEST_MIN_USD` (5), `PAYOUT_MIN_USD` (1), `BURN_TOKEN`,
  `BURN_MIN_ETH`, `RH_RPC`

Every one of these is read from `process.env`; the functions return 503 when
unset rather than running degraded.

### Any other flavor

```bash
cd web
cp .env.<flavor>.example .env.<flavor>     # then FIX IT against contracts/deployments/
VITE_BRAND=<flavor> npx vite build --mode <flavor>
```

`--mode X` makes Vite load `.env.X`. The Base workflow instead passes every
`VITE_*` as a process env var, which overrides file config — either approach
works, but do not mix them in one build.

Only `web/vercel.json`'s SPA rewrite is needed for a static flavor. Flavors with
no serverless functions do not need `assemble.sh`.

---

## Deploying contracts

Hardhat only. No Foundry. Solidity 0.8.26, `viaIR`, `runs: 400`, with
`VentureFactory.sol` overridden to `runs: 1` — it sits at 22,661 of the 24,576
byte limit, so **any addition to it must be size-checked before it can ship**.

Network config is env-driven; the single `robinhood` network entry serves both
Robinhood chains:

```bash
cd contracts
cp .env.example .env    # NOTE: this file is gen-0 and half-obsolete, see below
```

`contracts/.env.example` documents `PLATFORM_ADMIN`, `UNISWAP_*` and
`GRADUATION_CAP_USD_8` for contracts that no longer exist in this repo. What you
actually need:

```
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com   # or .testnet.
ROBINHOOD_CHAIN_ID=4663                                      # or 46630
BLOCKSCOUT_URL=https://robinhoodchain.blockscout.com
PRIVATE_KEY=                 # leave empty; use .env.deployer
```

The deployer key lives in gitignored `contracts/.env.deployer`, generated by
`npx hardhat run scripts/generate-deployer.ts` and loaded automatically. It signs
deployments and holds no privileges afterwards.

### Venture (doubleplus)

```bash
ROBINHOOD_RPC_URL=https://rpc.testnet.chain.robinhood.com ROBINHOOD_CHAIN_ID=46630 \
ADMIN=0x… TREASURY=0x… \
npx hardhat run scripts/deploy-venture.ts --network robinhood
```

Writes `deployments/venture-testnet.json` (or `venture-robinhood.json` on 4663).
The script mines a CREATE2 salt for the hook's flag bits, predicts the factory
address two nonces ahead so the hook and token deployer can bake it in, asserts
the prediction held, and renounces factory ownership at the end.

**Immutable at deploy — you cannot change these later, only redeploy:**

| Env | Default | Bound |
| --- | --- | --- |
| `PLATFORM_FEE_BPS` | 55 (0.55%) | 50–100 |
| `REF_SHARE_BPS` | 2000 (20% of the fee) | ≤ 5000 |
| `CURVE_BUY_FEE_BPS` | 50 (0.5%) | ≤ 300 |
| `CURVE_SELL_FEE_BPS` | 100 (1%) | ≤ 300 |
| `MIN_TARGET_ETH` | **0.5** | ≤ 1,000,000 |
| `ADMIN`, `TREASURY` | deployer | — |

The script's own header comment says `PLATFORM_FEE_BPS` defaults to 100; the code
says 55. The code is right.

`MIN_TARGET_ETH` is the one to think about. Testnet runs 0.002 so a faucet wallet
can drive a raise to graduation; **mainnet must ship 0.5**, and it is coupled to
the contract's `START_MCAP_USD_8` of $750 — changing either without the other
strands one of them. `venture.lock.test.ts` pins the relationship.

After deploying, regenerate `web/.env.venture.example` from the new JSON.

### Robinhood family (production flavors)

One script per generation, same shape: `deploy-rh-final.ts`, `deploy-flywheel.ts`,
`deploy-hood.ts`, `deploy-diamond.ts`, `deploy-hammr.ts`, `deploy-rh-buyback.ts`,
`deploy-earn.ts`. Each takes `ADMIN` (defaults to deployer) and `RENOUNCE=0` to
skip renouncing, mines hook flags, and writes its own `deployments/*.json`.

### Verification

```bash
cd contracts
BLOCKSCOUT_URL=… npm run verify:blockscout -- --network robinhood
```

This posts the standard-JSON compiler input from `artifacts/build-info` to
Blockscout's native API v2, which is more reliable on Blockscout instances than
the etherscan-compatible endpoint. (The script this points at used to be
`verify.ts`, which targeted a contract set that no longer exists; that file has
been deleted and the npm script repointed.)

---

## Keepers

Four scheduled jobs. Three are on GitHub Actions, one on Vercel. **All of them
no-op silently when their key is unset** — check the run logs, not the exit code.

| Job | Where | Schedule | Targets | Secret |
| --- | --- | --- | --- | --- |
| production keeper | Vercel cron | `*/10` | `robinhood-flywheel` (**live**) | `KEEPER_PK` |
| `venture-keepers.yml` → ops | Actions | `*/15` | venture testnet | `VENTURE_KEEPER_PK` |
| `venture-keepers.yml` → flywheel | Actions | Mon 12:00 UTC | venture testnet | `VENTURE_KEEPER_PK` |
| `base-keeper.yml` | Actions | `*/30` | `base-stockfly-v3` | `KEEPER_PRIVATE_KEY` |
| `keeper.yml` | Actions | **manual only** | `quiver-v4` (abandoned) | `KEEPER_PRIVATE_KEY` |

`keeper.yml` services `quiver-v4.json`, the oldest V4 deployment on 4663, which
nothing in the current front end points at. Its `*/30` cron was burning gas for
no one and has been removed; the job is kept as `workflow_dispatch` in case that
deployment still has holders with unharvested fees. Re-enable the cron only if
that turns out to be true.

Two keepers write back to the repo (`git push` of refreshed proof manifests into
`web/public/rewards/`): `base-keeper.yml` and the venture flywheel. Those commits
are what make the claim UI work, so a branch protection rule that blocks the
keeper's push silently breaks claims.

None of the keepers can divert funds. `claimFor`/`claimForMany` can only push a
holder's rewards to that holder, and `StockRewardVault` only moves value into a
posted Merkle epoch. They spend gas and nothing else.

`DRY_RUN=1` on the venture keepers logs intended actions without sending
transactions. Use it before any manual run.

---

## Routine maintenance

### Tunable without redeploying — venture

`setParams(creationFeeWei, graduationRaiseWei, sweepDelaySecs, creatorCurveShareBps)`,
callable only by `protocolAdmin`:

- `graduationRaiseWei` — bounded `[minTargetWei, 1_000_000 ether]`. Read at launch
  and frozen per listing, so **a live raise never has its finish line moved**.
- `sweepDelaySecs` — ≥ 180 days, currently 365.
- `creatorCurveShareBps` — ≤ 5000, currently 1000.
- `creationFeeWei` — no constructor default, so it is **0 on every fresh deploy**.

`pause()` / `resume()` stop new launches only; live curves and pools are untouched.

**`setParams` state does not survive a redeploy.** All four values are plain
storage with no constructor initialisation, so a new factory starts at
`creationFeeWei = 0`, `graduationRaiseWei = 0.5 ether`, `sweepDelaySecs = 365 days`,
`creatorCurveShareBps = 1000`. The testnet creation fee was set to 0.0005 ETH in
`9f0ffaf`, then the factory was redeployed in `c905d1c` and nothing re-applied it —
so the live testnet factory is almost certainly charging nothing. **Re-run
`setParams` as the last step of every deploy**, and read the values back before
assuming otherwise.

Instrument before tuning `graduationRaiseWei`: per-token curve fee accrued, pool
fee accrued, time on curve, pool volume in the first 24h post-graduation, and the
share of listings that never graduate. The optimum is empirical.

### The lever that matters

**`FlyFactory.collect(token, liquidityBps, recipient)` on the production factory
can withdraw up to 100% of any graduated pool's liquidity**, gated to the
immutable `protocolAdmin`, and it survives `renounceOwnership()`. The same lever
exists on every generation in this repo except venture, where it was removed
outright — there is no encoding of the callback that withdraws, and
`venture.lock.test.ts` asserts its absence by ABI reflection.

If a front end promises locked liquidity on a non-venture flavor, the bytecode
does not back that promise. Know which one you are deploying.

### Key inventory

| Key | Holds | Rotation |
| --- | --- | --- |
| `0x5DdDEa56…2f4A0b` | admin / treasury / feeRecipient in **16 of 25** deployment artifacts, across chains 4663, 8453, 5042 and 988 | immutable on most contracts — rotation means redeploying |
| `0x1B97531b…45Acce` | venture testnet admin + treasury | immutable |
| `0xd6F0e894…29c8ac` | deployer of record | freely rotatable, zero privileges |
| `0xe5b498a0…2552208` | bridge relayer, both legs | immutable in the payout contracts |
| keeper wallets | gas only | rotate freely, update the secret |

The first row is the one to plan around: a single key carries drain authority over
nearly the entire live footprint, and it cannot be rotated in place.

### Credentials to rotate now that this repo is private

These were committed while the repo was public and should be treated as burned:

- `web/.env.arc.example:19`, `web/deploy/api-bridge-in/index.ts:27`,
  `web/deploy/api-bridge-out/index.ts:25` — `?key=7629f78c…` is the `ACCESS_KEY`
  on your own Tor RPC gateway (`gateway/server.mjs:121`). Anyone with the repo can
  use your gateway's egress.
- `web/deploy/api-rpc/index.mjs:6` — a bearer-token-in-path RPC at
  `real-pump-soon-trust-me-bro-again.poptyedev.com`, hardcoded as the default
  upstream. Third-party; you may not control rotation.
- `VITE_WALLETCONNECT_PROJECT_ID=e1bda672…` in four files — public by design
  (it ships in the bundle), but tied to your Cloud account.

No private keys are committed anywhere. Every signing key is read from
`process.env` or Actions secrets. That part is done correctly.

### Unattended surface

`bridge/index.html` is a 62 KB standalone page outside the build system that moves
real Ethereum-mainnet USDC to relayer `0xe5b498a0…2552208` — the same relayer as
`web/deploy/api-bridge-*`. Nothing in `web/` references it, nothing builds or tests
it, and it was last touched 2026-07-16. If that relayer still holds funds, audit it
independently of whatever else is in flight.

---

## Local development

```bash
npm install
cd contracts && npx hardhat node                          # terminal 1
npx hardhat run scripts/local-venture.ts --network localhost   # terminal 2
cd web && npm run dev                                     # terminal 3
```

`local-venture.ts` deploys the full venture stack locally and opens one
Guaranteed raise with a live curve position, so the raise-phase UI can be driven
for real. Pool seeding is never reached locally, so the placeholder
`poolManager`/`v3Router` are fine.

Still gen-0 and not useful for venture work: `scripts/localnet.ts` (deploys
`TokenFactory`/`Treasury`/`FeeDistributor`/`Launchpad`, none of which exist),
`scripts/onebuy.ts`, and `web/scripts/gen-env.mjs` / `npm run gen:env`, which
read the file `localnet.ts` writes. Delete them when someone has a minute.

### Tests

```bash
npm test                              # contracts + web
npm test --workspace @launchpad/contracts   # hardhat, full suite
npm test --workspace @launchpad/web         # vitest
cd contracts && npm run test:venture  # venture unit + lock + stress + dividends
cd contracts && npm run test:canary   # proves the harness reports red
```

CI runs the first of these on every push and PR to `main`
(`.github/workflows/test.yml`). It does **not** gate on `tsc --noEmit`: there
are ~344 pre-existing type errors in `contracts/` (implicit `any`,
`BaseContract` property access) that Hardhat never surfaces because it runs
transpile-only. Worth fixing, but not as a blocking gate.

**All 20 `*.fork.test.ts` files self-skip unless `FORK=1` is set** (20 of 20,
verified). A green `npm test` has therefore run none of the integration tests
against real deployed infrastructure. To actually run them:

```bash
cd contracts
FORK=1 ROBINHOOD_RPC_URL=… npx hardhat test test/v4/venture.fork.test.ts
```

`harness.test.ts` is a canary suite that tests the test runner itself — that
`expect()` throws, that `revertedWith` fails on a passing call, that deployed
bytecode is not a stub. Run `test:canary` after any Hardhat or toolchain upgrade;
if it passes when it should fail, the whole suite is meaningless.

---

## Traps

- **Deploying production without `assemble.sh`** drops the keeper cron. No error,
  rewards just stop.
- **`web/.env.*.example` files are stale.** Build from `contracts/deployments/*.json`.
- **`setParams` does not survive a redeploy.** A fresh venture factory charges no
  creation fee. Re-run it as the last step of every deploy.
- **Two factories are at the bytecode limit.** `HammrFactory` is 24,524 of 24,576
  — 52 bytes spare — and `HoodFactory` has 381. Neither can be modified again,
  only redeployed. `VentureFactory` is at 22,793 and still growing; check the
  size before adding to it.
- **Nine `*.fork.test.ts` files and fourteen scripts mined CREATE2 salts against
  a stale `QuiverToken` ABI** after the constructor gained two dividend
  parameters. All 19 sites are fixed, but the fork tests have still never
  executed — they need `FORK=1` and an RPC. Run the manual `fork` CI job before
  trusting them.
- **Git history is three unrelated root commits** grafted together; `contracts/`
  has no history before 2026-08-20, when 421 files arrived in one commit labelled
  `web: ETH is the default pool pairing`. `git log` on a contract will tell you
  almost nothing. Do not rely on blame here.

Fixed in the cleanup pass, recorded so they are not reintroduced: `npm install`
used to fail on current Node because the unused `backend/` workspace pulled in
`better-sqlite3` (backend is no longer a workspace); `npm test` used to exit 1
without running anything because a test-only dependency lived in the
non-workspace `keeper/` package; `web`'s vitest `--exclude` used single quotes,
which `cmd.exe` does not treat as quotes, so the live DexScreener test ran in
CI; `deploy-base.yml` pointed at a branch that does not exist; and `keeper.yml`
ran a `*/30` cron against an abandoned deployment.
