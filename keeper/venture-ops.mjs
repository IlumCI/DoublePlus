// doubleplus venture ops keeper — the launchpad runs itself.
//
// Every run, for every venture on the factory:
//   1) finalize() any curve that hit its target (or sold out) — backers never
//      wait for a human to click Graduate;
//   2) abort() any raise past its deadline below target, then push every
//      backer's refund to their wallet with refundMany() — nobody has to
//      claim. The contract only pays a backer still holding what they bought;
//      anyone it skips can still claim on the site;
//   3) deliver dividends: snapshot holders from the coin's Transfer log and
//      batch claimForMany() for everyone with pendingRewards above the
//      threshold — yield lands in wallets with no user action. claimFor can
//      only ever push a holder's rewards to the holder themselves, so this
//      keeper cannot divert a wei;
//   4) pay out last-buyer pots whose clock ran out on a pool nobody has
//      traded since (any trade would have paid it already). claimPot only
//      ever pays the pot's leader.
//   5) holders at 5x who picked a payout (ETH, the coin, USDG, a stock) are
//      collected through VenturePayouts instead of claimForMany, with a
//      minimum out 2% under a simulation taken just before sending;
//   6) fill every limit order the pool can now meet. The order book enforces
//      the owner's price itself; the keeper earns the owner's tip.
//
// Env:
//   KEEPER_PRIVATE_KEY  (required) pays gas
//   RPC_URL             (default https://rpc.testnet.chain.robinhood.com)
//   CHAIN_ID            (default 46630) picks the deployment file: 4663 ->
//                       venture-robinhood.json, 46630 -> venture-testnet.json.
//                       Must agree with RPC_URL or the run aborts; any other
//                       chain needs DEPLOYMENT_FILE.
//   DEPLOYMENT_FILE     explicit override for the above
//   MIN_DELIVER         (default 1e12 wei of the reward token)
//   RECENTER_SPACINGS   (default 10) recenter walls whose near edge drifted
//                       more than this many tick-spacings from the price
//   LOG_CHUNK           (default 100000) block span per getLogs page
//   SYNC_MAX_BLOCKS     (default unbounded) blocks of history one run indexes
//   CONFIRMATIONS       (default 3)
//   DRY_RUN             set to log intended actions without sending txs
//   MAX_SPEND_ETH       (default 0.01) gas this run may spend before it stops;
//                       bounds what a flood of spam coins can cost the treasury
//   MAX_DAILY_SPEND_ETH (default 0.02) gas all runs in a rolling 24h may spend;
//                       enforced by the Worker, which remembers earlier runs
//   DELIVER_GAS_MULT    (default 4) a payout is only pushed when it is worth at
//                       least this many times the gas it costs to push
import { cfg, loadDeployment } from "./venture-config.mjs";
import { ConfigError } from "./venture-config-core.mjs";
import { runOps } from "./venture-ops-core.mjs";

// The run itself is in venture-ops-core.mjs (shared with the Worker). An
// insolvent factory exits 2, which fails the workflow and notifies the owner.
const { dep, depPath } = loadDeployment();
runOps({ cfg, dep, depPath })
  .then((s) => { if (s.solvency.ok === false) process.exitCode = 2; })
  .catch((e) => { console.error(e instanceof ConfigError ? e.message : e); process.exit(1); });
