import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { erc20Abi, getAddress, isAddress, keccak256, toHex, type Address } from "viem";

import { StockLogo } from "../components/StockLogo";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { STOCKS } from "../lib/v4/stocks";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

const LAUNCHED_TOPIC = keccak256(toHex("Launched(address,address,address,uint16,bytes32)"));
const TOKEN_CREATED_TOPIC = keccak256(
  toHex("TokenCreated(address,address,string,string,string,uint256)"),
);

type PairMode = "stock" | "custom";

/** Clamp a typed fee to the 0-10% protocol range, rounded to whole basis
 *  points (taxBps = pct * 100), so an empty or out-of-range entry is safe. */
function clampTax(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const clamped = Math.min(10, Math.max(0, n));
  return Math.round(clamped * 100) / 100;
}

interface ResolvedToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Board (Robinhood-chain) launch flow. The creator picks ONE onchain token to
 * pair against — a Robinhood tokenized stock or any onchain meme token by
 * address. That token becomes both the trading pair (buys and sells settle in
 * it) and the earnings: 80% of every trade fee flows to the creator in that token,
 * auto-distributed once a holder is owed $4 and claimable anytime. The
 * remaining 20% funds the platform. Supply and the starting market cap are
 * fixed protocol rules.
 */
export function LaunchBoard() {
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
  const [pairMode, setPairMode] = useState<PairMode>("stock");
  const [stock, setStock] = useState<Address>(STOCKS[0].address);
  const [stockQuery, setStockQuery] = useState("");
  const [customInput, setCustomInput] = useState("");
  const [custom, setCustom] = useState<ResolvedToken | null>(null);
  const [customState, setCustomState] = useState<"idle" | "loading" | "bad">("idle");
  const [taxPct, setTaxPct] = useState(1);
  const [busy, setBusy] = useState(false);
  const [logoData, setLogoData] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Hood model: every coin pairs with WETH.
  const pair = { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address, symbol: "ETH", name: "Ether" } as const;

  // Filter the full stock list (94 tokens) by ticker or company name.
  const stockList = useMemo(() => {
    const q = stockQuery.trim().toLowerCase();
    if (!q) return STOCKS;
    return STOCKS.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
  }, [stockQuery]);

  const set =
    (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  // Resolve a pasted address to a real onchain ERC-20 (symbol/name/decimals).
  useEffect(() => {
    const raw = customInput.trim();
    setCustom(null);
    if (!raw) return setCustomState("idle");
    if (!isAddress(raw)) return setCustomState("bad");
    let live = true;
    setCustomState("loading");
    const addr = getAddress(raw);
    const read = (functionName: "symbol" | "name" | "decimals") =>
      client.publicClient.readContract({ address: addr, abi: erc20Abi, functionName });
    Promise.all([read("symbol"), read("name"), read("decimals")])
      .then(([symbol, name, decimals]) => {
        if (!live) return;
        setCustom({ address: addr, symbol: String(symbol), name: String(name), decimals: Number(decimals) });
        setCustomState("idle");
      })
      .catch(() => live && setCustomState("bad"));
    return () => {
      live = false;
    };
  }, [customInput]);

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
    if (!pair) {
      pushToast({ kind: "error", title: "Something went wrong", body: "Reload and try again." });
      return;
    }
    setBusy(true);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
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
        // Record the pair/reward token so the token page can label rewards.
        pair: { address: pair.address, symbol: pair.symbol },
      });
      const devBuyNum = Number(devBuy);
      const devBuyWei =
        Number.isFinite(devBuyNum) && devBuyNum > 0 ? BigInt(Math.round(devBuyNum * 1e18)) : 0n;
      const hash = await (client as any).createToken({
        name: form.name.trim(),
        symbol: form.symbol.trim().toUpperCase(),
        metadataURI: metadata,
        stock: pair.address,
        taxBps: Math.round(taxPct * 100),
        devBuyWei,
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

  return (
    <div className="board mx-auto max-w-lg px-4 pb-24 pt-5 sm:px-5">
      <div className="flex items-center gap-2">
        <span className="board-dot" />
        <h1 className="text-[18px] font-extrabold tracking-tight text-ink">Launch a token</h1>
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
        One transaction mints your token, opens a live market and seeds the full supply. Pick any
        Launch in one transaction; you earn 80% of every trade fee in ETH, forever.
      </p>

      <form onSubmit={submit} className="board-form mt-4 space-y-4">
        {/* Logo + identity */}
        <div className="flex items-center gap-3">
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogoFile(f); }} />
          <button type="button" onClick={() => fileRef.current?.click()}
            className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-edge bg-panel-2 transition-colors hover:border-accent"
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
          <BoardField label="Token name">
            <input className="board-input h-10 w-full px-3 text-[13px] outline-none" value={form.name} onChange={set("name")} placeholder="My Token" required maxLength={48} />
          </BoardField>
          <BoardField label="Symbol">
            <input className="board-input h-10 w-full px-3 text-[13px] outline-none" value={form.symbol} onChange={set("symbol")} placeholder="MTK" required maxLength={12} />
          </BoardField>
        </div>

        <BoardField label="Description">
          <textarea className="board-input min-h-20 w-full resize-y px-3 py-2 text-[13px] outline-none" value={form.description} onChange={set("description")}
            placeholder="What is this token about?" maxLength={500} />
        </BoardField>

        {/* Hood model: every coin pairs with ETH at a flat 1% fee. */}
        <div className="rounded-xl border border-edge bg-panel-2 px-4 py-3">
          <p className="text-[12.5px] font-semibold text-ink">Pairs with ETH · 1% flat trade fee</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">
            You earn 20% of every trade fee in ETH for the life of your coin. 25% fills the
            community pot that buys back and burns the week's top 3 coins, 30% flows back to
            traders, and 25% funds the platform. Snipers pay extra, straight into the burn pot.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <BoardField label="X"><input className="board-input h-10 w-full px-3 text-[13px] outline-none" value={form.twitter} onChange={set("twitter")} placeholder="x.com/…" /></BoardField>
          <BoardField label="Telegram"><input className="board-input h-10 w-full px-3 text-[13px] outline-none" value={form.telegram} onChange={set("telegram")} placeholder="t.me/…" /></BoardField>
          <BoardField label="Website"><input className="board-input h-10 w-full px-3 text-[13px] outline-none" value={form.website} onChange={set("website")} placeholder="https://" /></BoardField>
        </div>

        <BoardField label="Initial buy (ETH, optional)">
          <input
            className="board-input h-10 w-full px-3 text-[13px] outline-none"
            value={devBuy}
            onChange={(e) => setDevBuy(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
          />
          <p className="mt-1 text-[11px] text-ink-3">
            Buys your coin in the same transaction as the launch, before anyone else can trade.
            Pays the flat 1% fee only, never the sniper rate.
          </p>
        </BoardField>

        <dl className="space-y-1.5 border-t border-edge pt-3 text-[12px]">
          <Row label="Starting market cap" value="$3,000" />
          <Row label="Supply" value="1,000,000,000" />
          <Row label="Trade fee" value="1% · 20% you, 25% platform, 25% burns, 30% traders" />
          <Row label="Weekly flywheel" value="top 3 coins by volume get bought back and burned" />
        </dl>

        <button type="submit" disabled={busy}
          className="board-launch h-11 w-full !text-[14px] disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? "Confirm in wallet…" : isConnected ? "Launch token" : "Connect wallet to launch"}
        </button>
      </form>
    </div>
  );
}

function BoardField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-ink-2">{label}</span>
      {children}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-3">{label}</dt>
      <dd className="mono text-right font-medium text-ink-2">{value}</dd>
    </div>
  );
}
