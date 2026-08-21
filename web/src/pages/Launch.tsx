import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { keccak256, toHex } from "viem";

import { StockLogo } from "../components/StockLogo";
import { Field, inputClass } from "../components/ui";
import { client } from "../lib/client";
import { addresses, env } from "../lib/env";
import { BRAND_FLAVOR, IS_STOCK_BOARD } from "../lib/brand";
import { STOCKS } from "../lib/v4/stocks";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";
import { LaunchBoard } from "./LaunchBoard";
import { LaunchBase } from "./LaunchBase";

const LAUNCHED_TOPIC = keccak256(toHex("Launched(address,address,address,uint16,bytes32)"));
const TOKEN_CREATED_TOPIC = keccak256(
  toHex("TokenCreated(address,address,string,string,string,uint256)"),
);
const IS_STABLE = String(import.meta.env.VITE_PROTOCOL ?? "") === "stable-v3";
/** Creator-fee product: fixed 1% trade fee split 80/20 creator/platform.
 *  True on the Stable V3 protocol and on V4 deployments with fee mode
 *  "creator" (Arc). */
const CREATOR_MODE = IS_STABLE || String(import.meta.env.VITE_FEE_MODE ?? "") === "creator";

/**
 * One-step V4 launch. The creator picks the tokenized stock holders will earn
 * and the trade tax (0-10%); supply, the WETH pool and the 50/25/25 fee split
 * are fixed protocol rules.
 */
export function LaunchPage() {
  // The Base stock launchpad pairs a tokenized stock and pays holders that
  // stock through a per-coin vault; its launch screen picks the stock.
  if (IS_STOCK_BOARD) return <LaunchBase />;
  // The Robinhood-chain board brand pairs against any onchain token and pays
  // holders 80% of fees in it; that flow has its own launch screen.
  if (BRAND_FLAVOR === "copair") return <LaunchBoard />;
  return <LaunchDefault />;
}

function LaunchDefault() {
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
  const dollarMode = env.rewardMode === "dollar";
  // Dollar mode: the reward is the wrapped native itself; no picker.
  const [stock, setStock] = useState(dollarMode ? addresses.weth : STOCKS[0].address);
  const [taxPct, setTaxPct] = useState(CREATOR_MODE ? 1 : 3);
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
      // 256px keeps cards and the token page sharp. The budget bounds the
      // on-chain string so the launch transaction stays well inside the block
      // gas limit; quality and size step down only if a busy image needs it.
      let out = render(256, 0.8);
      if (out.length > 24_000) out = render(256, 0.62);
      if (out.length > 24_000) out = render(192, 0.62);
      if (out.length > 24_000) out = render(128, 0.6);
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
      // Store canonical URLs on-chain: "@handle" becomes the platform link and
      // a bare "x.com/…" gets https:// so it renders as a working link.
      const url = (raw: string, platform?: "x" | "telegram") => {
        const s = raw.trim();
        if (!s) return "";
        if (s.startsWith("@") && platform) {
          return platform === "x" ? `https://x.com/${s.slice(1)}` : `https://t.me/${s.slice(1)}`;
        }
        return /^https?:\/\//i.test(s) ? s : `https://${s}`;
      };
      const metadata = JSON.stringify({
        description: form.description.trim(),
        logo: logoData,
        website: url(form.website),
        twitter: url(form.twitter, "x"),
        telegram: url(form.telegram, "telegram"),
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
      const log = receipt.logs.find(
        (l) => l.topics[0] === LAUNCHED_TOPIC || l.topics[0] === TOKEN_CREATED_TOPIC,
      );
      pushToast({ kind: "success", title: "Token is live", body: "Pool open, trading enabled.", txHash: hash });
      if (log?.topics[1]) navigate(`/token/0x${log.topics[1].slice(26)}`);
      else navigate("/");
    } catch (err) {
      pushToast({ kind: "error", title: "Launch failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const selectedStock = STOCKS.find((s) => s.address === stock);

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-5 sm:px-5">
      <h1 className="text-[18px] font-bold tracking-tight text-ink">Launch a token</h1>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        One transaction mints your token, opens a live market and seeds the full supply. Every trade
        {CREATOR_MODE
          ? " pays you 80% of the pool fee."
          : dollarMode
            ? " pays holders real dollars."
            : " rewards holders with the stock you pick."}
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

        {/* Reward; creator-fee note on Stable, stock picker elsewhere */}
        {CREATOR_MODE ? (
          <div className="rounded-lg border border-accent/25 bg-accent/[0.04] px-3 py-2.5">
            <p className="text-[12.5px] font-medium text-ink">
              You earn <span className="text-accent-ink">· 80% of trading fees</span>
            </p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
              Every trade pays the fixed 1% Uniswap pool fee. Harvest it anytime: 80% goes
              straight to you in {env.nativeSymbol}, 20% to the platform. No taxes on the token
              itself.
            </p>
          </div>
        ) : dollarMode ? (
          <div className="rounded-lg border border-accent/25 bg-accent/[0.04] px-3 py-2.5">
            <p className="text-[12.5px] font-medium text-ink">
              Holders earn <span className="text-accent-ink">· dollars</span>
            </p>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-3">
              The trade tax is harvested and paid out to holders in {env.nativeSymbol}, straight to
              their wallets. No stock picking. Every launch pays dollars.
            </p>
          </div>
        ) : (
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium text-ink">
              Holders earn <span className="text-ink-3">· {selectedStock?.symbol}</span>
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
        )}

        {/* Tax slider; hidden on Stable: the only trading cost is the fixed
            1% pool fee, split 80% to the creator / 20% to the platform. */}
        {!CREATOR_MODE && (
          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <label className="text-[12.5px] font-medium text-ink">Trade tax</label>
              <span className="tnum text-[13px] font-bold text-accent-ink">{taxPct}%</span>
            </div>
            <input type="range" min={0} max={10} step={1} value={taxPct} onChange={(e) => setTaxPct(Number(e.target.value))}
              className="w-full accent-[color:var(--color-accent)]" />
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="X"><input className={inputClass} value={form.twitter} onChange={set("twitter")} placeholder="x.com/…" /></Field>
          <Field label="Telegram"><input className={inputClass} value={form.telegram} onChange={set("telegram")} placeholder="t.me/…" /></Field>
          <Field label="Website"><input className={inputClass} value={form.website} onChange={set("website")} placeholder="https://" /></Field>
        </div>

        <dl className="space-y-1.5 border-t border-edge pt-3 text-[12px]">
          <Row label="Starting market cap" value={CREATOR_MODE ? "$3,000" : "$5,000"} />
          <Row label="Supply" value="1,000,000,000" />
          {CREATOR_MODE && <Row label="Pool fee" value="1% · 80% to you, 20% platform" />}
        </dl>

        <button type="submit" disabled={busy}
          className="h-11 w-full rounded-lg bg-accent text-[14px] font-semibold text-accent-fg transition-colors hover:bg-accent-2 disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-ink-3">
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
