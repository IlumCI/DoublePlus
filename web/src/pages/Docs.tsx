import { BRAND } from "../lib/brand";
import { env } from "../lib/env";
import { addresses } from "../lib/env";
import { v4Client } from "../lib/client";
import { explorerAddr, shortAddr } from "../lib/format";

const IS_RH = String(import.meta.env.VITE_PROTOCOL ?? "") === "rh-v4";

/**
 * Product documentation: how launches, trading, fees and protection work,
 * plus the protocol contracts. Typography-first, no dashboard.
 */
export function DocsPage() {
  return IS_RH ? <CopairDocs /> : <LegacyDocs />;
}

/** Pair=reward launchpad docs (Robinhood Chain). */
function CopairDocs() {
  const rh = v4Client.v4;
  const contracts: { name: string; address: string; note: string }[] = [
    { name: "Factory", address: rh.factory, note: "Launches, pools, and the $3k single-sided seed" },
    { name: "Hook", address: rh.hook, note: "Skims the 1% fee, runs the weekly burn flywheel and trader rewards" },
    { name: "Router", address: rh.router, note: "One-tap ETH buys and sells, auto-routed through the pair" },
    { name: "Uniswap V4 PoolManager", address: rh.poolManager, note: "Official singleton that holds every pool" },
  ];

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-[24px] font-bold tracking-tight text-ink">Docs</h1>
      <p className="mt-1.5 text-sm text-ink-2">
        {BRAND.name} is a launchpad on {env.chainName} where every trade feeds a weekly burn
        and reward cycle. Every rule below is enforced by immutable contracts, not by policy.
      </p>

      <TermSection title="The 1% fee" sub="Split four ways">
        <p>
          Every coin pairs with ETH and every trade pays a flat 1% fee. The hook skims it
          inside the pool itself, so it applies to all trades, including bots and aggregators.
          It is split automatically:
        </p>
        <Facts
          rows={[
            ["Burn pot", "25% · buys and burns the weekly top 3"],
            ["Traders", "30% · weekly ETH claims, pro-rata"],
            ["Deployer", "20% · lifetime fee stream"],
            ["Platform", "25% · runs the site and keeper"],
          ]}
        />
      </TermSection>

      <TermSection title="Launching" sub="One transaction">
        <p>
          Launching is free, you pay only gas. One transaction deploys the token, opens a
          Uniswap V4 pool against ETH, seeds the entire supply, and starts trading. You can
          attach an initial buy to the same transaction: it fills before anyone else can
          trade and never pays the sniper rate.
        </p>
        <Facts
          rows={[
            ["Total supply", "1,000,000,000, fixed"],
            ["Starting market cap", "≈ $3,000"],
            ["Upfront liquidity", "None required"],
            ["Initial buy", "Optional, atomic"],
          ]}
        />
      </TermSection>

      <TermSection title="Trading" sub="Sniper tax">
        <p>
          Buys and sells are one tap in plain ETH through the coin's own pool. Brand new
          coins cost snipers extra: 15% in the first 5 seconds, 5% until second 15, then the
          flat 1% forever. Nobody keeps the premium. It goes straight to the burn pot.
        </p>
      </TermSection>

      <TermSection title="The weekly burn" sub="7 day clock">
        <p>
          Weeks run on a fixed on-chain clock. All week, every trade adds to two ledgers:
          each coin's volume, which ranks the burn leaderboard, and each trader's volume,
          which sizes their reward share.
        </p>
        <p>
          When the week closes, anyone can fire the burn: the pot market-buys the top 3
          coins by volume and burns them on the spot. Our keeper fires it automatically if
          nobody beats it to it.
        </p>
        <Facts
          rows={[
            ["Week length", "7 days, on-chain"],
            ["Top 3 share", "50% / 30% / 20%"],
            ["Who can trigger", "Anyone"],
          ]}
        />
      </TermSection>

      <TermSection title="Getting paid" sub="Claims, not promises">
        <p>
          Traders: when a week closes, your ETH share unlocks on your Profile, sized by your
          share of that week's volume. Past weeks stay claimable forever.
        </p>
        <p>
          Deployers: your 20% stream accrues from every trade of your coin. Claim it any
          time from your coin's page or your Profile.
        </p>
      </TermSection>

      <TermSection title="Contracts" sub="Immutable">
        <p>
          The hook has no owner: the factory and treasury addresses are burned in at deploy
          and can never be redirected. Nobody can change the fee split, pause your coin, or
          touch your pool. The burn and trader pots are controlled by code alone.
        </p>
        <div className="mt-3 space-y-2">
          {contracts.map((c) => (
            <ContractRow key={c.name} {...c} />
          ))}
        </div>
      </TermSection>
    </div>
  );
}

/** Terminal-chrome docs section: titled header strip over a bordered panel. */
function TermSection({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 border border-edge bg-panel">
      <div className="term-head">
        {title}
        {sub ? <span className="term-head-sub">{sub}</span> : null}
      </div>
      <div className="term-body space-y-3 text-sm leading-6 text-ink-2">{children}</div>
    </section>
  );
}

/** Original creator-fee launchpad docs (Stable / Arc flavors). */
function LegacyDocs() {
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
            ["Starting market cap", "$5,000 (fixed)"],
            ["Upfront liquidity", "None required"],
          ]}
        />
      </Section>

      <Section title="Trading and fees">
        <p>
          Every buy and sell through a {BRAND.name} pool pays the token's trade tax, a rate the
          creator picks at launch, from 0% to 10%. The tax is skimmed on the pool itself, so it
          applies to every trade, including ones routed directly by bots or aggregators.
        </p>
        <Facts
          rows={[
            ["Trade tax", "0–10%, set by creator"],
            ["Holders", "50% · paid as the creator's chosen stock"],
            ["Creator", "25% · WETH, claimable"],
            ["Protocol", "25% · WETH"],
          ]}
        />
      </Section>

      <Section title="Contracts">
        <p>All protocol contracts are on Blockscout.</p>
        <div className="mt-3 space-y-2">
          {contracts.map((c) => (
            <ContractRow key={c.name} {...c} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function ContractRow({ name, address, note }: { name: string; address: string; note: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-3.5 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{name}</p>
        <p className="truncate text-xs text-ink-3">{note}</p>
      </div>
      {explorerAddr(address) ? (
        <a
          href={explorerAddr(address)!}
          target="_blank"
          rel="noreferrer"
          className="tnum shrink-0 text-xs font-medium text-ink underline underline-offset-2"
        >
          {shortAddr(address)}
        </a>
      ) : (
        <span className="tnum shrink-0 text-xs text-ink-2">{shortAddr(address)}</span>
      )}
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
