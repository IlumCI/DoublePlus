import { useState } from "react";
import { Link } from "react-router-dom";

import { VENTURE } from "./client";
import { BRAND } from "../lib/brand";
import { env } from "../lib/env";

/** How it works: the mechanism, in the order a founder or backer meets it. */
export function Docs() {
  const [density, setDensity] = useState("standard");
  const size = density === "compact" ? 13 : density === "large" ? 17 : 14.5;
  const lh = density === "compact" ? 1.45 : density === "large" ? 1.7 : 1.6;

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">How it works</h1>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 26px", alignItems: "baseline", justifyContent: "space-between" }}>
          <p style={{ maxWidth: "58ch", margin: "6px 0 0", color: "var(--dim)", fontSize: 13 }}>
            {BRAND.name} funds startups and research projects at day zero by issuing a decentralized,
            security-style stock against the idea. Five steps, all on-chain.
          </p>
          <label className="dp-mono" style={{ fontSize: 11, color: "var(--dim)" }}>
            TEXT SIZE{" "}
            <select value={density} onChange={(e) => setDensity(e.target.value)}>
              <option value="standard">standard</option>
              <option value="compact">compact</option>
              <option value="large">large</option>
            </select>
          </label>
        </div>
      </div>

      <div className="dp-doc-grid">
        <div className="dp-story" style={{ fontSize: size, lineHeight: lh }}>
          <h2>1 · Launch</h2>
          <p>
            One transaction deploys the project's token and opens a funding round on a rising price curve: the
            earlier a backer commits, the cheaper the entry. The founder sets the full terms up front — target,
            their cut of the raise (up to 30%), their vested stake (up to 15%, unlocking linearly only after
            success), the deadline and the per-wallet cap. Terms are public before anyone buys and locked after
            deployment; nobody can amend them, the founder included.
          </p>

          <h2>2 · Fund</h2>
          <p>
            Backers buy along the curve in plain ETH. Pricing is the exact integral of the curve, so splitting
            an order or sniping the first block gains nothing, and the per-wallet cap stops any single buyer
            cornering the round.
          </p>

          <h2>3 · Graduate</h2>
          <p>
            When the target is reached, anyone can trigger graduation: the founder's declared cut pays out as
            funding, and everything else — remaining supply and remaining ETH — becomes protocol-managed
            liquidity in a Uniswap V4 pool. Trading opens immediately and the curve closes forever.
          </p>

          <h2>4 · Earn</h2>
          <p>
            The fee policy set at launch runs on-chain: separate buy and sell taxes (0–4% each), split in any
            proportion across four destinations — the dev wallet; ETH dividends pushed to every holder;
            auto-liquidity locked beside the price; and a market-making engine that quotes both sides, a bid wall
            under the price and an ask band above it, re-centered automatically when the market moves. Trades in
            the first seconds after graduation pay a decaying premium that also funds those walls. The protocol
            adds {(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade and pays {VENTURE.refShareBps / 100}% of
            that to referrers.
          </p>

          <h2>5 · Compound</h2>
          <p>
            Share any page with a <span className="dp-mono">?ref=</span> link: a wallet that trades through it
            pays you {VENTURE.refShareBps / 100}% of the protocol fee on every trade it ever makes, settled in
            the same transaction. Weekly, the flywheel returns a slice of protocol revenue as buyback-burns,
            trader rebates and LP rewards, each epoch published as a{" "}
            <Link to="/rewards" viewTransition>verifiable manifest</Link>. Dividends deliver every 15 minutes,
            raises graduate themselves at target, and refunds open themselves at the deadline — no admin in the loop.
          </p>

          <h2>6 · If a raise fails</h2>
          <p>
            Miss the deadline below target and the round fails safe: the founder allocation burns and every
            backer reclaims their full spend by returning their tokens. All or nothing, enforced by the contract
            rather than by anyone's good intentions.
          </p>

          <details className="dp-dossier" style={{ marginTop: 26 }}>
            <summary>Risks and disclaimers</summary>
            <div className="dp-body" style={{ fontSize: 13 }}>
              These are open, freely-transferable tokens whose economics resemble equity — a funded raise, a
              vested founder stake, dividend-paying trading fees. They are not registered securities, carry no
              legal claim on any company, and the contracts are unaudited. Liquidity is protocol-managed, not
              burned. The weekly reward split is treasury policy v1: transparent in the manifests, not yet
              contract-enforced. Back only what you can afford to lose.
            </div>
          </details>
          <details className="dp-dossier">
            <summary>For research projects specifically</summary>
            <div className="dp-body" style={{ fontSize: 13 }}>
              Research output is a public good, which is exactly why it struggles to raise: the value it creates
              cannot be fenced off and sold. Here the instrument is the lab, not the output — backers hold a
              stock in the project and are paid from its trading fee flow, while the findings themselves stay
              open. Tag your sector with the word “research” and the raise files under the Research filter on the
              board.
            </div>
          </details>
          <details className="dp-dossier">
            <summary>Quick start for founders</summary>
            <div className="dp-body" style={{ fontSize: 13 }}>
              Go to <Link to="/launch" viewTransition>Create</Link>. Fill in the idea, set a target you can
              actually reach, keep the fee split at 100%, and deploy. The token address is mined in your browser
              to end in <span className="dp-mono">0x4663</span> before you sign.
            </div>
          </details>
        </div>

        <aside>
          <p className="dp-mono" style={{ fontSize: 10.5, letterSpacing: ".1em", color: "var(--faint)" }}>KEY NUMBERS</p>
          <p>Buy/sell tax: 0–4% each, founder-set, locked at launch.</p>
          <p>Protocol fee: {(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade; {VENTURE.refShareBps / 100}% of it to referrers.</p>
          <p>Founder cut: up to 30% of the raise, paid only on graduation.</p>
          <p>Founder stake: up to 15% of supply, vesting linearly; burns if the raise fails.</p>
          <p>Dividends: pushed automatically every 15 minutes.</p>
          <p>Failed raises: 100% refunds, no deadline.</p>
          <p style={{ marginTop: 14 }}>
            Network: {env.chainName}
            {env.explorerUrl && <> · <a href={env.explorerUrl} target="_blank" rel="noreferrer">explorer ↗</a></>}
          </p>
          <p className="dp-mono" style={{ fontSize: 10.5, wordBreak: "break-all", color: "var(--faint)" }}>
            factory {VENTURE.factory}
          </p>
        </aside>
      </div>
    </div>
  );
}
