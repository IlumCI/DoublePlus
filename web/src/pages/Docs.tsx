import { BRAND } from "../lib/brand";
import { addresses, env } from "../lib/env";
import { explorerAddr, shortAddr } from "../lib/format";

/**
 * Product documentation: how launches, trading, fees and protection work,
 * plus the verified protocol contracts. Typography-first, no dashboard.
 */
export function DocsPage() {
  const contracts: { name: string; address: string; note: string }[] = [
    { name: "LaunchpadFactory", address: addresses.factory, note: "Launches, trading, fee accounting, and owns every V3 position" },
    { name: "TokenDeployer", address: addresses.tokenDeployer, note: "Deploys every token with fixed rules" },
    { name: "WETH", address: addresses.weth, note: "Canonical wrapped native token" },
  ];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-[28px] font-semibold tracking-tight text-ink">Docs</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        Everything on {BRAND.name} runs on-chain on {env.chainName}. This page explains the fixed
        protocol rules.
      </p>

      <Section title="Launching">
        <p>
          Launching is free; you pay only gas. One transaction deploys your token, creates a real
          Uniswap V3 pool at the 1% fee tier, seeds it with the full supply, and opens trading
          immediately. Optionally include an initial buy in the same transaction.
        </p>
        <Facts
          rows={[
            ["Total supply", "1,000,000,000 (fixed)"],
            ["Starting market cap", "$2,000 (fixed)"],
            ["Upfront liquidity", "None required"],
          ]}
        />
      </Section>

      <Section title="Trading and fees">
        <p>
          Every buy and sell through {BRAND.name} pays a flat 1% fee. It is not pushed on each trade;
          it accrues inside the protocol and splits 80% to the token creator and 20% to the
          platform. The creator claims their share anytime from their token's page, straight to
          their wallet. Trades executed directly against the pool (bots, aggregators) pay the
          pool's 1% Uniswap fee instead.
        </p>
        <Facts
          rows={[
            ["Trading fee", "1% fixed"],
            ["Creator share", "80%, claimable"],
            ["Platform share", "20%"],
          ]}
        />
      </Section>

      <Section title="Contracts">
        <p>All protocol contracts are source-verified on Blockscout.</p>
        <div className="mt-3 space-y-2">
          {contracts.map((c) => (
            <div
              key={c.name}
              className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{c.name}</p>
                <p className="truncate text-xs text-ink-3">{c.note}</p>
              </div>
              {explorerAddr(c.address) ? (
                <a
                  href={explorerAddr(c.address)!}
                  target="_blank"
                  rel="noreferrer"
                  className="tnum shrink-0 text-xs font-medium text-ink underline underline-offset-2"
                >
                  {shortAddr(c.address)}
                </a>
              ) : (
                <span className="tnum shrink-0 text-xs text-ink-2">{shortAddr(c.address)}</span>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-6 text-ink-2">{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="mt-3 space-y-1.5 border-l-2 border-accent pl-4">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-4 text-sm">
          <dt className="text-ink-3">{k}</dt>
          <dd className="tnum text-right font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
