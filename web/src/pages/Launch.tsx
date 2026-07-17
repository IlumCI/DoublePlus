import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { keccak256, toHex } from "viem";

import { StockLogo } from "../components/StockLogo";
import { Field, inputClass } from "../components/ui";
import { client } from "../lib/client";
import { STOCKS } from "../lib/v4/stocks";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

const LAUNCHED_TOPIC = keccak256(toHex("Launched(address,address,address,uint16,bytes32)"));

/**
 * One-step V4 launch. The creator picks the tokenized stock holders will earn
 * and the trade tax (0-10%); supply, the WETH pool, the anti-whale caps and
 * the 50/25/25 fee split are fixed protocol rules.
 */
export function LaunchPage() {
  const { isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: "",
    symbol: "",
    description: "",
    website: "",
    twitter: "",
    telegram: "",
  });
  const [stock, setStock] = useState(STOCKS[0].address);
  const [taxPct, setTaxPct] = useState(3);
  const [busy, setBusy] = useState(false);
  const [logoData, setLogoData] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const onLogoFile = async (file: File) => {
    try {
      const bitmap = await createImageBitmap(file);
      const render = (size: number, quality: number) => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d")!;
        const side = Math.min(bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
        const webp = canvas.toDataURL("image/webp", quality);
        return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", quality);
      };
      let out = render(96, 0.8);
      if (out.length > 12_000) out = render(96, 0.55);
      if (out.length > 12_000) out = render(64, 0.55);
      setLogoData(out);
    } catch {
      pushToast({ kind: "error", title: "Could not read that image", body: "Try a PNG or JPG file." });
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected) return connectFirst();
    setBusy(true);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const metadata = JSON.stringify({
        description: form.description.trim(),
        logo: logoData,
        website: form.website.trim(),
        twitter: form.twitter.trim(),
        telegram: form.telegram.trim(),
      });
      const hash = await (client as any).createToken({
        name: form.name.trim(),
        symbol: form.symbol.trim().toUpperCase(),
        metadataURI: metadata,
        stock,
        taxBps: Math.round(taxPct * 100),
      });
      pushToast({ kind: "info", title: "Launch submitted", txHash: hash });
      const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
      const log = receipt.logs.find((l) => l.topics[0] === LAUNCHED_TOPIC);
      pushToast({ kind: "success", title: "Token is live", body: "Pool open, trading enabled.", txHash: hash });
      if (log?.topics[1]) navigate(`/token/0x${log.topics[1].slice(26)}`);
      else navigate("/");
    } catch (err) {
      pushToast({ kind: "error", title: "Launch failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const selectedStock = STOCKS.find((s) => s.address === stock)!;

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-5 sm:px-5">
      <h1 className="text-[18px] font-bold tracking-tight text-ink">Launch a token</h1>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        One transaction mints your token, opens a live market and seeds the full supply. Every trade
        rewards holders with the stock you pick.
      </p>

      <form onSubmit={submit} className="mt-4 space-y-4 rounded-xl border border-edge bg-panel p-4">
        {/* Logo + identity */}
        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogoFile(f); }} />
          <button type="button" onClick={() => fileRef.current?.click()}
            className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-edge bg-panel-2 transition-colors hover:border-edge-2"
            aria-label="Upload logo">
            {logoData ? (
              <img src={logoData} alt="" className="h-full w-full object-cover" />
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-ink-3" aria-hidden>
                <path d="M12 16V5m0 0l-4 4m4-4l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 17.5V19a1.5 1.5 0 001.5 1.5h13A1.5 1.5 0 0020 19v-1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <div>
            <p className="text-[13px] font-semibold text-ink">Logo</p>
            <p className="mt-0.5 text-[11.5px] text-ink-3">
              PNG / JPG.{" "}
              {logoData ? (
                <button type="button" className="font-medium text-accent-ink underline underline-offset-2" onClick={() => setLogoData("")}>Remove</button>
              ) : null}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_130px]">
          <Field label="Token name">
            <input className={inputClass} value={form.name} onChange={set("name")} placeholder="My Token" required maxLength={48} />
          </Field>
          <Field label="Symbol">
            <input className={inputClass} value={form.symbol} onChange={set("symbol")} placeholder="MTK" required maxLength={12} />
          </Field>
        </div>

        <Field label="Description">
          <textarea className={`${inputClass} min-h-20 resize-y`} value={form.description} onChange={set("description")}
            placeholder="What is this token about?" maxLength={500} />
        </Field>

        {/* Reward stock picker */}
        <div>
          <label className="mb-1.5 block text-[12.5px] font-medium text-ink">
            Holders earn <span className="text-ink-3">· {selectedStock.symbol}</span>
          </label>
          <div className="grid grid-cols-5 gap-1.5">
            {STOCKS.map((s) => (
              <button
                type="button"
                key={s.address}
                onClick={() => setStock(s.address)}
                title={s.name}
                className={`flex flex-col items-center gap-1 rounded-lg border py-2 text-[11px] font-bold transition-colors ${
                  stock === s.address ? "border-accent bg-accent/10 text-accent-ink" : "border-edge text-ink-2 hover:border-edge-2 hover:text-ink"
                }`}
              >
                <StockLogo address={s.address} symbol={s.symbol} size={22} />
                {s.symbol}
              </button>
            ))}
          </div>
        </div>

        {/* Tax slider */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <label className="text-[12.5px] font-medium text-ink">Trade tax</label>
            <span className="tnum text-[13px] font-bold text-accent-ink">{taxPct}%</span>
          </div>
          <input type="range" min={0} max={10} step={1} value={taxPct} onChange={(e) => setTaxPct(Number(e.target.value))}
            className="w-full accent-[color:var(--color-accent)]" />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="X"><input className={inputClass} value={form.twitter} onChange={set("twitter")} placeholder="x.com/…" /></Field>
          <Field label="Telegram"><input className={inputClass} value={form.telegram} onChange={set("telegram")} placeholder="t.me/…" /></Field>
          <Field label="Website"><input className={inputClass} value={form.website} onChange={set("website")} placeholder="https://" /></Field>
        </div>

        <dl className="space-y-1.5 border-t border-edge pt-3 text-[12px]">
          <Row label="Starting market cap" value="$5,000" />
          <Row label="Supply" value="1,000,000,000" />
          <Row label="Anti-whale" value="2% max wallet" />
        </dl>

        <button type="submit" disabled={busy}
          className="h-11 w-full rounded-lg bg-accent text-[14px] font-semibold text-ink transition-colors hover:bg-accent-2 disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-ink-3">
          {busy ? "Confirm in wallet…" : isConnected ? "Launch token" : "Connect wallet to launch"}
        </button>
      </form>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-ink-3">{label}</dt>
      <dd className="tnum font-medium text-ink-2">{value}</dd>
    </div>
  );
}
