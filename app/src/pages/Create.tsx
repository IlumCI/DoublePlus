import { useState } from 'react'
import { compact } from '../data/launches'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-fog-100">{label}</span>
        {hint && <span className="text-[11px] text-fog-500">{hint}</span>}
      </span>
      <span className="mt-1.5 block">{children}</span>
    </label>
  )
}

const inputCls =
  'w-full rounded-xl bg-ink-850 px-3.5 py-2.5 font-mono text-sm text-fog-100 ring-1 ring-ink-700 outline-none transition placeholder:text-fog-500/50 focus:ring-mint-500/60'

export function Create({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [priceHype, setPriceHype] = useState('0.001')
  const [forSale, setForSale] = useState('100000000')
  const [forLiquidity, setForLiquidity] = useState('80000000')
  const [softCap, setSoftCap] = useState('40000')
  const [liquidityPct, setLiquidityPct] = useState(70)
  const [walletCap, setWalletCap] = useState('')
  const [days, setDays] = useState(3)

  const p = parseFloat(priceHype) || 0
  const sale = parseFloat(forSale) || 0
  const liq = parseFloat(forLiquidity) || 0
  const soft = parseFloat(softCap) || 0
  const hardCap = p * sale
  const softOk = soft > 0 && soft <= hardCap
  const listPrice = p // by construction: pool always lists at the sale price

  return (
    <main className="rise-in mt-6">
      <button onClick={onBack} className="cursor-pointer text-sm text-fog-500 transition hover:text-mint-300">
        ← All launches
      </button>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_340px]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create a launch</h1>
          <p className="mt-1.5 max-w-lg text-[14px] leading-relaxed text-fog-300">
            Set one flat price for the whole sale. The full supply mints straight to the launchpad —
            you never hold unsold tokens, and the LP is burned on success.
          </p>

          <section className="mt-7 space-y-7">
            <div className="rounded-2xl bg-ink-900 p-5 ring-1 ring-ink-700">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-mint-400">01 · Token</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <input className={inputCls} placeholder="Purr Network" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="Symbol">
                  <input className={inputCls} placeholder="PURR2" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
                </Field>
              </div>
            </div>

            <div className="rounded-2xl bg-ink-900 p-5 ring-1 ring-ink-700">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-mint-400">02 · Pricing & supply</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field label="Price" hint="HYPE per token">
                  <input className={inputCls} value={priceHype} onChange={(e) => setPriceHype(e.target.value)} inputMode="decimal" />
                </Field>
                <Field label="Tokens for sale">
                  <input className={inputCls} value={forSale} onChange={(e) => setForSale(e.target.value)} inputMode="numeric" />
                </Field>
                <Field label="Tokens for liquidity">
                  <input className={inputCls} value={forLiquidity} onChange={(e) => setForLiquidity(e.target.value)} inputMode="numeric" />
                </Field>
              </div>
              <p className="mt-3 font-mono text-[12px] text-fog-500">
                Hard cap = {compact(sale)} × {p || '…'} = <span className="text-fog-100">{compact(hardCap)} HYPE</span>
              </p>
            </div>

            <div className="rounded-2xl bg-ink-900 p-5 ring-1 ring-ink-700">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-mint-400">03 · Caps & window</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Field label="Soft cap" hint="HYPE">
                  <input
                    className={`${inputCls} ${soft && !softOk ? 'ring-rose-soft/60' : ''}`}
                    value={softCap}
                    onChange={(e) => setSoftCap(e.target.value)}
                    inputMode="numeric"
                  />
                </Field>
                <Field label="Wallet cap" hint="HYPE · blank = none">
                  <input className={inputCls} placeholder="unlimited" value={walletCap} onChange={(e) => setWalletCap(e.target.value)} inputMode="numeric" />
                </Field>
                <Field label="Duration">
                  <span className="flex items-center gap-2">
                    {[1, 3, 7].map((d) => (
                      <button
                        key={d}
                        onClick={() => setDays(d)}
                        className={`flex-1 cursor-pointer rounded-xl py-2.5 font-mono text-sm ring-1 transition ${
                          days === d
                            ? 'bg-mint-500/15 text-mint-300 ring-mint-500/40'
                            : 'bg-ink-850 text-fog-300 ring-ink-700 hover:text-fog-100'
                        }`}
                      >
                        {d}d
                      </button>
                    ))}
                  </span>
                </Field>
              </div>
              {soft > 0 && !softOk && (
                <p className="mt-3 text-[12px] text-rose-soft">Soft cap must be at most the hard cap ({compact(hardCap)} HYPE).</p>
              )}
            </div>

            <div className="rounded-2xl bg-ink-900 p-5 ring-1 ring-ink-700">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-mint-400">04 · Liquidity</h2>
              <Field label={`Share of raise into the pool — ${liquidityPct}%`} hint="minimum 50% · LP burned">
                <input
                  type="range"
                  min={50}
                  max={100}
                  value={liquidityPct}
                  onChange={(e) => setLiquidityPct(parseInt(e.target.value))}
                  className="w-full accent-(--color-mint-400)"
                />
              </Field>
              <div className="mt-2 flex justify-between font-mono text-[11px] text-fog-500">
                <span>50% · floor</span>
                <span>100% · fair-launch mode</span>
              </div>
            </div>
          </section>
        </div>

        {/* summary panel */}
        <aside className="h-fit rounded-2xl bg-ink-900 p-5 ring-1 ring-ink-700 lg:sticky lg:top-6">
          <h2 className="text-sm font-semibold">Launch summary</h2>
          <dl className="mt-4 space-y-3 text-[13px]">
            {[
              ['Token', name && symbol ? `${name} ($${symbol})` : '—'],
              ['Sale price', p ? `${p} HYPE · flat` : '—'],
              ['Hard cap', hardCap ? `${compact(hardCap)} HYPE` : '—'],
              ['Soft cap', soft ? `${compact(soft)} HYPE` : '—'],
              ['Supply', sale + liq ? `${compact(sale + liq)} (${compact(sale)} sale / ${compact(liq)} LP)` : '—'],
              ['Into liquidity', `${liquidityPct}% of raise`],
              ['DEX list price', p ? `${listPrice} HYPE · = sale price` : '—'],
              ['Protocol fee', '1% of raise'],
              ['Your proceeds', hardCap ? `≤ ${compact(hardCap * (1 - liquidityPct / 100 - 0.01))} HYPE` : '—'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <dt className="text-fog-500">{k}</dt>
                <dd className="text-right font-mono text-fog-100">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-5 rounded-xl bg-mint-500/8 p-3.5 text-[12px] leading-relaxed text-fog-300 ring-1 ring-mint-500/20">
            Pool tokens scale with how much of the sale fills, so the DEX always lists at exactly the
            sale price — buyers can't be instantly arbed on a partial fill.
          </div>

          <button
            disabled={!name || !symbol || !p || !softOk}
            className="mt-5 w-full cursor-pointer rounded-xl bg-mint-500 py-3 text-sm font-bold text-ink-950 transition hover:bg-mint-400 disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-fog-500"
          >
            Deploy launch
          </button>
          <p className="mt-2.5 text-center text-[11px] text-fog-500">One transaction · deploys token + opens sale</p>
        </aside>
      </div>
    </main>
  )
}
