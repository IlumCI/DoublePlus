import { useState } from 'react'
import { compact, hardCapOf, price, type Launch } from '../data/launches'
import { ProgressBar } from '../components/ProgressBar'
import { StatusBadge } from '../components/StatusBadge'

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-ink-850/80 px-4 py-3 ring-1 ring-ink-700">
      <p className="text-[11px] font-medium uppercase tracking-wide text-fog-500">{label}</p>
      <p className="mt-1 font-mono text-sm font-semibold text-fog-100">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-fog-500">{sub}</p>}
    </div>
  )
}

export function LaunchDetail({ launch, onBack }: { launch: Launch; onBack: () => void }) {
  const [amount, setAmount] = useState('')
  const hardCap = hardCapOf(launch)
  const pct = Math.min(100, (launch.raised / hardCap) * 100)
  const softMet = launch.raised >= launch.softCap
  const hype = parseFloat(amount) || 0
  const tokensOut = hype / launch.priceHype

  return (
    <main className="rise-in mt-6">
      <button onClick={onBack} className="cursor-pointer text-sm text-fog-500 transition hover:text-mint-300">
        ← All launches
      </button>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* left column */}
        <div>
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-ink-800 text-3xl ring-1 ring-ink-600">
              {launch.emoji}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight">{launch.name}</h1>
                <StatusBadge status={launch.status} />
              </div>
              <p className="mt-1 font-mono text-sm text-fog-500">
                ${launch.symbol} · by {launch.creator}
              </p>
            </div>
          </div>

          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-fog-300">{launch.tagline}</p>

          {/* raise progress */}
          <div className="mt-8 rounded-2xl bg-ink-900 p-5 ring-1 ring-ink-700">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-mono text-sm text-fog-300">
                <span className="text-xl font-bold text-fog-100">{compact(launch.raised)}</span> / {compact(hardCap)} HYPE
                raised
              </p>
              <p className="font-mono text-sm text-fog-500">
                {launch.buyers.toLocaleString()} buyers ·{' '}
                {launch.startsIn
                  ? `starts in ${launch.startsIn}`
                  : launch.endsIn
                    ? `ends in ${launch.endsIn}`
                    : `ended ${launch.endedAgo}`}
              </p>
            </div>
            <div className="mt-4">
              <ProgressBar launch={launch} tall />
            </div>
            <div className="mt-2.5 flex justify-between font-mono text-[11px] text-fog-500">
              <span className={softMet ? 'text-mint-400' : ''}>
                soft cap {compact(launch.softCap)} {softMet ? '✓ reached' : ''}
              </span>
              <span>{pct.toFixed(1)}% of hard cap</span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Price" value={`${price(launch.priceHype)} HYPE`} sub="flat for everyone" />
            <Stat label="For sale" value={compact(launch.tokensForSale)} sub={`+ ${compact(launch.tokensForLiquidity)} to LP`} />
            <Stat label="To liquidity" value={`${launch.liquidityBps / 100}%`} sub="of raise · LP burned" />
            <Stat
              label="Wallet cap"
              value={launch.maxBuyPerWallet ? `${compact(launch.maxBuyPerWallet)} HYPE` : 'None'}
              sub="per address"
            />
          </div>

          {/* settlement explainer */}
          <div className="mt-6 rounded-2xl bg-ink-900/60 p-5 ring-1 ring-ink-700">
            <h2 className="text-sm font-semibold text-fog-100">How this sale settles</h2>
            <ol className="mt-3 space-y-2.5 text-[13px] leading-relaxed text-fog-300">
              <li className="flex gap-2.5">
                <span className="font-mono text-mint-400">1</span> Everyone buys at {price(launch.priceHype)} HYPE — no
                curve, no early-buyer edge.
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono text-mint-400">2</span> Soft cap reached → {launch.liquidityBps / 100}% of the
                raise pairs into the DEX pool at the sale price. LP tokens are burned: liquidity locked forever.
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono text-mint-400">3</span> Soft cap missed → every buyer refunds their full
                contribution. Nobody is exit liquidity.
              </li>
            </ol>
          </div>
        </div>

        {/* right column: action panel */}
        <aside className="h-fit rounded-2xl bg-ink-900 p-5 ring-1 ring-ink-700 lg:sticky lg:top-6">
          {launch.status === 'live' && (
            <>
              <h2 className="text-sm font-semibold">Buy ${launch.symbol}</h2>
              <label className="mt-4 block rounded-xl bg-ink-850 p-4 ring-1 ring-ink-700 focus-within:ring-mint-500/60">
                <span className="flex justify-between text-[11px] font-medium uppercase tracking-wide text-fog-500">
                  <span>You pay</span>
                  <span>balance 1,204 HYPE</span>
                </span>
                <span className="mt-1.5 flex items-center gap-2">
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.0"
                    inputMode="decimal"
                    className="w-full bg-transparent font-mono text-2xl font-semibold text-fog-100 outline-none placeholder:text-fog-500/50"
                  />
                  <span className="rounded-lg bg-ink-700 px-2.5 py-1 font-mono text-sm font-semibold text-mint-300">
                    HYPE
                  </span>
                </span>
              </label>

              <div className="my-3 flex justify-center">
                <span className="rounded-full bg-ink-850 p-1.5 font-mono text-xs text-fog-500 ring-1 ring-ink-700">↓</span>
              </div>

              <div className="rounded-xl bg-ink-850 p-4 ring-1 ring-ink-700">
                <span className="text-[11px] font-medium uppercase tracking-wide text-fog-500">You receive</span>
                <p className="mt-1.5 font-mono text-2xl font-semibold text-fog-100">
                  {tokensOut ? compact(tokensOut) : '0.0'}{' '}
                  <span className="text-sm text-mint-300">{launch.symbol}</span>
                </p>
              </div>

              <button
                disabled={!hype}
                className="mt-4 w-full cursor-pointer rounded-xl bg-mint-500 py-3 text-sm font-bold text-ink-950 transition hover:bg-mint-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-fog-500"
              >
                {hype ? `Buy at ${price(launch.priceHype)} HYPE / ${launch.symbol}` : 'Enter an amount'}
              </button>

              <p className="mt-3 text-center text-[11px] leading-relaxed text-fog-500">
                Same price as every other buyer. Overpayment past any cap is refunded in the same transaction.
              </p>

              {launch.yourContribution > 0 && (
                <div className="mt-4 rounded-xl bg-mint-500/8 p-3.5 text-[13px] ring-1 ring-mint-500/20">
                  <span className="text-fog-300">Your position</span>
                  <p className="mt-1 font-mono text-fog-100">
                    {compact(launch.yourContribution)} HYPE → {compact(launch.yourTokens)} {launch.symbol}
                  </p>
                </div>
              )}
            </>
          )}

          {launch.status === 'upcoming' && (
            <div className="py-2 text-center">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-amber-glow">Sale opens in</p>
              <p className="mt-2 font-mono text-3xl font-bold">{launch.startsIn}</p>
              <p className="mt-3 text-[13px] leading-relaxed text-fog-500">
                Price is locked at {price(launch.priceHype)} HYPE per {launch.symbol}. Being early earns nothing —
                buy whenever you like.
              </p>
              <button className="mt-5 w-full cursor-pointer rounded-xl bg-ink-800 py-3 text-sm font-semibold text-fog-100 ring-1 ring-ink-600 transition hover:ring-mint-500/50">
                Remind me
              </button>
            </div>
          )}

          {launch.status === 'succeeded' && (
            <div className="py-2 text-center">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-mint-400">Sale funded ✓</p>
              <p className="mt-3 text-[13px] leading-relaxed text-fog-300">
                Liquidity deployed and LP burned. Claim your tokens below.
              </p>
              <div className="mt-4 rounded-xl bg-ink-850 p-4 ring-1 ring-ink-700">
                <span className="text-[11px] uppercase tracking-wide text-fog-500">Claimable</span>
                <p className="mt-1 font-mono text-2xl font-semibold">
                  {compact(launch.yourTokens)} <span className="text-sm text-mint-300">{launch.symbol}</span>
                </p>
              </div>
              <button className="mt-4 w-full cursor-pointer rounded-xl bg-mint-500 py-3 text-sm font-bold text-ink-950 transition hover:bg-mint-400">
                Claim tokens
              </button>
            </div>
          )}

          {launch.status === 'failed' && (
            <div className="py-2 text-center">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-rose-soft">Soft cap missed</p>
              <p className="mt-3 text-[13px] leading-relaxed text-fog-300">
                This sale didn't reach its soft cap, so every contribution is refundable in full.
              </p>
              <div className="mt-4 rounded-xl bg-ink-850 p-4 ring-1 ring-ink-700">
                <span className="text-[11px] uppercase tracking-wide text-fog-500">Your refund</span>
                <p className="mt-1 font-mono text-2xl font-semibold">
                  {compact(launch.yourContribution)} <span className="text-sm text-rose-soft">HYPE</span>
                </p>
              </div>
              <button className="mt-4 w-full cursor-pointer rounded-xl bg-rose-soft/90 py-3 text-sm font-bold text-ink-950 transition hover:bg-rose-soft">
                Refund HYPE
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}
