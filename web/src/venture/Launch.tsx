import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, parseEther } from "viem";

import { factoryAbi, VENTURE, venturePc } from "./client";
import { fmtUsdV } from "./ui";
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
            targetRaiseWei: parsedTarget,
            raiseDurationSecs: BigInt(days * 86_400),
            maxBuyWei: (parsedTarget * BigInt(Math.round(capPct * 100))) / 10_000n,
            founderRaiseBps: founderCut * 100,
            founderSupplyBps: founderStake * 100,
            vestingSecs: founderStake > 0 ? vestDays * 86_400 : 0,
            v3Path,
          },
          salt,
        ],
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

  const stockPick = STOCKS.find((s) => s.address === stock);
  const cutEth = Number(founderCutEth) / 1e18;

  return (
    <div className="dp-shell" style={{ paddingBottom: 70, maxWidth: 1080 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Raise day-zero funding.</h1>
        <p style={{ maxWidth: "62ch", color: "var(--dim)", fontSize: 13 }}>
          For a startup or a research project: one transaction issues your security-style stock and opens an
          all-or-nothing raise on a rising price curve. Everything you set below is written on-chain where your
          backers read it — and locked there forever. You earn <b className="dp-up">a share of every trade, forever</b>.
        </p>
      </div>

      <form onSubmit={submit} className="dp-create-grid">
        <div>
          {/* 1 · the idea */}
          <div className="dp-form-sheet">
            <p className="dp-sec">The idea <span className="dp-agate">this is what backers see first</span></p>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogo(f); }} />
              <button type="button" onClick={() => fileRef.current?.click()} aria-label="Upload logo"
                className="dp-monogram dp-lg" style={{ border: "1px dashed var(--line-2)", overflow: "hidden", padding: 0 }}>
                {logoData
                  ? <img src={logoData} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  : <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--bg)" }}>logo</span>}
              </button>
              <div style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0 16px" }}>
                <div className="dp-field"><label htmlFor="v-name">Name</label>
                  <input id="v-name" value={form.name} onChange={set("name")} placeholder="Openkernel" maxLength={32} required /></div>
                <div className="dp-field"><label htmlFor="v-sym">Ticker</label>
                  <input id="v-sym" value={form.symbol} onChange={set("symbol")} placeholder="KERN" maxLength={8}
                    style={{ textTransform: "uppercase" }} required /></div>
              </div>
            </div>
            <div className="dp-field" style={{ marginTop: 14 }}><label htmlFor="v-pitch">One-liner</label>
              <textarea id="v-pitch" value={form.pitch} onChange={set("pitch")} rows={2}
                placeholder="Memory-safety fuzzing lab for the mainline kernel. All findings published open." required /></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0 16px" }}>
              <div className="dp-field"><label htmlFor="v-sector">Sector</label>
                <input id="v-sector" value={form.sector} onChange={set("sector")} placeholder="research · open source" /></div>
              <div className="dp-field"><label htmlFor="v-site">Website</label>
                <input id="v-site" value={form.website} onChange={set("website")} placeholder="https://" /></div>
              <div className="dp-field"><label htmlFor="v-x">X / Twitter</label>
                <input id="v-x" value={form.twitter} onChange={set("twitter")} placeholder="https://x.com/…" /></div>
            </div>
            <p className="dp-agate">Write “research” in the sector and your raise files under the Research filter on the board.</p>
          </div>

          {/* 2 · the raise */}
          <details className="dp-adv" open style={{ marginTop: 12 }}>
            <summary>Raise — target {target || "—"} ETH · {days} days · you take {founderCut}%</summary>
            <div className="dp-body">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div className="dp-field"><label htmlFor="v-target">Funding target (ETH)</label>
                  <input id="v-target" inputMode="decimal" value={target}
                    onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="5.0" required />
                  <span className="dp-hint">
                    {targetUsd > 0 ? `≈ ${fmtUsdV(targetUsd)}` : ""}{minTargetEth > 0 ? ` · minimum ${minTargetEth.toFixed(4)} ETH` : ""}
                  </span>
                </div>
                <div className="dp-field"><label htmlFor="v-days">Deadline: {days} days</label>
                  <input id="v-days" type="range" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} />
                  <span className="dp-hint">all-or-nothing — miss it and every backer is refunded in full</span></div>
                <div className="dp-field"><label htmlFor="v-cut">Your funding: {founderCut}% of the raise</label>
                  <input id="v-cut" type="range" min={0} max={30} value={founderCut} onChange={(e) => setFounderCut(Number(e.target.value))} />
                  <span className="dp-hint">{cutEth > 0 ? `${cutEth.toFixed(4)} ETH at this target` : "paid only on graduation"}</span></div>
                <div className="dp-field"><label htmlFor="v-stake">Your stake: {founderStake}% of supply</label>
                  <input id="v-stake" type="range" min={0} max={15} value={founderStake} onChange={(e) => setFounderStake(Number(e.target.value))} />
                  <span className="dp-hint">burns if the raise fails</span></div>
                <div className="dp-field"><label htmlFor="v-vest">Vesting: {vestDays} days</label>
                  <input id="v-vest" type="range" min={0} max={730} step={30} value={vestDays}
                    onChange={(e) => setVestDays(Number(e.target.value))} disabled={founderStake === 0} />
                  <span className="dp-hint">linear, starting at graduation</span></div>
                <div className="dp-field"><label htmlFor="v-cap">Per-wallet cap: {capPct}% of target</label>
                  <input id="v-cap" type="range" min={1} max={100} value={capPct} onChange={(e) => setCapPct(Number(e.target.value))} />
                  <span className="dp-hint">keeps one wallet from cornering the round</span></div>
              </div>
            </div>
          </details>

          {/* 3 · economics */}
          <details className="dp-adv">
            <summary>Fees — {buyTaxPct}% buy / {sellTaxPct}% sell · split {alloc.dev}/{alloc.dividends}/{alloc.liquidity}/{alloc.mm}</summary>
            <div className="dp-body">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 22px" }}>
                <div className="dp-field"><label htmlFor="v-buytax">Buy tax: {buyTaxPct.toFixed(2)}%</label>
                  <input id="v-buytax" type="range" min={0} max={4} step={0.25} value={buyTaxPct}
                    onChange={(e) => setBuyTaxPct(Number(e.target.value))} /></div>
                <div className="dp-field"><label htmlFor="v-selltax">Sell tax: {sellTaxPct.toFixed(2)}%</label>
                  <input id="v-selltax" type="range" min={0} max={4} step={0.25} value={sellTaxPct}
                    onChange={(e) => setSellTaxPct(Number(e.target.value))} /></div>
              </div>
              <div className="dp-ration">
                {([["dev", "Dev wallet"], ["dividends", "Dividends"], ["liquidity", "Liquidity"], ["mm", "Market-making"]] as const).map(([k, label]) => (
                  <div key={k}>
                    <span className="dp-who">{label}</span>
                    <input type="range" min={0} max={100} step={5} value={alloc[k]} onChange={setBucket(k)} />
                    <span className="dp-amt">{alloc[k]}%</span>
                  </div>
                ))}
              </div>
              <p className="dp-mono" style={{ margin: "10px 0 0", fontSize: 12, color: allocTotal === 100 ? "var(--up)" : "var(--down)" }}>
                {allocTotal === 100 ? "Split totals 100% — OK." : `Split totals ${allocTotal}% — adjust to exactly 100%.`}
              </p>
              <p className="dp-agate">
                Protocol adds {(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade on top;
                {" "}{VENTURE.refShareBps / 100}% of that goes to referrers. Not adjustable.
              </p>
            </div>
          </details>

          {/* 4 · pairing, mainnet only */}
          {STOCK_PAIRS_ENABLED && (
            <details className="dp-adv">
              <summary>Pairing — {pairMode === "eth" ? "ETH" : stockPick?.symbol ?? "stock"}</summary>
              <div className="dp-body">
                <div className="dp-field"><label>Quote asset</label>
                  <select value={pairMode} onChange={(e) => setPairMode(e.target.value as "eth" | "stock")}>
                    <option value="eth">ETH — the default market</option>
                    <option value="stock">A tokenized stock — dividends pay in it</option>
                  </select></div>
                {pairMode === "stock" && (
                  <div className="dp-field"><label>Stock</label>
                    <select value={stock} onChange={(e) => setStock(e.target.value)}>
                      {STOCKS.map((s) => <option key={s.address} value={s.address}>{s.symbol} — {s.name}</option>)}
                    </select></div>
                )}
              </div>
            </details>
          )}

          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", marginTop: 18 }}>
            <button className="dp-action" type="submit" disabled={busy}>
              {mining ? "Mining your address…" : busy ? "Confirm in wallet…" : isConnected ? "Launch — one transaction" : "Connect wallet"}
            </button>
            <span className="dp-agate" style={{ maxWidth: "32ch" }}>
              Address ends in <span className="dp-mono">0x…4663</span>, mined in your browser before you sign.
              Free to launch — gas only.
            </span>
          </div>
        </div>

        {/* live preview: exactly the card backers will see */}
        <div style={{ position: "sticky", top: 70 }}>
          <p className="dp-mono" style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--faint)", margin: "0 0 8px" }}>
            PREVIEW — YOUR CARD ON THE BOARD
          </p>
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
              <span style={{ marginLeft: "auto" }}><span className="dp-badge dp-live">live</span></span>
            </div>
            <p className="dp-pitch">{form.pitch || "Your one-liner lands here — the first thing a backer reads."}</p>
            <div className="dp-curvebar" style={{ ["--pct" as string]: "0%" }}><i /></div>
            <div className="dp-curvelabel">
              <span><b>0%</b> to graduation</span>
              <span>0 / {target || "—"} ETH</span>
            </div>
            <div className="dp-prov"><span>by <b>you</b> · just now</span><span>0 backers</span></div>
          </div>

          <div className="dp-panel" style={{ marginTop: 12 }}>
            <div className="dp-phead"><span>What you'd earn</span></div>
            <div className="dp-pbody" style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--dim)", display: "grid", gap: 5 }}>
              <span><b className="dp-up">{cutEth > 0 ? `${cutEth.toFixed(4)} ETH` : "—"}</b> funding at graduation ({founderCut}% of target)</span>
              <span><b className="dp-up">{(((buyTaxPct + sellTaxPct) / 2) * alloc.dev / 100).toFixed(2)}%</b> of every trade to your dev wallet, forever</span>
              <span><b className="dp-up">{founderStake}%</b> of supply, vesting {vestDays} days</span>
            </div>
          </div>

          <p className="dp-agate" style={{ marginTop: 10 }}>
            Tokens are open ERC-20s whose economics resemble equity. They are not registered securities and the
            contracts are unaudited.
          </p>
        </div>
      </form>
    </div>
  );
}
