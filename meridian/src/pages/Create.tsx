import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/store";
import { Icon } from "../components/Icon";
import { Toggle } from "../components/ui";
import { WalletModal } from "../components/wallet";

const STEPS = ["Basics", "Tokenomics", "Liquidity", "Review", "Deploy"];

const COLORS = ["#22C55E", "#4C7DF0", "#8B6EF3", "#F59E0B", "#E879F9", "#34D399", "#60A5FA", "#94A3B8"];

interface Form {
  name: string;
  ticker: string;
  description: string;
  color: string;
  website: string;
  twitter: string;
  telegram: string;
  supply: string;
  tax: string;
  maxTx: string;
  maxWallet: string;
  limitsOn: boolean;
  fairLaunch: boolean;
  firstBuy: string;
}

const INITIAL: Form = {
  name: "",
  ticker: "",
  description: "",
  color: COLORS[0],
  website: "",
  twitter: "",
  telegram: "",
  supply: "1,000,000,000",
  tax: "1",
  maxTx: "2",
  maxWallet: "2",
  limitsOn: true,
  fairLaunch: true,
  firstBuy: "0",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

function ReviewRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="row between" style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: "0.9rem" }}>
      <span className="muted">{k}</span>
      <span style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}

export function Create() {
  const navigate = useNavigate();
  const { wallet, chain, toast } = useApp();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(INITIAL);
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const canNext =
    step === 0
      ? form.name.trim().length >= 2 && /^[A-Z0-9]{2,8}$/.test(form.ticker)
      : true;

  const deploy = () => {
    setDeploying(true);
    setTimeout(() => {
      setDeploying(false);
      setDeployed(true);
      toast({
        kind: "success",
        title: `${form.ticker} is live`,
        body: `Pool created on ${chain.name} — trading is open`,
      });
    }, 2200);
  };

  return (
    <div className="page container" style={{ maxWidth: 760 }}>
      <h1 className="h1" style={{ marginBottom: 4 }}>Create token</h1>
      <p className="muted" style={{ fontSize: "0.9rem", marginBottom: 26 }}>
        One transaction deploys the token, creates the pool and opens trading. Launching costs only gas.
      </p>

      {/* Progress indicator ---------------------------------------------- */}
      <div className="wizard-steps">
        {STEPS.map((label, i) => (
          <div key={label} style={{ display: "contents" }}>
            <div className={`wizard-step${i === step ? " current" : ""}${i < step ? " done" : ""}`}>
              <span className="wizard-dot">
                {i < step ? <Icon name="check" size={13} strokeWidth={2.6} /> : i + 1}
              </span>
              <span className="wizard-label">{label}</span>
            </div>
            {i < STEPS.length - 1 && <span className={`wizard-line${i < step ? " done" : ""}`} />}
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 26 }}>
        {/* Step 1 — Basics ------------------------------------------------ */}
        {step === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="grid-2">
              <Field label="Token name" hint="2–32 characters">
                <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="North Star" />
              </Field>
              <Field label="Ticker" hint="2–8 uppercase letters or digits">
                <input
                  className="input mono"
                  value={form.ticker}
                  onChange={(e) => set({ ticker: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) })}
                  placeholder="NORTH"
                />
              </Field>
            </div>
            <Field label="Description" hint="Shown on the token page and explore cards.">
              <textarea
                className="input"
                value={form.description}
                onChange={(e) => set({ description: e.target.value })}
                placeholder="What is this token about?"
              />
            </Field>
            <Field label="Logo color">
              <div className="row gap-2 wrap">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    aria-label={`Color ${c}`}
                    onClick={() => set({ color: c })}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      background: c,
                      border: form.color === c ? "2px solid #fff" : "2px solid transparent",
                      transition: "transform var(--t-fast) var(--ease)",
                      transform: form.color === c ? "scale(1.08)" : "none",
                    }}
                  />
                ))}
                <span
                  className="token-icon"
                  style={{ width: 34, height: 34, borderRadius: 10, fontSize: 12, background: form.color, color: "#090B10", marginLeft: 8 }}
                >
                  {(form.ticker || "??").slice(0, 2)}
                </span>
              </div>
            </Field>
            <div className="grid-3">
              <Field label="Website (optional)">
                <input className="input" value={form.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://" />
              </Field>
              <Field label="X (optional)">
                <input className="input" value={form.twitter} onChange={(e) => set({ twitter: e.target.value })} placeholder="@handle" />
              </Field>
              <Field label="Telegram (optional)">
                <input className="input" value={form.telegram} onChange={(e) => set({ telegram: e.target.value })} placeholder="t.me/" />
              </Field>
            </div>
          </div>
        )}

        {/* Step 2 — Tokenomics ------------------------------------------- */}
        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="grid-2">
              <Field label="Total supply" hint="Fixed at launch. No mint function.">
                <input className="input mono" value={form.supply} readOnly />
              </Field>
              <Field label="Trade fee" hint="Paid to you on every trade.">
                <div className="row gap-2">
                  <input className="input mono" value={form.tax} readOnly style={{ width: 90 }} />
                  <span className="muted">%</span>
                </div>
              </Field>
            </div>
            <div className="card inner" style={{ padding: 16 }}>
              <div className="row between">
                <div>
                  <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>Anti-whale limits</div>
                  <div className="muted" style={{ fontSize: "0.82rem", marginTop: 2 }}>
                    Max transaction and max wallet caps until graduation.
                  </div>
                </div>
                <Toggle on={form.limitsOn} onChange={(v) => set({ limitsOn: v })} label="Anti-whale limits" />
              </div>
              {form.limitsOn && (
                <div className="grid-2" style={{ marginTop: 14 }}>
                  <Field label="Max transaction" hint="% of supply">
                    <input className="input mono" value={form.maxTx} onChange={(e) => set({ maxTx: e.target.value })} />
                  </Field>
                  <Field label="Max wallet" hint="% of supply">
                    <input className="input mono" value={form.maxWallet} onChange={(e) => set({ maxWallet: e.target.value })} />
                  </Field>
                </div>
              )}
            </div>
            <div className="card inner row between" style={{ padding: 16 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>Fair launch</div>
                <div className="muted" style={{ fontSize: "0.82rem", marginTop: 2 }}>
                  No team allocation, no pre-sale. The full supply seeds the pool.
                </div>
              </div>
              <Toggle on={form.fairLaunch} onChange={(v) => set({ fairLaunch: v })} label="Fair launch" />
            </div>
          </div>
        )}

        {/* Step 3 — Liquidity -------------------------------------------- */}
        {step === 2 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="card inner" style={{ padding: 16 }}>
              <div className="row gap-2" style={{ marginBottom: 8 }}>
                <Icon name="droplet" size={16} className="" />
                <span style={{ fontWeight: 600, fontSize: "0.92rem" }}>Protocol-managed liquidity</span>
              </div>
              <p className="muted" style={{ fontSize: "0.85rem", lineHeight: 1.6 }}>
                The full supply is seeded single-sided into a concentrated liquidity pool at a
                $2K starting market cap. You pay no upfront liquidity — buyers fill the pool as
                price discovers. Liquidity is protocol-managed, not locked or burned.
              </p>
            </div>
            <div className="grid-2">
              <Field label="Launch network">
                <div className="input row between" style={{ cursor: "default" }}>
                  <span className="row gap-2">
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: chain.color }} />
                    {chain.name}
                  </span>
                  <span className="faint" style={{ fontSize: "0.78rem" }}>from network selector</span>
                </div>
              </Field>
              <Field label="Starting market cap">
                <input className="input mono" value="$2,000" readOnly />
              </Field>
            </div>
            <Field label="Optional first buy (USD)" hint="Buy the first tokens in the same transaction, before anyone else.">
              <input
                className="input mono"
                value={form.firstBuy}
                onChange={(e) => set({ firstBuy: e.target.value.replace(/[^0-9.]/g, "") })}
              />
            </Field>
          </div>
        )}

        {/* Step 4 — Review ----------------------------------------------- */}
        {step === 3 && (
          <div>
            <div className="row gap-3" style={{ marginBottom: 16 }}>
              <span className="token-icon" style={{ width: 44, height: 44, borderRadius: 13, fontSize: 15, background: form.color, color: "#090B10" }}>
                {form.ticker.slice(0, 2)}
              </span>
              <div>
                <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{form.name}</div>
                <div className="faint" style={{ fontSize: "0.84rem" }}>{form.ticker} · {chain.name}</div>
              </div>
            </div>
            <ReviewRow k="Total supply" v={`${form.supply} ${form.ticker}`} />
            <ReviewRow k="Trade fee" v={`${form.tax}% → creator`} />
            <ReviewRow k="Anti-whale limits" v={form.limitsOn ? `${form.maxTx}% tx · ${form.maxWallet}% wallet, until graduation` : "Off"} />
            <ReviewRow k="Fair launch" v={form.fairLaunch ? "Yes — no team allocation" : "No"} />
            <ReviewRow k="Starting market cap" v="$2,000" />
            <ReviewRow k="Graduation threshold" v="$40,000 — limits lift automatically" />
            <ReviewRow k="First buy" v={Number(form.firstBuy) > 0 ? `$${form.firstBuy}` : "None"} />
            <div className="row between" style={{ padding: "8px 0", fontSize: "0.9rem" }}>
              <span className="muted">Cost to launch</span>
              <span style={{ fontWeight: 600, color: "var(--accent)" }}>Gas only</span>
            </div>
          </div>
        )}

        {/* Step 5 — Deploy ----------------------------------------------- */}
        {step === 4 && (
          <div style={{ textAlign: "center", padding: "18px 0 8px" }}>
            {deployed ? (
              <>
                <span style={{ display: "inline-flex", padding: 15, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent)" }}>
                  <Icon name="check" size={30} strokeWidth={2.4} />
                </span>
                <h3 className="h3" style={{ marginTop: 16 }}>{form.ticker} is live</h3>
                <p className="muted" style={{ marginTop: 8, fontSize: "0.9rem", maxWidth: 380, marginInline: "auto" }}>
                  Token deployed, pool created and trading opened on {chain.name} in a single transaction.
                </p>
                <div className="row gap-2" style={{ justifyContent: "center", marginTop: 22 }}>
                  <button className="btn btn-primary" onClick={() => navigate("/")}>View on Explore</button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setForm(INITIAL);
                      setStep(0);
                      setDeployed(false);
                    }}
                  >
                    Launch another
                  </button>
                </div>
              </>
            ) : deploying ? (
              <>
                <span className="spin" style={{ color: "var(--accent)", display: "inline-flex" }}>
                  <Icon name="spinner" size={34} strokeWidth={2} />
                </span>
                <h3 className="h3" style={{ marginTop: 16 }}>Deploying {form.ticker}…</h3>
                <p className="muted" style={{ marginTop: 8, fontSize: "0.9rem" }}>
                  Creating token · initializing pool · opening trading
                </p>
              </>
            ) : (
              <>
                <span style={{ display: "inline-flex", padding: 15, borderRadius: "50%", background: "var(--surface-2)", color: "var(--text-2)" }}>
                  <Icon name="rocket" size={28} />
                </span>
                <h3 className="h3" style={{ marginTop: 16 }}>Ready to deploy</h3>
                <p className="muted" style={{ marginTop: 8, fontSize: "0.9rem", maxWidth: 380, marginInline: "auto" }}>
                  Your wallet will ask you to sign one transaction on {chain.name}.
                </p>
                <button className="btn btn-primary btn-lg" style={{ marginTop: 22 }} disabled={!wallet} onClick={wallet ? deploy : undefined}>
                  <Icon name="rocket" size={17} />
                  Deploy {form.ticker}
                </button>
                {!wallet && (
                  <div style={{ marginTop: 12 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setWalletOpen(true)}>
                      Connect a wallet first
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Wizard nav ------------------------------------------------------- */}
      {step < 4 && (
        <div className="row between" style={{ marginTop: 18 }}>
          <button className="btn btn-ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>
            Back
          </button>
          <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>
            {step === 3 ? "Continue to deploy" : "Continue"}
            <Icon name="send" size={15} />
          </button>
        </div>
      )}
      {step === 4 && !deploying && !deployed && (
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={() => setStep(3)}>
            Back to review
          </button>
        </div>
      )}

      <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
    </div>
  );
}
