import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { concatHex, encodeAbiParameters, formatEther, getContractAddress, keccak256, parseEther } from "viem";

import { factoryAbi, VENTURE, venturePc } from "./client";
import { Flag, fmtUsdV } from "./ui";
import { QUIVER_TOKEN_BYTECODE } from "../lib/rh/tokenBytecode";
import { pairUsd } from "../lib/rh/routes";
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
        [form.name.trim(), symbol, metadataURI, TOTAL_SUPPLY, me, VENTURE.factory, buyTaxBps, VENTURE.weth],
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
            pair: VENTURE.weth,
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
            v3Path: "0x",
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

  return (
    <div className="vn-shell vn-rise" style={{ paddingBottom: 90, maxWidth: 680 }}>
      <p className="vn-eyebrow mt-8">found a startup</p>
      <h1 className="vn-title mt-1">Put your venture on the board.</h1>
      <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--v-ink-2)" }}>
        One transaction deploys your coin, escrows your vested stake, and opens an all-or-nothing funding
        round on a rising price curve. Every term below is written on-chain where your backers can read it.
      </p>

      <form onSubmit={submit} className="vn-card mt-6 space-y-6 p-6">
        {/* Identity */}
        <div>
          <p className="vn-eyebrow mb-3">1 · the venture</p>
          <div className="flex items-center gap-4">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogo(f); }} />
            <button type="button" onClick={() => fileRef.current?.click()} aria-label="Upload logo"
              className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border"
              style={{ borderColor: "var(--v-edge-2)", background: "var(--v-panel-2)" }}>
              {logoData ? <img src={logoData} alt="" className="h-full w-full object-cover" /> : <Flag size={26} />}
            </button>
            <div className="grid flex-1 gap-3 sm:grid-cols-[1fr_130px]">
              <div>
                <label className="vn-label">Startup name</label>
                <input className="vn-input" required maxLength={40} placeholder="Acme Robotics" value={form.name} onChange={set("name")} />
              </div>
              <div>
                <label className="vn-label">Ticker</label>
                <input className="vn-input" required maxLength={10} placeholder="ACME" value={form.symbol}
                  onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} />
              </div>
            </div>
          </div>
          <div className="mt-3">
            <label className="vn-label">The pitch</label>
            <textarea className="vn-input" required maxLength={600} placeholder="What are you building, and why should anyone fund it?" value={form.pitch} onChange={set("pitch")} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="vn-label">Sector <span className="vn-hint">(optional)</span></label>
              <input className="vn-input" maxLength={30} placeholder="AI · robotics" value={form.sector} onChange={set("sector")} />
            </div>
            <div>
              <label className="vn-label">Website <span className="vn-hint">(optional)</span></label>
              <input className="vn-input" placeholder="https://" value={form.website} onChange={set("website")} />
            </div>
            <div>
              <label className="vn-label">X / Twitter <span className="vn-hint">(optional)</span></label>
              <input className="vn-input" placeholder="https://x.com/" value={form.twitter} onChange={set("twitter")} />
            </div>
          </div>
        </div>

        {/* Terms */}
        <div>
          <p className="vn-eyebrow mb-3">2 · the term sheet</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="vn-label">Funding target (ETH)</label>
              <div className="vn-field" style={{ padding: "9px 13px" }}>
                <input inputMode="decimal" placeholder={minTargetEth > 0 ? `min ${minTargetEth.toFixed(4)}` : "0.0"} value={target}
                  onChange={(e) => setTarget(e.target.value.replace(/[^0-9.]/g, ""))} />
                <span className="vn-chip shrink-0">ETH</span>
              </div>
              <p className="vn-hint mt-1">
                {targetUsd > 0 ? `≈ ${fmtUsdV(targetUsd)} · ` : ""}all-or-nothing: miss it and backers refund in full
              </p>
            </div>
            <div>
              <label className="vn-label">Round length: <b>{days} days</b></label>
              <input type="range" className="vn-range" min={1} max={14} step={1} value={days} onChange={(e) => setDays(Number(e.target.value))} />
              <p className="vn-hint">1–14 days on the clock</p>
            </div>
            <div>
              <label className="vn-label">Your cut of the raise: <b>{founderCut}%</b></label>
              <input type="range" className="vn-range" min={0} max={30} step={1} value={founderCut} onChange={(e) => setFounderCut(Number(e.target.value))} />
              <p className="vn-hint">
                paid to you at graduation{founderCutEth > 0n ? ` (≈ ${Number(formatEther(founderCutEth)).toFixed(4)} ETH)` : ""}; the rest becomes locked liquidity
              </p>
            </div>
            <div>
              <label className="vn-label">Per-wallet cap: <b>{capPct}% of target</b></label>
              <input type="range" className="vn-range" min={1} max={100} step={1} value={capPct} onChange={(e) => setCapPct(Number(e.target.value))} />
              <p className="vn-hint">keeps one whale from cornering your round</p>
            </div>
            <div>
              <label className="vn-label">Your vested stake: <b>{founderStake}% of supply</b></label>
              <input type="range" className="vn-range" min={0} max={15} step={1} value={founderStake} onChange={(e) => setFounderStake(Number(e.target.value))} />
              <p className="vn-hint">escrowed now, unlocks linearly only after graduation</p>
            </div>
            <div style={{ opacity: founderStake > 0 ? 1 : 0.4 }}>
              <label className="vn-label">Vesting period: <b>{vestDays} days</b></label>
              <input type="range" className="vn-range" min={90} max={730} step={5} value={vestDays} disabled={founderStake === 0} onChange={(e) => setVestDays(Number(e.target.value))} />
              <p className="vn-hint">90–730 days, linear</p>
            </div>
            <div>
              <label className="vn-label">Buy tax after graduation: <b>{buyTaxPct}%</b></label>
              <input type="range" className="vn-range" min={0} max={4} step={0.25} value={buyTaxPct} onChange={(e) => setBuyTaxPct(Number(e.target.value))} />
              <p className="vn-hint">0–4%, charged on every buy</p>
            </div>
            <div>
              <label className="vn-label">Sell tax after graduation: <b>{sellTaxPct}%</b></label>
              <input type="range" className="vn-range" min={0} max={4} step={0.25} value={sellTaxPct} onChange={(e) => setSellTaxPct(Number(e.target.value))} />
              <p className="vn-hint">0–4%, charged on every sell</p>
            </div>
          </div>
        </div>

        {/* Fee allocation */}
        <div>
          <p className="vn-eyebrow mb-1">2b · where your trade tax goes</p>
          <p className="vn-hint mb-3">
            Split 100% of your tax across four engines. Settled automatically on every trade, on-chain, forever —
            plus the protocol fee of {(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade on top.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(
              [
                ["dev", "Dev wallet", "paid straight to your team wallet, in the trade currency"],
                ["dividends", "Holder dividends", "paid to every holder pro-rata in ETH — your stock pays a yield"],
                ["liquidity", "Auto-liquidity", "re-added beside the price, permanently locked — deepens your book"],
                ["mm", "Market-making wall", "converted to ETH and posted as standing buy support under the price"],
              ] as const
            ).map(([k, label, hint]) => (
              <div key={k}>
                <label className="vn-label">{label}: <b>{alloc[k]}%</b></label>
                <input type="range" className="vn-range" min={0} max={100} step={5} value={alloc[k]} onChange={setBucket(k)} />
                <p className="vn-hint">{hint}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[12.5px]" style={{ color: allocTotal === 100 ? "var(--v-green-2)" : "var(--v-red)" }}>
            Allocation total: {allocTotal}% {allocTotal === 100 ? "✓" : "— must equal 100%"}
          </p>
        </div>

        {/* Summary */}
        <div>
          <p className="vn-eyebrow mb-2">3 · what your backers will see</p>
          <div className="vn-sheet">
            <div className="tr"><span>term</span><span>value</span></div>
            <div className="tr"><span>Raise</span><span className="vn-num">{target || "—"} ETH in ≤ {days}d, all-or-nothing</span></div>
            <div className="tr"><span>Founder take</span><span>{founderCut}% of raise + {founderStake}% supply vested {founderStake > 0 ? `${vestDays}d` : ""}</span></div>
            <div className="tr"><span>Liquidity</span><span>{100 - founderCut}% of raise + unsold supply, locked at graduation</span></div>
            <div className="tr"><span>Trade taxes</span><span>{buyTaxPct}% buy / {sellTaxPct}% sell + {(VENTURE.platformFeeBps / 100).toFixed(2)}% protocol</span></div>
            <div className="tr"><span>Tax split</span><span>{alloc.dev}% dev · {alloc.dividends}% dividends · {alloc.liquidity}% liquidity · {alloc.mm}% MM wall</span></div>
          </div>
        </div>

        <button className="vn-cta" type="submit" disabled={busy}>
          {mining ? "Mining your launch address…" : busy ? "Confirm in wallet…" : isConnected ? "Open the raise" : "Connect wallet"}
        </button>
        <p className="vn-hint text-center">
          Free to launch — one transaction, gas only. Tokens are open ERC-20s, not registered securities.
        </p>
      </form>
    </div>
  );
}
