import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, parseEther } from "viem";

import { factoryAbi, VENTURE, venturePc } from "./client";
import { minGrossTargetEth, raiseFields, requiresTarget, targetIssue } from "./raiseMode";
import { fmtEth, fmtUsdV } from "./ui";
import { Donut, Legend, SPLIT_COLORS, type Slice } from "./charts";
import { usePageMeta } from "./seo";
import { QUIVER_TOKEN_BYTECODE } from "../lib/rh/tokenBytecode";
import { pairUsd, resolvePairRoute } from "../lib/rh/routes";
import { STOCKS } from "../lib/v4/stocks";
import { env } from "../lib/env";

// Stock-paired ventures need the self-deployed V3 stack, which exists on
// mainnet (4663) only; the testnet build keeps every pool ETH-quoted.
//
// Opt-in rather than implied by the chain. finalize() routes a completed
// raise's ETH through the V3 router to buy the pair asset before seeding the
// pool, and that hop only runs when pair != WETH — so on testnet, where
// v3Router is address(0), it cannot run at all. Tying the toggle to the chain
// id meant mainnet day one was the first time that path had ever executed,
// with real money, on the highest-value launch type offered. Turn this on
// deliberately, after the fork suite has exercised it.
const STOCK_PAIRS_ENABLED =
  env.chainId === 4663 && String(import.meta.env.VITE_VENTURE_STOCK_PAIRS ?? "") === "true";
import { errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

const TOTAL_SUPPLY = 10n ** 27n;
const CURVE_SHARE = 0.6; // 60% of supply sells on the curve
const START_FDV_USD = 750; // mirrors VentureFactory.START_MCAP_USD_8
const MIN_TARGET_ETH = 2; // mirrors VentureFactory.minTargetWei on mainnet
const MAX_RAISE_DAYS = 14; // mirrors VentureFactory.MAX_RAISE_SECS

/** Market cap (FDV) the coin opens at on Uniswap when a raise of `targetEth`
 *  fills: the linear curve's closing price. Founder cut doesn't move it. */
function gradFdvUsd(targetEth: number, ethUsd: number): number {
  return (2 * targetEth * ethUsd) / CURVE_SHARE - START_FDV_USD;
}

/** Found a startup: identity + the on-chain term sheet, in one transaction. */
export function LaunchVenture() {
  usePageMeta("Launch a coin");
  const { isConnected, connectFirst, address: me } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: "", symbol: "", pitch: "", sector: "", banner: "",
    website: "", twitter: "", telegram: "", discord: "", github: "", docs: "",
  });
  const [longDesc, setLongDesc] = useState("");
  const [minHoldInput, setMinHoldInput] = useState("10000");
  const [tiered, setTiered] = useState(false);
  const [target, setTarget] = useState("");
  const [days, setDays] = useState(7);
  const [founderCut, setFounderCut] = useState(20); // % of raise
  const [founderStake, setFounderStake] = useState(10); // % of supply
  const [vestDays, setVestDays] = useState(365);
  const [capPct, setCapPct] = useState(2); // per-wallet, % of target
  const [mode, setMode] = useState<0 | 1>(0); // 0 = funded raise, 1 = open curve
  const open = !requiresTarget(mode);
  const [chain, setChain] = useState<{ creation: bigint; grad: bigint; buyBps: number; sellBps: number; minTarget: bigint } | null>(null);
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

  // Two floors apply and the binding one is whichever is higher: the curve
  // cannot raise less than its own supply costs at the start price, and the
  // platform will not finish a raise below MIN_TARGET_ETH.
  const curveFloorEth = ethUsd > 0 ? (START_FDV_USD * CURVE_SHARE) / ethUsd : 0;
  // The platform floor binds the ETH that reaches the pool, so a founder
  // taking a cut must raise enough that the remainder still clears it. This
  // moves with the cut slider, which is the point: the coupling is visible.
  // The deployment's own floor when it is known — testnets ship it far lower
  // than mainnet, and a hardcoded 0.5 over-restricts them.
  const platformFloorEth = chain ? Number(chain.minTarget) / 1e18 : MIN_TARGET_ETH;
  const minTargetEth = minGrossTargetEth(mode, curveFloorEth, platformFloorEth, founderCut);
  const parsedTarget = useMemo(() => { try { return target ? parseEther(target) : 0n; } catch { return 0n; } }, [target]);
  const targetUsd = ethUsd > 0 && parsedTarget > 0n ? (Number(parsedTarget) / 1e18) * ethUsd : 0;
  const founderCutEth = parsedTarget > 0n ? (parsedTarget * BigInt(founderCut * 100)) / 10_000n : 0n;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) return connectFirst();
    if (!wc || !me) return;
    // Mode-aware by construction: see raiseMode.ts. An open curve has no
    // target of its own, so targetIssue() is always null there.
    const issue = targetIssue(mode, Number(target), minTargetEth);
    if (issue === "missing") return pushToast({ kind: "error", title: "Set a funding target" });
    if (issue === "below-floor") {
      // Say which of the two floors is binding, because the fix differs: one
      // is fixed by asking for more, the other by taking a smaller cut.
      const body = curveFloorEth >= minTargetEth
        ? `The minimum is about ${minTargetEth.toFixed(4)} ETH: what the curve's coins cost at its $${START_FDV_USD} starting value.`
        : founderCut > 0
          ? `Minimum is ~${minTargetEth.toFixed(4)} ETH, so ${platformFloorEth} ETH still reaches the pool after your ${founderCut}% cut. Lower the cut to ask for less.`
          : `Minimum is ${platformFloorEth} ETH.`;
      return pushToast({ kind: "error", title: `Target too low`, body });
    }
    if (allocTotal !== 100) {
      return pushToast({ kind: "error", title: "Fee split must total 100%", body: `It totals ${allocTotal}% right now.` });
    }
    setBusy(true);
    try {
      const ethUsd8 = BigInt(Math.round(ethUsd * 1e8));
      if (ethUsd8 <= 0n) throw new Error("Could not read the ETH price. Try again in a moment.");
      // The factory only accepts an ETH/USD price inside its deployed band, so
      // a launcher cannot open their own curve near zero. Check before
      // signing so the founder gets a reason instead of a bare revert. A
      // factory that predates the band has no getters; the call then fails
      // and the contract stays the only judge.
      const band = await Promise.all([
        venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "minEthUsd8" }),
        venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "maxEthUsd8" }),
      ]).catch(() => null);
      if (band && (ethUsd8 < band[0] || ethUsd8 > band[1])) {
        throw new Error(
          `The ETH price we read ($${ethUsd.toFixed(0)}) is outside the range the launchpad accepts ` +
          `($${Number(band[0] / 10n ** 8n)}–$${Number(band[1] / 10n ** 8n)}). Refresh and try again.`,
        );
      }

      const pair = (STOCK_PAIRS_ENABLED && pairMode === "stock" ? stock : VENTURE.weth) as `0x${string}`;
      let v3Path: `0x${string}` = "0x";
      if (pair.toLowerCase() !== VENTURE.weth.toLowerCase()) {
        const route = await resolvePairRoute(venturePc, pair);
        if (!route.buy || route.buy === "0x") throw new Error("No live route to that stock. Pick another.");
        v3Path = route.buy as `0x${string}`;
      }

      const metadataURI = JSON.stringify({
        description: (longDesc.trim() || form.pitch.trim()),
        pitch: form.pitch.trim(),
        sector: form.sector.trim(),
        logo: logoData,
        banner: form.banner.trim(),
        website: form.website.trim(),
        twitter: form.twitter.trim(),
        telegram: form.telegram.trim(),
        discord: form.discord.trim(),
        github: form.github.trim(),
        docs: form.docs.trim(),
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
          { type: "uint256" }, { type: "uint8" },
        ],
        [
          form.name.trim(), symbol, metadataURI, TOTAL_SUPPLY, me, VENTURE.factory, buyTaxBps, pair,
          // The deployer scales the whole-token floor; the salt must be mined
          // against the value the constructor actually receives.
          BigInt(minHold) * 10n ** 18n, divMode,
        ],
      );
      const initCodeHash = keccak256(concatHex([QUIVER_TOKEN_BYTECODE as `0x${string}`, args]));
      let salt: `0x${string}` | null = null;
      for (let i = 0n; i < 3_000_000n; i++) {
        const s = `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`;
        const addr = getContractAddress({ opcode: "CREATE2", from: VENTURE.tokenDeployer, salt: s, bytecodeHash: initCodeHash });
        // The mark counts at EITHER end — 0x2add… or 0x…2add — which halves
        // the search (two targets, same odds each) and keeps it inside the
        // visible half of a truncated address whichever way it lands.
        // viem returns a checksummed address, so these slices carry EIP-55
        // casing: require all-lower or all-upper so nothing reads 0x…2AdD.
        const head = addr.slice(2, 6);
        if (head === "2add" || head === "2ADD") { salt = s; break; }
        const tail = addr.slice(-4);
        if (tail === "2add" || tail === "2ADD") { salt = s; break; }
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
            // The four fields that differ by mode, from the one module that
            // decides that — so validation, presentation and payload cannot
            // drift apart again. See raiseMode.ts.
            ...raiseFields(mode, {
              targetWei: parsedTarget, days, capPct, founderCutPct: founderCut,
            }),
            founderSupplyBps: founderStake * 100,
            vestingSecs: founderStake > 0 ? vestDays * 86_400 : 0,
            mode,
            minHoldForDividends: BigInt(minHold),
            dividendMode: divMode,
            v3Path,
          },
          salt,
        ],
        value: chain?.creation ?? 0n,
        chain: wc.chain,
        account: wc.account,
      });
      pushToast({ kind: "info", title: "Launching…", txHash: hash });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `$${form.symbol.toUpperCase()} is live`, body: "Share the link: people can buy it now." });
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

  // What traders will compare it with, stated flatly.
  const taxMood = (t: number) =>
    t === 0 ? "No fee. Cheapest to trade, nothing to share out."
    : t <= 1.5 ? "Low. Close to what plain Uniswap pools charge."
    : t <= 2.5 ? "Typical for a launchpad coin."
    : t <= 3.5 ? "High. Active traders notice it."
    : "The maximum. Expect fewer quick flips.";

  useEffect(() => {
    const read = (fn: "creationFeeWei" | "graduationRaiseWei" | "curveBuyFeeBps" | "curveSellFeeBps" | "minTargetWei") =>
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn });
    Promise.all([read("creationFeeWei"), read("graduationRaiseWei"), read("curveBuyFeeBps"), read("curveSellFeeBps"), read("minTargetWei")])
      .then(([c, g, b, sl, mt]) =>
        setChain({ creation: c as bigint, grad: g as bigint, buyBps: Number(b), sellBps: Number(sl), minTarget: mt as bigint }))
      .catch(() => undefined);
  }, []);

  // The contract refuses a dividend floor or ladder when no fee reaches
  // holders, and refuses a ladder with no floor to be a multiple of.
  const paysDividends = alloc.dividends > 0;
  const MAX_HOLD = 10_000_000; // the deployer's cap: 1% of supply
  const minHold = paysDividends
    ? Math.max(0, Math.min(MAX_HOLD, Math.round(Number(minHoldInput) || 0)))
    : 0;
  const divMode: 0 | 1 = paysDividends && tiered && minHold > 0 ? 1 : 0;
  const cutEth = Number(founderCutEth) / 1e18;
  const avgTax = (buyTaxPct + sellTaxPct) / 2;
  const stockPick = STOCKS.find((s) => s.address === stock);
  const payoutAsset = pairMode === "stock" ? (stockPick?.symbol ?? "the quote token") : "ETH";

  const feeSlices: Slice[] = [
    { label: "You", value: alloc.dev, note: "sent to your wallet on each trade" },
    { label: "Holders", value: alloc.dividends, note: "paid out to people holding the coin" },
    { label: "Liquidity", value: alloc.liquidity, note: "added to the pool, so prices move less" },
    { label: "Market-making", value: alloc.mm, note: "buy and sell orders kept near the price" },
  ];

  const STEPS = ["Your coin", "The raise", "Trading fees", "Review"];
  const canAdvance =
    step === 0 ? form.name.trim().length > 0 && form.symbol.trim().length > 0 && form.pitch.trim().length > 0
    : step === 1 ? open || (parsedTarget > 0n && (minTargetEth === 0 || Number(target) >= minTargetEth * 0.999))
    : step === 2 ? true
    : true;

  return (
    <div className="dp-shell" style={{ paddingBottom: 70, maxWidth: 1120 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Launch a coin</h1>
        <p style={{ maxWidth: "64ch", color: "var(--dim)", fontSize: 13.5 }}>
          You can take up to 4% of every trade, and in a raise with a target, up to 30% of what it raises.
          The defaults are reasonable if you'd rather not change anything.
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
              <p className="dp-sec">Your coin</p>
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
                    <div className="dp-field"><label htmlFor="v-name">Name</label>
                      <input id="v-name" value={form.name} onChange={set("name")} placeholder="Openkernel" maxLength={32} required /></div>
                    <div className="dp-field"><label htmlFor="v-sym">Ticker</label>
                      <input id="v-sym" value={form.symbol} onChange={set("symbol")} placeholder="KERN" maxLength={8}
                        style={{ textTransform: "uppercase" }} required /></div>
                  </div>
                  <p className="dp-hint">Square works best. It's stored on-chain with the coin.</p>
                </div>
              </div>

              <div className="dp-field" style={{ marginTop: 16 }}>
                <label htmlFor="v-pitch">One-liner <span className="dp-count">{form.pitch.length}/140</span></label>
                <textarea id="v-pitch" value={form.pitch} onChange={set("pitch")} rows={2} maxLength={140}
                  placeholder="Memory-safety fuzzing lab for the mainline kernel. All findings published open." required />
                <span className="dp-hint">Shown next to the name in the coin list. Say what it is.</span>
              </div>
              <div className="dp-field"><label htmlFor="v-long">Description <span className="dp-agate">(optional)</span></label>
                <textarea id="v-long" value={longDesc} onChange={(e) => setLongDesc(e.target.value)} rows={5}
                  placeholder="What you are building, who it is for, and what the money buys." />
                <span className="dp-hint">Shown on the coin's page.</span></div>

              <p className="dp-sec" style={{ marginTop: 18 }}>Links <span className="dp-agate">(optional)</span></p>
              {/* pump.fun data: launches with Telegram, X and a site graduate
                  roughly 9–17x as often as bare ones (correlation, not a promise). */}
              <p className="dp-hint">Most buyers check for these first.</p>
              <div className="dp-field"><label htmlFor="v-sector">Sector</label>
                <input id="v-sector" value={form.sector} onChange={set("sector")} placeholder="e.g. games, AI, research" /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 16px" }}>
                <div className="dp-field"><label htmlFor="v-site">Website</label>
                  <input id="v-site" value={form.website} onChange={set("website")} placeholder="https://" /></div>
                <div className="dp-field"><label htmlFor="v-x">X / Twitter</label>
                  <input id="v-x" value={form.twitter} onChange={set("twitter")} placeholder="https://x.com/…" /></div>
                <div className="dp-field"><label htmlFor="v-tg">Telegram</label>
                  <input id="v-tg" value={form.telegram} onChange={set("telegram")} placeholder="https://t.me/…" /></div>
                <div className="dp-field"><label htmlFor="v-dc">Discord</label>
                  <input id="v-dc" value={form.discord} onChange={set("discord")} placeholder="https://discord.gg/…" /></div>
                <div className="dp-field"><label htmlFor="v-gh">GitHub</label>
                  <input id="v-gh" value={form.github} onChange={set("github")} placeholder="https://github.com/…" /></div>
                <div className="dp-field"><label htmlFor="v-docs">Docs</label>
                  <input id="v-docs" value={form.docs} onChange={set("docs")} placeholder="https://" /></div>
              </div>
              <div className="dp-field"><label htmlFor="v-banner">Cover image URL</label>
                <input id="v-banner" value={form.banner} onChange={set("banner")} placeholder="https://…/cover.jpg" />
                <span className="dp-hint">Shown across the top of the coin's page, about 1500×500. Paste a link to the image.</span></div>
            </div>
          )}

          {/* ---------------------------------------------------- step 2 */}
          {step === 1 && (
            <div className="dp-form-sheet">
              <p className="dp-sec">The raise <button type="button" className="dp-linkbtn" onClick={() => setExpertRaise(!expertRaise)}>
                {expertRaise ? "Fewer settings" : "More settings"}</button></p>

              <div className="dp-presets" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {([
                  [0, "Raise with a target", "Refund or rocket", "You set a target and a deadline. Hit it and the coin moves to Uniswap. Miss it and every buyer gets their ETH back."],
                  [1, "Open curve", "No target", "No deadline and no refunds. People can buy and sell from the start, and it moves to Uniswap when the curve fills."],
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
                  on the curve{chain && ethUsd > 0 ? ` (about ${fmtUsdV(gradFdvUsd(Number(chain.grad) / 1e18, ethUsd))} market cap)` : ""}, then locks its liquidity into the pool like any other launch. Buyers
                  can sell back to the curve at any moment, so there is no deadline to miss and no
                  refund to open. You earn from trade fees rather than a cut of a raise.
                </p>
              )}

              {/* Hidden on an open curve. `required` must track that: a required
                  control inside a display:none wrapper blocks native form submit
                  while being unfocusable, so the browser cannot report which
                  field is at fault and the button just does nothing. */}
              <div style={{ display: open ? "none" : "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div className="dp-field"><label htmlFor="v-target">How much do you want to raise?</label>
                  <input id="v-target" inputMode="decimal" value={target}
                    onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="4.0"
                    required={requiresTarget(mode)} />
                  <span className="dp-hint">
                    In ETH{targetUsd > 0 ? `, about ${fmtUsdV(targetUsd)} today` : ""}.
                    {targetUsd > 0 ? ` Graduates at about ${fmtUsdV(gradFdvUsd(Number(target), ethUsd))} market cap.` : ""}
                    {minTargetEth > 0 ? ` Minimum ${minTargetEth.toFixed(4)} ETH.` : ""}
                    {" "}Ask for what the next milestone costs: backers fund plans, not round numbers.
                  </span>
                </div>
                <div className="dp-field"><label htmlFor="v-days">How long to raise it: {days} days</label>
                  <input id="v-days" type="range" min={1} max={MAX_RAISE_DAYS} value={days} onChange={(e) => setDays(Number(e.target.value))} />
                  <span className="dp-hint">Miss the deadline and every backer takes their curve spend back, automatically.
                    Short windows create urgency; long ones give word of mouth time to work.</span></div>
              </div>

              <div className="dp-field" style={{ display: open ? "none" : undefined }}><label htmlFor="v-cut">Your cut of the raise: {founderCut}%</label>
                <input id="v-cut" type="range" min={0} max={30} value={founderCut} onChange={(e) => setFounderCut(Number(e.target.value))} />
                <span className="dp-hint">
                  {cutEth > 0 ? `${cutEth.toFixed(4)} ETH at this target. ` : ""}
                  Paid only if it hits the target. The rest goes into the locked Uniswap pool.
                </span>
              </div>

              {expertRaise && (
                <div className="dp-expert">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                    <div className="dp-field"><label htmlFor="v-stake">Coins you keep: {founderStake}% of supply</label>
                      <input id="v-stake" type="range" min={0} max={15} value={founderStake} onChange={(e) => setFounderStake(Number(e.target.value))} />
                      <span className="dp-hint">Locked until graduation, then released over the vesting period. Burned if the raise misses.</span></div>
                    <div className="dp-field"><label htmlFor="v-vest">Vesting: {vestDays} days</label>
                      <input id="v-vest" type="range" min={0} max={730} step={30} value={vestDays}
                        onChange={(e) => setVestDays(Number(e.target.value))} disabled={founderStake === 0} />
                      <span className="dp-hint">Released evenly, starting at graduation. Buyers can see the schedule.</span></div>
                    <div className="dp-field" style={{ display: open ? "none" : undefined }}><label htmlFor="v-cap">Most one wallet can put in: {capPct}% of target</label>
                      <input id="v-cap" type="range" min={1} max={100} value={capPct} onChange={(e) => setCapPct(Number(e.target.value))} />
                      <span className="dp-hint">Lower spreads the coins across more buyers. Higher fills faster.</span></div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---------------------------------------------------- step 3 */}
          {step === 2 && (
            <div className="dp-form-sheet">
              <p className="dp-sec">Trading fees</p>

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
                  ["community", "Holders first", "Half to holders", "Pays people to keep holding."],
                  ["balanced", "Balanced", "Spread across four", "A quarter to each."],
                  ["profit", "Creator first", "Most to you", "The largest share to your wallet."],
                  ["custom", "Custom", "Set it yourself", "Moving one slider rebalances the others."],
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

              {paysDividends && (
                <>
                  <p className="dp-sec" style={{ marginTop: 20 }}>ETH drip
                    <span className="dp-agate">{alloc.dividends}% of the fee drips to holders</span></p>

                  {STOCK_PAIRS_ENABLED ? (
                    <div className="dp-field"><label htmlFor="v-payout">Paid out in</label>
                      <select id="v-payout" value={pairMode} onChange={(e) => setPairMode(e.target.value as "eth" | "stock")}>
                        <option value="eth">ETH</option>
                        <option value="stock">A tokenized stock</option>
                      </select>
                      {pairMode === "stock" && (
                        <select value={stock} onChange={(e) => setStock(e.target.value)} style={{ marginTop: 8 }}>
                          {STOCKS.map((st) => <option key={st.address} value={st.address}>{st.symbol} ({st.name})</option>)}
                        </select>
                      )}
                      <span className="dp-hint">This is also your market's quote asset: holders are paid in whatever
                        your token trades against.</span></div>
                  ) : (
                    <p className="dp-hint" style={{ margin: "0 0 14px" }}>
                      Paid out in <b className="dp-up">ETH</b>, your market's quote asset.
                    </p>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                    <div className="dp-field">
                      <label htmlFor="v-minhold">Minimum ${(form.symbol || "TOKEN").toUpperCase()} to earn the ETH drip</label>
                      <input id="v-minhold" inputMode="numeric" value={minHoldInput}
                        onChange={(e) => setMinHoldInput(e.target.value.replace(/[^0-9]/g, ""))} placeholder="10000" />
                      <span className="dp-hint">
                        {minHold === 0
                          ? "Every holder earns, however small. Dust wallets cost gas to pay."
                          : `Hold at least ${minHold.toLocaleString("en-US")} ${(form.symbol || "TOKEN").toUpperCase()} to receive anything. What the wallets below the line would have earned goes to the holders above it.`}
                      </span>
                    </div>
                    <div className="dp-field">
                      <label htmlFor="v-tiered">Reward bigger holders more</label>
                      <select id="v-tiered" value={tiered ? "on" : "off"} onChange={(e) => setTiered(e.target.value === "on")}
                        disabled={minHold === 0}>
                        <option value="off">Flat: every token earns the same</option>
                        <option value="on">Tiered: larger holdings earn more per token</option>
                      </select>
                      <span className="dp-hint">
                        {minHold === 0
                          ? "Needs a minimum to be a multiple of. Set one first."
                          : divMode === 1
                          ? `10x the minimum earns 1.25x per token, 100x earns 1.5x, and 1000x earns 2x, the most. Splitting a balance across wallets lowers the multiplier.`
                          : "Turn on to pay a larger stake more per token, up to 2x."}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---------------------------------------------------- step 4 */}
          {step === 3 && (
            <div className="dp-form-sheet">
              <p className="dp-sec">Review</p>
              <div className="dp-sheet" style={{ maxWidth: "none" }}>
                <p className="dp-sec">{form.name || "Your coin"} (${(form.symbol || "TICK").toUpperCase()})</p>
                <dl>
                  <dt>Raise</dt><dd>{open
                    ? `open curve, moves to Uniswap at ${chain ? (Number(chain.grad) / 1e18).toFixed(2) : "?"} ETH, no deadline`
                    : `${target || "—"} ETH in ${days} days${targetUsd > 0 ? ` (~${fmtUsdV(targetUsd)})` : ""}`}</dd>
                  {!open && <><dt>You take</dt><dd>{founderCut}% of the raise{cutEth > 0 ? ` (${cutEth.toFixed(4)} ETH)` : ""}, only if it hits the target</dd></>}
                  <dt>Your stake</dt><dd>{founderStake}% of supply, vesting {vestDays} days from graduation</dd>
                  {!open && <><dt>Per-wallet cap</dt><dd>{capPct}% of target</dd></>}
                  <dt>Trading fee</dt><dd>{buyTaxPct}% buy / {sellTaxPct}% sell</dd>
                  <dt>Fee split</dt><dd>you {alloc.dev}%, holders {alloc.dividends}%, liquidity {alloc.liquidity}%, market-making {alloc.mm}%</dd>
                  <dt>ETH drip</dt><dd>{paysDividends
                    ? `${alloc.dividends}% of the fee, paid in ${payoutAsset}${minHold > 0
                        ? `, to wallets holding ${minHold.toLocaleString("en-US")}+ $${(form.symbol || "TICK").toUpperCase()}`
                        : ", to every holder"}${divMode === 1 ? ", tiered up to 2x for larger stakes" : ""}`
                    : "none"}</dd>
                  <dt>Description</dt><dd>{form.pitch.trim() || "none"}{longDesc.trim() ? ", plus a longer description" : ""}</dd>
                  <dt>Links</dt><dd>{[
                    ["logo", !!logoData], ["cover", !!form.banner.trim()], ["website", !!form.website.trim()],
                    ["X", !!form.twitter.trim()], ["telegram", !!form.telegram.trim()], ["discord", !!form.discord.trim()],
                    ["github", !!form.github.trim()], ["docs", !!form.docs.trim()],
                  ].filter(([, on]) => on).map(([k]) => k).join(", ") || "none"}</dd>
                  <dt>Platform fee</dt><dd>{(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade, {VENTURE.refShareBps / 100}% of that to referrers</dd>
                  <dt>Cost to launch</dt><dd>{chain && chain.creation > 0n
                    ? `${fmtEth(chain.creation, 4)} ETH to launch, plus gas`
                    : "gas only"}</dd>
                </dl>
              </div>
              <div className="dp-notice" style={{ marginTop: 14 }}>
                <h3>None of this can be changed after you launch.</h3>
                <p>That includes the name, description, logo and links. Neither you nor the platform can edit them.</p>
              </div>
              <label className="dp-confirm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I've checked the details above.</span>
              </label>
              <button className="dp-action" type="submit" disabled={busy || !confirmed} style={{ width: "100%", marginTop: 12 }}>
                {mining ? "Finding your address…" : busy ? "Confirm in wallet…" : isConnected ? "Launch" : "Connect wallet"}
              </button>
              <p className="dp-hint" style={{ textAlign: "center", marginTop: 8 }}>
                {chain && chain.creation > 0n
                  ? <><span className="dp-mono">{fmtEth(chain.creation, 4)} ETH</span> to launch, plus gas. </>
                  : <>Free to launch, gas only. </>}
                Your browser then searches for a coin address that starts or ends with{" "}
                <span className="dp-mono">2add</span>, which takes a few seconds.
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
          <p className="dp-companion-label">How it will look in the coin list</p>
          <div className="lh-list" style={{ marginTop: 0 }}>
            <div className="lh-drow" style={{ ["--cols" as string]: "minmax(0, 1.6fr) minmax(0, 1fr)", pointerEvents: "none" }}>
              <span className="lh-dname">
                <span className="dp-monogram dp-m2" style={{ padding: 0, overflow: "hidden" }}>
                  {logoData ? <img src={logoData} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : (form.name.slice(0, 1) || "?").toUpperCase()}
                </span>
                <span>
                  <b>{form.name || "Your coin"}</b>
                  <small>${(form.symbol || "TICK").toUpperCase()}{form.pitch ? ` · ${form.pitch}` : ""}</small>
                </span>
              </span>
              <span className="lh-dstage">
                <span className="lh-dmeter"><i style={{ width: "0%" }} /></span>
                <span className="lh-st">0% · {open ? (chain ? (Number(chain.grad) / 1e18).toFixed(2) : "?") : (target || "?")} ETH left</span>
              </span>
            </div>
          </div>

          <div className="dp-panel" style={{ marginTop: 12 }}>
            <div className="dp-phead"><span>What you earn</span></div>
            <div className="dp-pbody dp-earn">
              {open ? (
                <div><b className="dp-up">{(chain ? chain.sellBps / 100 : 1).toFixed(2)}%</b>
                  <span>of every sale back to the curve, then your share of trading fees on Uniswap</span></div>
              ) : (
                <div><b className="dp-up">{cutEth > 0 ? `${cutEth.toFixed(4)} ETH` : "—"}</b>
                  <span>your {founderCut}% of the {target || "?"} ETH target, paid when it hits the target</span></div>
              )}
              <div><b className="dp-up">{(avgTax * alloc.dev / 100).toFixed(2)}%</b><span>of every trade on Uniswap</span></div>
              <div><b className="dp-up">{founderStake}%</b><span>of supply, vesting {vestDays} days</span></div>
              <p className="dp-hint" style={{ marginTop: 4 }}>
                {open
                  ? "Nothing to wait for: it's paid from trading."
                  : `The other ${100 - founderCut}% goes into the Uniswap pool and is locked there.`}
              </p>
            </div>
          </div>

        </aside>
      </form>
    </div>
  );
}
