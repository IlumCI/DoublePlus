import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, parseEther } from "viem";

import { factoryAbi, VENTURE, venturePc } from "./client";
import { fmtUsdV } from "./ui";
import { Donut, Legend, SPLIT_COLORS, type Slice } from "./charts";
import { usePageMeta } from "./seo";
import { QUIVER_TOKEN_BYTECODE } from "../lib/rh/tokenBytecode";
import { pairUsd, resolvePairRoute } from "../lib/rh/routes";
import { STOCKS } from "../lib/v4/stocks";
import { env } from "../lib/env";

// Stock-paired ventures need the self-deployed V3 stack, which exists on
// mainnet (4663) only; the testnet build keeps every pool ETH-quoted.
const STOCK_PAIRS_ENABLED = env.chainId === 4663;
import { errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

const TOTAL_SUPPLY = 10n ** 27n;
const CURVE_SHARE = 0.6; // 60% of supply sells on the curve
const START_FDV_USD = 3_000;

/** Found a startup: identity + the on-chain term sheet, in one transaction. */
export function LaunchVenture() {
  usePageMeta("Launch your idea");
  const { isConnected, connectFirst, address: me } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: "", symbol: "", pitch: "", sector: "", website: "", twitter: "" });
  const [target, setTarget] = useState("");
  const [days, setDays] = useState(7);
  const [founderCut, setFounderCut] = useState(20); // % of raise
  const [founderStake, setFounderStake] = useState(10); // % of supply
  const [vestDays, setVestDays] = useState(365);
  const [capPct, setCapPct] = useState(2); // per-wallet, % of target
  const [mode, setMode] = useState<0 | 1>(0); // 0 = funded raise, 1 = open curve
  const open = mode === 1;
  const [chain, setChain] = useState<{ creation: bigint; grad: bigint; buyBps: number; sellBps: number } | null>(null);
  const [pairMode, setPairMode] = useState<"eth" | "stock">("eth");
  const [stock, setStock] = useState<string>(STOCKS[0]?.address ?? "");
  const [buyTaxPct, setBuyTaxPct] = useState(2); // 0-4, founder trade tax on buys
  const [sellTaxPct, setSellTaxPct] = useState(3); // 0-4, on sells
  // Where the founder tax goes, in % that must total 100.
  const [alloc, setAlloc] = useState({ dev: 40, dividends: 30, liquidity: 15, mm: 15 });
  const allocTotal = alloc.dev + alloc.dividends + alloc.liquidity + alloc.mm;
  const setBucket = (k: keyof typeof alloc) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
    setAlloc((a) => ({ ...a, [k]: v }));
  };
  const [logoData, setLogoData] = useState("");
  const [busy, setBusy] = useState(false);
  const [mining, setMining] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [ethUsd, setEthUsd] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pairUsd(VENTURE.weth, venturePc)
      .then((v) => setEthUsd(v > 0 ? v : Number(VENTURE.ethUsd8Fallback) / 1e8))
      .catch(() => setEthUsd(Number(VENTURE.ethUsd8Fallback) / 1e8));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const onLogo = async (file: File) => {
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement("canvas");
      c.width = 256; c.height = 256;
      const ctx = c.getContext("2d")!;
      const side = Math.min(bmp.width, bmp.height);
      ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256);
      let out = c.toDataURL("image/webp", 0.8);
      if (out.length > 24_000) out = c.toDataURL("image/webp", 0.6);
      setLogoData(out);
    } catch {
      pushToast({ kind: "error", title: "Could not read that image" });
    }
  };

  // The curve opens at a $3k FDV, so the smallest honest target is the cost of
  // the whole curve at that floor: $1,800 worth of ETH.
  const minTargetEth = ethUsd > 0 ? (START_FDV_USD * CURVE_SHARE) / ethUsd : 0;
  const parsedTarget = useMemo(() => { try { return target ? parseEther(target) : 0n; } catch { return 0n; } }, [target]);
  const targetUsd = ethUsd > 0 && parsedTarget > 0n ? (Number(parsedTarget) / 1e18) * ethUsd : 0;
  const founderCutEth = parsedTarget > 0n ? (parsedTarget * BigInt(founderCut * 100)) / 10_000n : 0n;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) return connectFirst();
    if (!wc || !me) return;
    if (parsedTarget === 0n) return pushToast({ kind: "error", title: "Set a funding target" });
    if (minTargetEth > 0 && Number(target) < minTargetEth * 0.999) {
      return pushToast({ kind: "error", title: `Target too low`, body: `Minimum is ~${minTargetEth.toFixed(4)} ETH (the curve's $${START_FDV_USD} starting FDV).` });
    }
    if (allocTotal !== 100) {
      return pushToast({ kind: "error", title: "Fee split must total 100%", body: `It totals ${allocTotal}% right now.` });
    }
    setBusy(true);
    try {
      const ethUsd8 = BigInt(Math.round(ethUsd * 1e8));
      if (ethUsd8 <= 0n) throw new Error("Could not read the ETH price. Try again in a moment.");

      const pair = (STOCK_PAIRS_ENABLED && pairMode === "stock" ? stock : VENTURE.weth) as `0x${string}`;
      let v3Path: `0x${string}` = "0x";
      if (pair.toLowerCase() !== VENTURE.weth.toLowerCase()) {
        const route = await resolvePairRoute(venturePc, pair);
        if (!route.buy || route.buy === "0x") throw new Error("No live route to that stock. Pick another.");
        v3Path = route.buy as `0x${string}`;
      }

      const metadataURI = JSON.stringify({
        description: form.pitch.trim(),
        pitch: form.pitch.trim(),
        sector: form.sector.trim(),
        logo: logoData,
        website: form.website.trim(),
        twitter: form.twitter.trim(),
      });
      const buyTaxBps = Math.round(buyTaxPct * 100);
      const symbol = form.symbol.trim().toUpperCase();

      // Mine the CREATE2 vanity salt (token addresses end in the chain's 4663).
      setMining(true);
      await new Promise((r) => setTimeout(r, 30)); // let the UI paint
      const args = encodeAbiParameters(
        [
          { type: "string" }, { type: "string" }, { type: "string" }, { type: "uint256" },
          { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "address" },
        ],
        [form.name.trim(), symbol, metadataURI, TOTAL_SUPPLY, me, VENTURE.factory, buyTaxBps, pair],
      );
      const initCodeHash = keccak256(concatHex([QUIVER_TOKEN_BYTECODE as `0x${string}`, args]));
      let salt: `0x${string}` | null = null;
      for (let i = 0n; i < 3_000_000n; i++) {
        const s = `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`;
        const addr = getContractAddress({ opcode: "CREATE2", from: VENTURE.tokenDeployer, salt: s, bytecodeHash: initCodeHash });
        if ((BigInt(addr) & 0xffffn) === 0x4663n) { salt = s; break; }
      }
      setMining(false);
      if (!salt) throw new Error("Could not mine a launch address. Try again.");

      const hash = await wc.writeContract({
        address: VENTURE.factory,
        abi: factoryAbi,
        functionName: "launch",
        args: [
          {
            name: form.name.trim(),
            symbol,
            metadataURI,
            pair,
            buyTaxBps,
            sellTaxBps: Math.round(sellTaxPct * 100),
            devWallet: "0x0000000000000000000000000000000000000000" as const, // defaults to the founder
            devBps: alloc.dev * 100,
            dividendBps: alloc.dividends * 100,
            liquidityBps: alloc.liquidity * 100,
            mmBps: alloc.mm * 100,
            ethUsdPrice8: ethUsd8,
            // An open curve has no target of its own: the factory substitutes
            // the protocol's graduation threshold and ignores these three.
            targetRaiseWei: open ? 0n : parsedTarget,
            raiseDurationSecs: BigInt((open ? 7 : days) * 86_400),
            maxBuyWei: open ? 0n : (parsedTarget * BigInt(Math.round(capPct * 100))) / 10_000n,
            founderRaiseBps: open ? 0 : founderCut * 100,
            founderSupplyBps: founderStake * 100,
            vestingSecs: founderStake > 0 ? vestDays * 86_400 : 0,
            mode,
            v3Path,
          },
          salt,
        ],
        value: chain?.creation ?? 0n,
        chain: wc.chain,
        account: wc.account,
      });
      pushToast({ kind: "info", title: "Opening your raise…", txHash: hash });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Your raise is live", body: "The term sheet is on-chain. Go find your backers." });
      navigate("/");
    } catch (err) {
      setMining(false);
      pushToast({ kind: "error", title: "Launch failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  // --- wizard state (simple by default, expert depth on demand) -----------
  const [step, setStep] = useState(0);
  const [expertRaise, setExpertRaise] = useState(false);
  const [preset, setPreset] = useState<"community" | "balanced" | "profit" | "custom">("balanced");

  const applyPreset = (k: "community" | "balanced" | "profit" | "custom") => {
    setPreset(k);
    if (k === "community") { setBuyTaxPct(1); setSellTaxPct(2); setAlloc({ dev: 20, dividends: 50, liquidity: 15, mm: 15 }); }
    if (k === "balanced") { setBuyTaxPct(2); setSellTaxPct(3); setAlloc({ dev: 40, dividends: 30, liquidity: 15, mm: 15 }); }
    if (k === "profit") { setBuyTaxPct(3); setSellTaxPct(4); setAlloc({ dev: 60, dividends: 15, liquidity: 15, mm: 10 }); }
  };

  // Moving one slider pushes the difference onto the others in proportion, so
  // the split is always exactly 100% — there is no such thing as unallocated,
  // and any single bucket may take the whole thing.
  const BUCKETS = ["dev", "dividends", "liquidity", "mm"] as const;
  const setAllocBalanced = (key: (typeof BUCKETS)[number]) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
    const others = BUCKETS.filter((b) => b !== key);
    const rest = 100 - value;
    const othersTotal = others.reduce((a, b) => a + alloc[b], 0);
    const next = { ...alloc, [key]: value } as typeof alloc;
    if (othersTotal === 0) {
      // everything was on this bucket: spread the remainder evenly
      others.forEach((b, i) => { next[b] = Math.floor(rest / others.length) + (i < rest % others.length ? 1 : 0); });
    } else {
      others.forEach((b) => { next[b] = Math.round((alloc[b] / othersTotal) * rest); });
    }
    // absorb rounding drift into the largest of the others
    const drift = 100 - BUCKETS.reduce((a, b) => a + next[b], 0);
    if (drift !== 0) {
      const fat = others.reduce((m, b) => (next[b] > next[m] ? b : m), others[0]);
      next[fat] = Math.max(0, next[fat] + drift);
    }
    setAlloc(next);
    setPreset("custom");
  };

  const taxMood = (t: number) =>
    t === 0 ? "free to trade — pure volume play"
    : t <= 1.5 ? "barely noticed, volume stays high"
    : t <= 2.5 ? "standard for a funded project"
    : t <= 3.5 ? "chunky; your holders will want it back"
    : "steep — you will need to earn this one";

  useEffect(() => {
    const read = (fn: "creationFeeWei" | "graduationRaiseWei" | "curveBuyFeeBps" | "curveSellFeeBps") =>
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn });
    Promise.all([read("creationFeeWei"), read("graduationRaiseWei"), read("curveBuyFeeBps"), read("curveSellFeeBps")])
      .then(([c, g, b, sl]) =>
        setChain({ creation: c as bigint, grad: g as bigint, buyBps: Number(b), sellBps: Number(sl) }))
      .catch(() => undefined);
  }, []);

  const cutEth = Number(founderCutEth) / 1e18;
  const avgTax = (buyTaxPct + sellTaxPct) / 2;
  const stockPick = STOCKS.find((s) => s.address === stock);

  const feeSlices: Slice[] = [
    { label: "You", value: alloc.dev, note: "paid on every trade, forever" },
    { label: "Holders", value: alloc.dividends, note: "a reason to hold, not flip" },
    { label: "Liquidity", value: alloc.liquidity, note: "calmer chart, deeper book" },
    { label: "Market-making", value: alloc.mm, note: "always a buyer on the bid" },
  ];

  const STEPS = ["Your project", "Your raise", "How trading works", "Review"];
  const canAdvance =
    step === 0 ? form.name.trim().length > 0 && form.symbol.trim().length > 0 && form.pitch.trim().length > 0
    : step === 1 ? open || (parsedTarget > 0n && (minTargetEth === 0 || Number(target) >= minTargetEth * 0.999))
    : step === 2 ? true
    : true;

  return (
    <div className="dp-shell" style={{ paddingBottom: 70, maxWidth: 1120 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Launch your idea.</h1>
        <p style={{ maxWidth: "64ch", color: "var(--dim)", fontSize: 13.5 }}>
          Four steps, one transaction. The defaults work — change nothing and you get a sensible raise.
        </p>
      </div>

      <ol className="dp-steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? "on" : i < step ? "done" : ""}>
            <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}>
              <span className="dp-n">{i < step ? "✓" : i + 1}</span>{label}
            </button>
          </li>
        ))}
      </ol>

      <form onSubmit={submit} className="dp-wizard">
        <div>
          {/* ---------------------------------------------------- step 1 */}
          {step === 0 && (
            <div className="dp-form-sheet">
              <p className="dp-sec">Your project</p>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogo(f); }} />
                <button type="button" onClick={() => fileRef.current?.click()} className="dp-logodrop" aria-label="Upload a logo">
                  {logoData
                    ? <img src={logoData} alt="" />
                    : <span>Add<br />logo</span>}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0 16px" }}>
                    <div className="dp-field"><label htmlFor="v-name">Project name</label>
                      <input id="v-name" value={form.name} onChange={set("name")} placeholder="Openkernel" maxLength={32} required /></div>
                    <div className="dp-field"><label htmlFor="v-sym">Ticker</label>
                      <input id="v-sym" value={form.symbol} onChange={set("symbol")} placeholder="KERN" maxLength={8}
                        style={{ textTransform: "uppercase" }} required /></div>
                  </div>
                  <p className="dp-hint">Your logo is what makes the card recognisable at a glance — projects
                    without one are much easier to scroll past.</p>
                </div>
              </div>

              <div className="dp-field" style={{ marginTop: 16 }}>
                <label htmlFor="v-pitch">One-liner <span className="dp-count">{form.pitch.length}/140</span></label>
                <textarea id="v-pitch" value={form.pitch} onChange={set("pitch")} rows={2} maxLength={140}
                  placeholder="Memory-safety fuzzing lab for the mainline kernel. All findings published open." required />
                <span className="dp-hint">This is the whole pitch on the board. Say what it is and who it is for — skip the adjectives.</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 16px" }}>
                <div className="dp-field"><label htmlFor="v-sector">Sector</label>
                  <input id="v-sector" value={form.sector} onChange={set("sector")} placeholder="research · open source" />
                  <span className="dp-hint">Include “research” to file under Research.</span></div>
                <div className="dp-field"><label htmlFor="v-site">Website</label>
                  <input id="v-site" value={form.website} onChange={set("website")} placeholder="https://" /></div>
                <div className="dp-field"><label htmlFor="v-x">X / Twitter</label>
                  <input id="v-x" value={form.twitter} onChange={set("twitter")} placeholder="https://x.com/…" /></div>
              </div>
            </div>
          )}

          {/* ---------------------------------------------------- step 2 */}
          {step === 1 && (
            <div className="dp-form-sheet">
              <p className="dp-sec">Your raise <button type="button" className="dp-linkbtn" onClick={() => setExpertRaise(!expertRaise)}>
                {expertRaise ? "hide expert settings" : "expert settings"}</button></p>

              <div className="dp-presets" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {([
                  [0, "Funded raise", "Ask for an amount", "Hit the target and the money is yours. Miss it and backers take theirs back — nobody is stuck."],
                  [1, "Open curve", "Trade from second one", "No target, no deadline. It graduates on its own once the curve fills."],
                ] as const).map(([m, title, line, why]) => (
                  <button type="button" key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                    <b>{title}</b>
                    <span className="dp-mono">{line}</span>
                    <span>{why}</span>
                  </button>
                ))}
              </div>

              {open && (
                <p className="dp-hint" style={{ margin: "2px 0 14px" }}>
                  An open curve graduates at{" "}
                  <b className="dp-up">{chain ? `${(Number(chain.grad) / 1e18).toFixed(2)} ETH` : "the protocol threshold"}</b>{" "}
                  on the curve, then locks its liquidity into the pool like any other launch. Buyers
                  can sell back to the curve at any moment, so there is no deadline to miss and no
                  refund to open. You earn from trade fees rather than a cut of a raise.
                </p>
              )}

              <div style={{ display: open ? "none" : "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div className="dp-field"><label htmlFor="v-target">How much do you want to raise?</label>
                  <input id="v-target" inputMode="decimal" value={target}
                    onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="5.0" required />
                  <span className="dp-hint">
                    In ETH{targetUsd > 0 ? ` — about ${fmtUsdV(targetUsd)} today` : ""}.
                    {minTargetEth > 0 ? ` Minimum ${minTargetEth.toFixed(4)} ETH.` : ""}
                    {" "}Ask for what the next milestone costs: backers fund plans, not round numbers.
                  </span>
                </div>
                <div className="dp-field"><label htmlFor="v-days">How long to raise it? — {days} days</label>
                  <input id="v-days" type="range" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} />
                  <span className="dp-hint">Miss the deadline and every backer takes their curve spend back, automatically.
                    Short windows create urgency; long ones give word of mouth time to work.</span></div>
              </div>

              <div className="dp-field" style={{ display: open ? "none" : undefined }}><label htmlFor="v-cut">How much of the raise do you take? — {founderCut}%</label>
                <input id="v-cut" type="range" min={0} max={30} value={founderCut} onChange={(e) => setFounderCut(Number(e.target.value))} />
                <span className="dp-hint">
                  {cutEth > 0 ? `${cutEth.toFixed(4)} ETH at this target. ` : ""}
                  Paid only if the raise succeeds; the rest becomes locked liquidity for your market.
                  Backers read this number as how much you need versus how much you want — under 20% reads as confident.
                </span>
              </div>

              {expertRaise && (
                <div className="dp-expert">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                    <div className="dp-field"><label htmlFor="v-stake">Your token stake — {founderStake}%</label>
                      <input id="v-stake" type="range" min={0} max={15} value={founderStake} onChange={(e) => setFounderStake(Number(e.target.value))} />
                      <span className="dp-hint">Your upside if the project works. It burns if the raise fails.</span></div>
                    <div className="dp-field"><label htmlFor="v-vest">Vesting — {vestDays} days</label>
                      <input id="v-vest" type="range" min={0} max={730} step={30} value={vestDays}
                        onChange={(e) => setVestDays(Number(e.target.value))} disabled={founderStake === 0} />
                      <span className="dp-hint">Unlocks linearly from graduation. Longer vesting is the cheapest
                        credibility you can buy — it tells the market you cannot dump on it.</span></div>
                    <div className="dp-field" style={{ display: open ? "none" : undefined }}><label htmlFor="v-cap">Per-wallet cap — {capPct}% of target</label>
                      <input id="v-cap" type="range" min={1} max={100} value={capPct} onChange={(e) => setCapPct(Number(e.target.value))} />
                      <span className="dp-hint">Stops one wallet taking the whole round and controlling your market
                        afterwards. Low caps spread the cap table; high caps fill faster.</span></div>
                    {STOCK_PAIRS_ENABLED && (
                      <div className="dp-field"><label htmlFor="v-pair">Quote asset</label>
                        <select id="v-pair" value={pairMode} onChange={(e) => setPairMode(e.target.value as "eth" | "stock")}>
                          <option value="eth">ETH — the default market</option>
                          <option value="stock">A tokenized stock — holders earn it instead</option>
                        </select>
                        {pairMode === "stock" && (
                          <select value={stock} onChange={(e) => setStock(e.target.value)} style={{ marginTop: 8 }}>
                            {STOCKS.map((s) => <option key={s.address} value={s.address}>{s.symbol} — {s.name}</option>)}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---------------------------------------------------- step 3 */}
          {step === 2 && (
            <div className="dp-form-sheet">
              <p className="dp-sec">How trading works</p>

              {/* the fee dials — always visible, always yours */}
              <div className="dp-dials">
                <div className="dp-dial dp-is-buy">
                  <span className="dp-dial-k">Buy fee</span>
                  <div className="dp-dial-row">
                    <button type="button" onClick={() => setBuyTaxPct(Math.max(0, +(buyTaxPct - 0.25).toFixed(2)))} aria-label="Lower buy fee">−</button>
                    <b>{buyTaxPct.toFixed(2)}<em>%</em></b>
                    <button type="button" onClick={() => setBuyTaxPct(Math.min(4, +(buyTaxPct + 0.25).toFixed(2)))} aria-label="Raise buy fee">+</button>
                  </div>
                  <input type="range" min={0} max={4} step={0.25} value={buyTaxPct}
                    onChange={(e) => setBuyTaxPct(Number(e.target.value))} aria-label="Buy fee" />
                  <span className="dp-dial-n">a 1 ETH buy pays {(buyTaxPct / 100).toFixed(4)} ETH</span>
                </div>
                <div className="dp-dial dp-is-sell">
                  <span className="dp-dial-k">Sell fee</span>
                  <div className="dp-dial-row">
                    <button type="button" onClick={() => setSellTaxPct(Math.max(0, +(sellTaxPct - 0.25).toFixed(2)))} aria-label="Lower sell fee">−</button>
                    <b>{sellTaxPct.toFixed(2)}<em>%</em></b>
                    <button type="button" onClick={() => setSellTaxPct(Math.min(4, +(sellTaxPct + 0.25).toFixed(2)))} aria-label="Raise sell fee">+</button>
                  </div>
                  <input type="range" min={0} max={4} step={0.25} value={sellTaxPct}
                    onChange={(e) => setSellTaxPct(Number(e.target.value))} aria-label="Sell fee" />
                  <span className="dp-dial-n">a 1 ETH sell pays {(sellTaxPct / 100).toFixed(4)} ETH</span>
                </div>
              </div>
              <p className="dp-mood">{taxMood((buyTaxPct + sellTaxPct) / 2)}</p>

              {/* where that fee lands */}
              <p className="dp-sec" style={{ marginTop: 20 }}>Where the fee goes</p>
              <div className="dp-presets">
                {([
                  ["community", "Community-focus", "Half to holders", "Rewards holding. Stickier cap table."],
                  ["balanced", "Balanced", "Spread across four", "What most projects ship."],
                  ["profit", "Profit-focus", "Most to your wallet", "Maximum runway."],
                  ["custom", "Custom", "You decide", "Move a slider, the rest rebalances."],
                ] as const).map(([k, title, line, why]) => (
                  <button type="button" key={k} className={preset === k ? "on" : ""} onClick={() => applyPreset(k)}>
                    <b>{title}</b>
                    <span className="dp-mono">{line}</span>
                    <span>{why}</span>
                  </button>
                ))}
              </div>

              <div className="dp-chartrow" style={{ marginTop: 4 }}>
                <Donut slices={feeSlices} center={`${avgTax.toFixed(1)}%`} sub="avg fee" animate={false} />
                {/* The mixer below lists the same four buckets with the same
                    colours and the same numbers, so the legend only earns its
                    place when the mixer is closed. */}
                {preset !== "custom" && <div style={{ flex: 1, minWidth: 220 }}><Legend slices={feeSlices} /></div>}
              </div>

              {preset === "custom" && (
                <div className="dp-expert">
                  <p className="dp-hint" style={{ marginBottom: 10 }}>
                    Always adds to 100%. Push one to 100 and it takes everything.
                  </p>
                  <div className="dp-mixer">
                    {([["dev", "You"], ["dividends", "Holders"], ["liquidity", "Liquidity"], ["mm", "Market-making"]] as const).map(([k, label], i) => (
                      <div key={k}>
                        <span className="dp-who"><i style={{ background: SPLIT_COLORS[i] }} />{label}</span>
                        <input type="range" min={0} max={100} step={1} value={alloc[k]}
                          onChange={setAllocBalanced(k)} aria-label={label} />
                        <span className="dp-amt">{alloc[k]}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---------------------------------------------------- step 4 */}
          {step === 3 && (
            <div className="dp-form-sheet">
              <p className="dp-sec">Review <span className="dp-agate">this is what goes on-chain</span></p>
              <div className="dp-sheet" style={{ maxWidth: "none" }}>
                <p className="dp-sec">{form.name || "Your project"} (${(form.symbol || "TICK").toUpperCase()})</p>
                <dl>
                  <dt>Raising</dt><dd>{target || "—"} ETH in {days} days{targetUsd > 0 ? ` (~${fmtUsdV(targetUsd)})` : ""}</dd>
                  <dt>You take</dt><dd>{founderCut}% of the raise{cutEth > 0 ? ` — ${cutEth.toFixed(4)} ETH` : ""}, on success only</dd>
                  <dt>Your stake</dt><dd>{founderStake}% of supply, vesting {vestDays} days from graduation</dd>
                  <dt>Per-wallet cap</dt><dd>{capPct}% of target</dd>
                  <dt>Trading fee</dt><dd>{buyTaxPct}% buy / {sellTaxPct}% sell</dd>
                  <dt>Fee split</dt><dd>dev {alloc.dev} · holders {alloc.dividends} · liquidity {alloc.liquidity} · market-making {alloc.mm}</dd>
                  <dt>Protocol fee</dt><dd>{(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade, {VENTURE.refShareBps / 100}% of it to referrers</dd>
                </dl>
              </div>
              <div className="dp-notice" style={{ marginTop: 14 }}>
                <h3>These numbers are permanent.</h3>
                <p>The factory writes them into your token and the pool hook at graduation. Nobody can change them
                  afterwards — not you, not the protocol. Your name, pitch, logo and links stay editable.</p>
              </div>
              <label className="dp-confirm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I have read the terms above and understand they cannot be changed.</span>
              </label>
              <button className="dp-action" type="submit" disabled={busy || !confirmed} style={{ width: "100%", marginTop: 12 }}>
                {mining ? "Mining your address…" : busy ? "Confirm in wallet…" : isConnected ? "Launch — one transaction" : "Connect wallet"}
              </button>
              <p className="dp-hint" style={{ textAlign: "center", marginTop: 8 }}>
                Free to launch, gas only. Your token address is mined in your browser to end in{" "}
                <span className="dp-mono">0x4663</span>.
              </p>
            </div>
          )}

          {step < 3 && (
            <div className="dp-wizard-nav">
              {step > 0 && <button type="button" className="dp-action dp-ghost" onClick={() => setStep(step - 1)}>Back</button>}
              <span style={{ flex: 1 }} />
              <button type="button" className="dp-action" disabled={!canAdvance} onClick={() => setStep(step + 1)}>
                Continue
              </button>
            </div>
          )}
        </div>

        {/* live preview + the teaching companion */}
        <aside className="dp-companion">
          <p className="dp-mono dp-companion-label">YOUR CARD ON THE BOARD</p>
          <div className="dp-tcard" style={{ pointerEvents: "none" }}>
            <div className="dp-row1">
              <span className="dp-monogram dp-m2" style={{ padding: 0, overflow: "hidden" }}>
                {logoData ? <img src={logoData} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : (form.name.slice(0, 1) || "?").toUpperCase()}
              </span>
              <div style={{ minWidth: 0 }}>
                <h3>{form.name || "Your project"}</h3>
                <span className="dp-tick">${(form.symbol || "TICK").toUpperCase()}{form.sector ? ` · ${form.sector}` : ""}</span>
              </div>
              <span style={{ marginLeft: "auto" }}>
                <span className={open ? "dp-badge dp-open" : "dp-badge dp-live"}>{open ? "open curve" : "live"}</span>
              </span>
            </div>
            {form.pitch && <p className="dp-pitch">{form.pitch}</p>}
            <div className="dp-curvebar" style={{ ["--pct" as string]: "0%" }}><i /></div>
            <div className="dp-curvelabel">
              <span><b>0%</b> to graduation</span>
              <span>0 / {open ? (chain ? (Number(chain.grad) / 1e18).toFixed(2) : "—") : (target || "—")} ETH</span>
            </div>
            <div className="dp-prov">
              <span>by <b>you</b> · just now</span>
              <span>{open ? "fees only" : `founder takes ${founderCut}%`}</span>
            </div>
          </div>

          <div className="dp-panel" style={{ marginTop: 12 }}>
            <div className="dp-phead"><span>What you earn</span></div>
            <div className="dp-pbody dp-earn">
              {open ? (
                <div><b className="dp-up">{(chain ? chain.sellBps / 100 : 1).toFixed(2)}%</b>
                  <span>of every curve exit, plus your cut of the pool fee once it graduates</span></div>
              ) : (
                <div><b className="dp-up">{cutEth > 0 ? `${cutEth.toFixed(4)} ETH` : "—"}</b>
                  <span>your {founderCut}% of the {target || "—"} ETH backers put in, paid at graduation</span></div>
              )}
              <div><b className="dp-up">{(avgTax * alloc.dev / 100).toFixed(2)}%</b><span>of every trade, forever</span></div>
              <div><b className="dp-up">{founderStake}%</b><span>of supply, vesting {vestDays} days</span></div>
              <p className="dp-hint" style={{ marginTop: 4 }}>
                {open
                  ? "Paid out of trading, not out of a raise — there is nothing to wait for."
                  : `The other ${100 - founderCut}% becomes your pool's locked liquidity.`}
              </p>
            </div>
          </div>

          <div className="dp-panel" style={{ marginTop: 12 }}>
            <div className="dp-phead"><span>Why this matters</span></div>
            <div className="dp-pbody dp-teach">
              {step === 0 && <p>Backers scan dozens of cards. A real logo, a short name and one concrete sentence
                are what make yours stop the scroll — the rest of your story lives on the project page.</p>}
              {step === 1 && (open
                ? <p>Early buyers pay less, so momentum builds itself. An open curve lives or dies on attention:
                    there is no deadline forcing the issue, and no refund if it stalls.</p>
                : <p>Early backers pay less, so momentum builds itself. All-or-nothing: ask for a number you can hit.</p>)}
              {step === 2 && <p>This fee runs forever. More to holders, they hold. More to you, more runway.</p>}
              {step === 3 && <p>Last look. The contract enforces every number here, and nobody can edit it later.</p>}
            </div>
          </div>
        </aside>
      </form>
    </div>
  );
}
