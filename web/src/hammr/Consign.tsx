import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { concatHex, encodeAbiParameters, getContractAddress, keccak256, type Address } from "viem";

import { factoryAbi, HAMMR, hammrPc } from "./client";
import { Gavel } from "./ui";
import { QUIVER_TOKEN_BYTECODE } from "../lib/rh/tokenBytecode";
import { pairUsd, resolvePairRoute } from "../lib/rh/routes";
import { STOCKS } from "../lib/v4/stocks";
import { errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

const TOTAL_SUPPLY = 10n ** 27n;
const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";

/** Consign a lot: the launch form, auction-house flavored. */
export function Consign() {
  const { isConnected, connectFirst, address: me } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: "", symbol: "", description: "", website: "", twitter: "" });
  const [pairMode, setPairMode] = useState<"eth" | "pons" | "stock" | "custom">("eth");
  const [stock, setStock] = useState<string>(STOCKS[0]?.address ?? "");
  const [custom, setCustom] = useState("");
  const [taxPct, setTaxPct] = useState(3);
  const [logoData, setLogoData] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pair: Address = useMemo(() => {
    if (pairMode === "eth") return HAMMR.weth;
    if (pairMode === "pons") return PONS as Address;
    if (pairMode === "stock") return stock as Address;
    return custom as Address;
  }, [pairMode, stock, custom]);

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) return connectFirst();
    if (!wc || !me) return;
    setBusy(true);
    try {
      const [pairUsdV, ethUsdV] = await Promise.all([pairUsd(pair, hammrPc), pairUsd(HAMMR.weth, hammrPc)]);
      if (!(pairUsdV > 0)) throw new Error("Could not price the pair token. Pick another or try again.");
      if (!(ethUsdV > 0)) throw new Error("Could not read the ETH price. Try again in a moment.");
      const route = await resolvePairRoute(hammrPc, pair);
      if (pair.toLowerCase() !== HAMMR.weth.toLowerCase() && (!route.buy || route.buy === "0x")) {
        throw new Error("No route to that pair token. It needs a live V3 pool against WETH or USDG.");
      }

      const metadataURI = JSON.stringify({
        description: form.description.trim(),
        logo: logoData,
        website: form.website.trim(),
        twitter: form.twitter.trim(),
      });
      const taxBps = Math.round(taxPct * 100);
      const args = encodeAbiParameters(
        [
          { type: "string" }, { type: "string" }, { type: "string" }, { type: "uint256" },
          { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "address" },
        ],
        [form.name.trim(), form.symbol.trim().toUpperCase(), metadataURI, TOTAL_SUPPLY, me, HAMMR.factory, taxBps, pair],
      );
      const initCodeHash = keccak256(concatHex([QUIVER_TOKEN_BYTECODE as `0x${string}`, args]));
      let salt: `0x${string}` | null = null;
      for (let i = 0n; i < 3_000_000n; i++) {
        const s = `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`;
        const addr = getContractAddress({ opcode: "CREATE2", from: HAMMR.factory, salt: s, bytecodeHash: initCodeHash });
        if ((BigInt(addr) & 0xffffn) === 0x4663n) { salt = s; break; }
      }
      if (!salt) throw new Error("Could not mine a launch address. Try again.");

      const hash = await wc.writeContract({
        address: HAMMR.factory,
        abi: factoryAbi,
        functionName: "launch",
        args: [
          {
            name: form.name.trim(),
            symbol: form.symbol.trim().toUpperCase(),
            metadataURI,
            pair,
            taxBps,
            pairUsdPrice8: BigInt(Math.round(pairUsdV * 1e8)),
            ethUsdPrice8: BigInt(Math.round(ethUsdV * 1e8)),
            v3Path: pair.toLowerCase() === HAMMR.weth.toLowerCase() ? "0x" : route.buy,
          },
          salt,
        ],
        chain: wc.chain,
        account: wc.account,
      });
      pushToast({ kind: "info", title: "Opening the auction…", txHash: hash });
      await hammrPc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Your lot is on the block", body: "One hour on the clock. Good luck." });
      navigate("/");
    } catch (err) {
      pushToast({ kind: "error", title: "Consign failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hm-shell hm-rise" style={{ paddingBottom: 90, maxWidth: 660 }}>
      <p className="hm-lot-no mt-8">consign a lot</p>
      <h1 className="hm-lotname mt-1">Put a coin on the block.</h1>
      <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "var(--h-ink-2)" }}>
        One transaction opens a one-hour falling-price auction of 50% of supply, starting at 10x the
        floor. When the hammer drops, the raise becomes locked liquidity and holders start earning
        the pair token on every trade. Free to consign; you keep 20% of every trade fee, forever.
      </p>

      <form onSubmit={submit} className="mt-6 space-y-5 rounded-2xl border p-6" style={{ borderColor: "var(--h-edge)", background: "var(--h-panel)" }}>
        <div className="flex items-center gap-4">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogo(f); }} />
          <button type="button" onClick={() => fileRef.current?.click()} aria-label="Upload logo"
            className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border"
            style={{ borderColor: "var(--h-edge-2)", background: "var(--h-panel-2)" }}>
            {logoData ? <img src={logoData} alt="" className="h-full w-full object-cover" /> : <Gavel size={26} />}
          </button>
          <div>
            <p className="hm-label">lot artwork</p>
            <p className="mt-1 text-[12px]" style={{ color: "var(--h-ink-3)" }}>PNG or JPG. Square looks best on the floor.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="hm-label mb-1.5">name</p>
            <input className="hm-input" required maxLength={32} value={form.name} onChange={set("name")} placeholder="Golden Gavel" />
          </div>
          <div>
            <p className="hm-label mb-1.5">ticker</p>
            <input className="hm-input" required maxLength={10} value={form.symbol} onChange={set("symbol")} placeholder="GAVEL" style={{ textTransform: "uppercase" }} />
          </div>
        </div>

        <div>
          <p className="hm-label mb-1.5">story</p>
          <textarea className="hm-input" rows={3} maxLength={280} value={form.description} onChange={set("description")} placeholder="Why this lot deserves the paddle war…" />
        </div>

        <div>
          <p className="hm-label mb-1.5">the pair · what holders earn</p>
          <div className="flex flex-wrap gap-2">
            {([["eth", "ETH"], ["pons", "PONS"], ["stock", "Tokenized stock"], ["custom", "Custom token"]] as const).map(([m, label]) => (
              <button key={m} type="button" onClick={() => setPairMode(m)}
                className="hm-chip" style={pairMode === m ? { borderColor: "var(--h-brass)", color: "var(--h-brass-2)", background: "#f0b4290d" } : undefined}>
                {label}
              </button>
            ))}
          </div>
          {pairMode === "stock" && (
            <select className="hm-input mt-2" value={stock} onChange={(e) => setStock(e.target.value)}>
              {STOCKS.map((s) => <option key={s.address} value={s.address}>{s.symbol} · {s.name}</option>)}
            </select>
          )}
          {pairMode === "custom" && (
            <input className="hm-input mt-2" placeholder="0x… token address on Robinhood Chain" value={custom} onChange={(e) => setCustom(e.target.value.trim())} />
          )}
        </div>

        <div>
          <p className="hm-label mb-1.5">trade fee · {taxPct.toFixed(1)}% (80% to holders, 20% to you)</p>
          <input type="range" min={0} max={10} step={0.5} value={taxPct} onChange={(e) => setTaxPct(Number(e.target.value))} className="w-full accent-[#f0b429]" />
        </div>

        <button className="hm-cta" disabled={busy} type="submit">
          {busy ? "Confirm in wallet…" : isConnected ? "Open the auction ⚒" : "Connect wallet to consign"}
        </button>
      </form>
    </div>
  );
}
