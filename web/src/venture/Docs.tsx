import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { factoryAbi, VENTURE, venturePc } from "./client";
import { usePageMeta } from "./seo";
import { fmtEth } from "./ui";
import { env } from "../lib/env";

const SECTIONS: [string, string][] = [
  ["launch", "Launching"],
  ["curve", "Buying on the curve"],
  ["kinds", "Two kinds of launch"],
  ["graduation", "Graduation"],
  ["fees", "Fees after graduation"],
  ["referrals", "Referrals and weekly payouts"],
  ["misses", "If a raise misses"],
  ["risks", "Risks"],
];

/** How it works, in the order someone meets it. Every number on this page is
 *  either read from the factory or mirrors a contract constant. */
export function Docs() {
  usePageMeta("How it works");
  const [p, setP] = useState<{ grad: bigint; floor: bigint; buy: number; sell: number } | null>(null);
  useEffect(() => {
    const read = (fn: "graduationRaiseWei" | "minTargetWei" | "curveBuyFeeBps" | "curveSellFeeBps") =>
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn });
    Promise.all([read("graduationRaiseWei"), read("minTargetWei"), read("curveBuyFeeBps"), read("curveSellFeeBps")])
      .then(([g, f, b, s]) => setP({ grad: g as bigint, floor: f as bigint, buy: Number(b) / 100, sell: Number(s) / 100 }))
      .catch(() => undefined);
  }, []);
  const grad = p ? `${fmtEth(p.grad, 3)} ETH` : "a set amount of ETH";
  const floor = p ? `${fmtEth(p.floor, 3)} ETH` : "the platform minimum";
  const buyFee = p ? `${p.buy}%` : "a small fee";
  const sellFee = p ? `${p.sell}%` : "a small fee";
  const platform = `${(VENTURE.platformFeeBps / 100).toFixed(2)}%`;
  const refShare = `${VENTURE.refShareBps / 100}%`;

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">How it works</h1>
        <p style={{ maxWidth: "70ch", color: "var(--dim)", fontSize: 13.5 }}>
          Every coin starts on a bonding curve and moves to its own Uniswap pool once enough ETH has gone in.
          The rules below are enforced by the contracts.
        </p>
      </div>

      <div className="dp-doc-wrap">
        <nav className="dp-toc" aria-label="Contents">
          {SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
        </nav>

        <div className="dp-doc-body dp-story">
          <H id="launch">Launching</H>
          <p>
            Launching takes one transaction. You choose a name, ticker, description and logo, pick one of the two
            kinds of launch below, and set the trading fee. Every coin has 1 billion tokens: 600 million are sold on
            the curve, up to 15% can be kept by the creator, and the rest goes into the Uniswap pool at graduation.
            The creator's tokens are locked until graduation and then released over 90 days to 2 years.
            Nothing about a coin can be changed after it launches.
          </p>

          <H id="curve">Buying on the curve</H>
          <p>
            The first token sells at a price that values the whole coin at $750, and the price rises with every token
            sold. Buying in one go or in several smaller buys costs exactly the same. Each buy pays a {buyFee} fee,
            and each sale back to the curve pays {sellFee}.
          </p>

          <H id="kinds">Two kinds of launch</H>
          <p>
            <b>Raise with a target.</b> The creator sets a target (at least {floor}) and a deadline of 1 to 14 days,
            and can take up to 30% of the raise when it succeeds. One wallet can only put in so much, so a single
            buyer can't take the whole round. Before graduation you can sell back to the curve, but for no more than
            you paid. If the target isn't reached by the deadline, everyone gets their ETH back.
          </p>
          <p>
            <b>Open curve.</b> No target and no deadline: the coin graduates once {grad} has gone in. You can sell
            back at the curve price at any time, which can be more or less than you paid. There are no refunds.
            The creator doesn't take a cut of the raise; they get 10% of the curve's fees instead.
          </p>

          <H id="graduation">Graduation</H>
          <p>
            The buy that fills the curve also creates the coin's Uniswap v4 pool, in the same transaction. The pool
            opens at the curve's last price, so the price doesn't jump. The ETH raised, less the creator's cut, and
            the unsold tokens go into the pool and stay there: no contract function can take them out. For the first
            15 seconds, trades pay an extra fee (15% for 5 seconds, then 5%), which goes into a buy wall under the
            price.
          </p>

          <H id="fees">Fees after graduation</H>
          <p>
            Each coin has a buy fee and a sell fee of 0 to 4%, set at launch. The creator chooses how it's split:
            their own wallet, payouts to people holding the coin, extra liquidity in the pool, and buy and sell
            orders kept near the price. Holder payouts are sent automatically once they're large enough to be worth
            the gas, or can be claimed from the Portfolio page. The platform charges {platform} per trade on top.
          </p>

          <H id="referrals">Referrals and weekly payouts</H>
          <p>
            If someone's first trade comes through your link, you get {refShare} of the platform fee on every trade
            they make, paid in the same transaction. Each Monday, part of the platform's income buys and burns the
            most-traded coins and goes back to the most active traders. The <Link to="/rewards" viewTransition>Rewards</Link> page
            lists every payout.
          </p>

          <H id="misses">If a raise misses</H>
          <p>
            After the deadline, anyone can close the raise, and we do it automatically. The creator's locked tokens
            are burned. Each buyer returns their tokens and gets back what they paid, less the {buyFee} buy fee,
            from the <Link to="/desk" viewTransition>Portfolio</Link> page. Refunds stay open for a year.
          </p>

          <H id="risks">Risks</H>
          <p>
            Anyone can launch a coin here, and the contracts have not been audited. Most coins lose value and many go
            to zero. Read the <Link to="/legal" viewTransition>terms</Link> before you buy.
          </p>

          <p className="dp-agate" style={{ marginTop: 24 }}>
            {env.chainName}
            {env.explorerUrl && <> · <a href={`${env.explorerUrl}/address/${VENTURE.factory}`} target="_blank" rel="noreferrer">factory contract</a></>}
          </p>
        </div>
      </div>
    </div>
  );
}

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id}>{children}<a className="dp-anchor" href={`#${id}`} aria-label="Link to this section">#</a></h2>;
}
