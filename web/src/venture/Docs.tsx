import { Link } from "react-router-dom";

import { VENTURE } from "./client";
import { usePageMeta } from "./seo";
import { BRAND } from "../lib/brand";
import { env } from "../lib/env";

const SECTIONS: [string, string][] = [
  ["launch", "1 · Launch"],
  ["fund", "2 · Fund"],
  ["graduate", "3 · Graduate"],
  ["earn", "4 · Earn"],
  ["compound", "5 · Compound"],
  ["fails", "If a raise misses"],
  ["compare", "How this differs"],
  ["risks", "Risks"],
];

/** How it works: the mechanism, in the order a founder or backer meets it. */
export function Docs() {
  usePageMeta("How it works");
  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">How it works</h1>
        <p style={{ maxWidth: "70ch", color: "var(--dim)", fontSize: 13.5 }}>
          {BRAND.name} turns an idea into a funded project with a real market behind it. Five steps, all enforced
          by contracts rather than by anyone's promises.
        </p>
      </div>

      <div className="dp-doc-wrap">
        <nav className="dp-toc" aria-label="Contents">
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </nav>

        <div className="dp-doc-body dp-story">
          <Figure />

          <H id="launch">1 · Launch</H>
          <p>
            One transaction deploys the project's token and opens a funding round on a rising price curve: the
            earlier a backer commits, the cheaper their entry. The founder sets the terms up front — target,
            their cut of the raise (up to 30%), their vested stake (up to 15%), the deadline and the per-wallet
            cap. Those terms are public before anyone buys and locked after deployment. Nobody can amend them,
            the founder included.
          </p>

          <H id="fund">2 · Fund</H>
          <p>
            Backers buy along the curve in plain ETH. Pricing is the exact integral of the curve, so splitting an
            order or sniping the first block gains nothing, and the per-wallet cap stops a single buyer cornering
            the round and controlling the market that follows.
          </p>

          <H id="graduate">3 · Graduate</H>
          <p>
            When the target is reached, anyone can trigger graduation. The founder's declared cut pays out as
            funding and everything else — the remaining supply and the remaining ETH — becomes protocol-managed
            liquidity in a Uniswap V4 pool. Trading opens immediately, the curve closes forever, and the
            liquidity stays locked.
          </p>

          <H id="earn">4 · Earn</H>
          <p>
            The fee policy set at launch runs on-chain: separate buy and sell fees of up to 4% each, split in any
            proportion across four destinations — the founder's wallet; ETH paid to every holder; auto-liquidity
            locked beside the price; and a market-making engine that quotes both sides of the book and re-centres
            as the price moves. Trades in the first seconds after graduation pay a decaying premium that funds
            those walls, so snipers pay for the depth everyone else trades against. The protocol adds{" "}
            {(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade and pays {VENTURE.refShareBps / 100}% of that
            to whoever referred the trader.
          </p>

          <H id="compound">5 · Compound</H>
          <p>
            Share any page with a <span className="dp-mono">?ref=</span> link and a wallet that trades through it
            pays you {VENTURE.refShareBps / 100}% of the protocol fee on every trade it ever makes, settled in the
            same transaction. Weekly, a slice of protocol revenue returns as buyback-burns, trader rebates and LP
            rewards, each epoch published as a{" "}
            <Link to="/rewards" viewTransition>manifest you can check</Link>. Holder payouts run every 15 minutes,
            raises graduate themselves at target, and refunds open themselves at the deadline.
          </p>

          <H id="fails">If a raise misses</H>
          <p>
            It fails safe. The founder's allocation burns and every backer reclaims their full spend by returning
            their tokens — no vote, no discretion, no waiting on anyone's goodwill. All or nothing is the whole
            point: a founder who cannot convince the market does not walk away with its money.
          </p>

          <H id="compare">How this differs from a memecoin launchpad</H>
          <div className="dp-compare">
            <div className="dp-row dp-head"><span>Typical launchpad</span><span>{BRAND.name}</span></div>
            <div className="dp-row"><span>A name, a ticker and a curve</span><span>A term sheet written on-chain before anyone buys</span></div>
            <div className="dp-row"><span>Raise fails, funds are gone</span><span>Raise misses target, everyone is refunded in full</span></div>
            <div className="dp-row"><span>Creator can exit at any time</span><span>Founder stake vests, and burns entirely if the raise fails</span></div>
            <div className="dp-row"><span>Fees mostly to the platform</span><span>Founder-set split; holders can take the largest share</span></div>
            <div className="dp-row"><span>Liquidity at the deployer's mercy</span><span>Locked at graduation, market-made on both sides by the protocol</span></div>
          </div>

          <H id="risks">Risks</H>
          <p>
            These are open ERC-20 tokens whose economics resemble equity — a funded raise, a vested founder stake,
            fee income for holders — but they are not registered securities and carry no legal claim on any
            company. Holder income comes from trading fees, not company revenue. The contracts are unaudited.
            After a raise succeeds the founder's cut is theirs, and only the vested stake remains time-locked.
            Back what you can afford to lose.
          </p>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 22 }}>
            <Link className="dp-action" to="/launch" viewTransition>Launch your idea</Link>
            <Link className="dp-action dp-ghost" to="/" viewTransition>Browse raises</Link>
          </div>

          <p className="dp-agate" style={{ marginTop: 20 }}>
            Running on {env.chainName}
            {env.explorerUrl && <> · <a href={env.explorerUrl} target="_blank" rel="noreferrer">explorer ↗</a></>}
            {" "}· factory <span className="dp-mono">{VENTURE.factory}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id}>{children}<a className="dp-anchor" href={`#${id}`} aria-label="Link to this section">#</a></h2>;
}

/** The mechanism in one picture, because the prose version needs six. */
function Figure() {
  const stages: [string, string][] = [
    ["Launch", "terms locked on-chain"],
    ["Raise", "curve price rises"],
    ["Graduate", "liquidity locks"],
    ["Trade", "fees split four ways"],
  ];
  return (
    <figure className="dp-figure">
      <svg viewBox="0 0 700 168" width="100%" role="img" aria-label="Launch, raise, graduate, trade — with refunds if the target is missed, and fees splitting to founder, holders, liquidity and market making.">
        {stages.map(([label, sub], i) => {
          const x = 8 + i * 176;
          return (
            <g key={label}>
              <rect x={x} y={26} width={150} height={52} rx={10} fill="var(--panel-2)" stroke="var(--line-2)" />
              <text x={x + 75} y={50} textAnchor="middle" fill="var(--text)" fontSize="14" fontFamily="var(--body)" fontWeight="700">{label}</text>
              <text x={x + 75} y={67} textAnchor="middle" fill="var(--dim)" fontSize="10.5" fontFamily="var(--mono)">{sub}</text>
              {i < stages.length - 1 && (
                <path d={`M${x + 152} 52 h18`} stroke="var(--up)" strokeWidth="2" markerEnd="url(#dp-arrow)" />
              )}
            </g>
          );
        })}
        <defs>
          <marker id="dp-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 L7 3.5 L0 7 z" fill="var(--up)" />
          </marker>
        </defs>
        <path d="M258 78 v22 h-150 v-22" stroke="var(--down)" strokeWidth="1.5" fill="none" strokeDasharray="4 3" />
        <text x="183" y="116" textAnchor="middle" fill="var(--down)" fontSize="10.5" fontFamily="var(--mono)">misses target → everyone refunded</text>
        {["founder", "holders", "liquidity", "market-making"].map((d, i) => (
          <text key={d} x={545} y={100 + i * 16} textAnchor="middle" fill="var(--dim)" fontSize="10.5" fontFamily="var(--mono)">↳ {d}</text>
        ))}
      </svg>
      <figcaption>Every stage is triggered by the contract, not by an operator.</figcaption>
    </figure>
  );
}
