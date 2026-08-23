import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAddress, isAddress, keccak256, toHex } from "viem";

import { client } from "../lib/client";
import { BASE_STOCKS, type BaseStock } from "../lib/base/stocks";
import { BASE_USDC, BASE_WETH } from "../lib/base/routes";

// Coins can pair a tokenized stock (holders earn the stock), ETH, or USDC
// (holders earn ETH / dollars). ETH + USDC lead as the two currency pairs.
const PAIRS: BaseStock[] = [
  { symbol: "ETH", name: "Ethereum", address: BASE_WETH, usd: 1900, usdcTickSpacing: 10 },
  { symbol: "USDC", name: "US Dollar Coin", address: BASE_USDC, usd: 1, usdcTickSpacing: 10 },
  ...BASE_STOCKS,
];
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { KoiIcon } from "../components/base/KoiIcon";
import { useUi } from "../store";

const LAUNCHED_TOPIC = keccak256(toHex("Launched(address,address,address,uint16,bytes32)"));

/**
 * Base stock launch. The creator picks a tokenized stock holders will earn,
 * uploads a logo, and sets the trade tax (1-10%). One transaction mints a
 * native B-20 coin, opens the coin/stock market at a $4,000 cap, seeds the
 * full supply single-sided, and spins up the coin's holder-reward vault. Half
 * of every trade's creator share flows to holders as that stock.
 */
export function LaunchBase({ onCancel }: { onCancel?: () => void } = {}) {
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
  const [stock, setStock] = useState(PAIRS[0].address);
  // Trade tax is fixed on-chain at 2% (not a launch control): split 50% to
  // holders (as the paired stock) and 50% to the creator's fee recipient.
  const taxPct = 2;
  const [busy, setBusy] = useState(false);
  const [logoData, setLogoData] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [devBuy, setDevBuy] = useState(0);
  const [feeMode, setFeeMode] = useState<"twitter" | "wallet">("twitter");
  const [feeRecipient, setFeeRecipient] = useState("");
  const [tried, setTried] = useState(false);
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
      let out = render(256, 0.8);
      if (out.length > 24_000) out = render(256, 0.62);
      if (out.length > 24_000) out = render(192, 0.62);
      if (out.length > 24_000) out = render(128, 0.6);
      setLogoData(out);
      setLogoUrl("");
    } catch {
      pushToast({ kind: "error", title: "Could not read that image", body: "Try a PNG or JPG file." });
    }
  };

  const selected = PAIRS.find((s) => s.address === stock)!;

  const nameError = tried && !form.name.trim() ? "Token name is required." : null;
  const logoUrlOk = /^(https?:\/\/|ipfs:\/\/)\S+$/i.test(logoUrl.trim());
  const logoValue = logoUrlOk ? logoUrl.trim() : logoData;
  const logoPreview = logoUrlOk
    ? (logoUrl.trim().startsWith("ipfs://") ? `https://ipfs.io/ipfs/${logoUrl.trim().slice(7)}` : logoUrl.trim())
    : logoData;
  const autoSymbol = () => form.name.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase() || "TOKEN";
  const isEthPair = selected.address.toLowerCase() === BASE_WETH.toLowerCase();
  const isUsdcPair = selected.address.toLowerCase() === BASE_USDC.toLowerCase();
  // Pair-token decimals: ETH 18, USDC 6, curated "c" stocks 8.
  const pairDecimals = isEthPair ? 18 : isUsdcPair ? 6 : 8;
  const devSym = isEthPair ? "ETH" : selected.symbol;
  // Slider tops out around $1,000 worth of the pair (1 ETH for the ETH pair).
  const devMax = isEthPair ? 1 : Math.max(1, Math.ceil(1000 / selected.usd));
  // Rough share of supply the dev buy takes at the $4k starting cap.
  const devUsd = devBuy * selected.usd;
  const devPct = devBuy > 0 ? Math.min(99, (devUsd / (4000 + devUsd)) * 100) : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!form.name.trim()) return;
    if (!isConnected) return connectFirst();
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
        logo: logoValue,
        website: url(form.website),
        twitter: url(form.twitter, "x"),
        telegram: url(form.telegram, "telegram"),
        // Surface the reward stock so lists and the token page can badge it.
        rewardStock: selected.address,
        pair: selected.symbol,
        ...(feeRecipient.trim()
          ? { feeRecipientType: feeMode, feeRecipient: feeRecipient.trim() }
          : {}),
      });
      // On-chain fee recipient: only a real address can be a payee. When the
      // creator gives a wallet-mode 0x address, route the 50% creator fee
      // there; otherwise (blank, ENS, or a Twitter handle) leave it unset and
      // the contract defaults it to the launcher. Any social handle still
      // rides along in metadata for attribution.
      const onchainFeeRecipient =
        feeMode === "wallet" && isAddress(feeRecipient.trim())
          ? getAddress(feeRecipient.trim())
          : undefined;
      const hash = await (client as any).createToken({
        name: form.name.trim(),
        symbol: (form.symbol.trim() || autoSymbol()).toUpperCase(),
        metadataURI: metadata,
        stock: selected.address,
        taxBps: Math.round(taxPct * 100),
        feeRecipient: onchainFeeRecipient,
        // Size the $4k start from the stock's snapshot USD price (8dp).
        pairUsdPrice8: BigInt(Math.round(selected.usd * 1e8)),
        // Atomic dev buy: ETH sent with the launch buys the coin in the same
        // transaction. Only offered on the ETH pair.
        devBuyWei: isEthPair && devBuy > 0 ? BigInt(Math.round(devBuy * 1e18)) : 0n,
      });
      pushToast({ kind: "info", title: "Launch submitted", txHash: hash });
      const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
      const log = receipt.logs.find((l) => l.topics[0] === LAUNCHED_TOPIC);
      pushToast({ kind: "success", title: "Coin is live", body: "Market open, holders now earn the stock.", txHash: hash });
      const tokenAddr = log?.topics[1] ? (`0x${log.topics[1].slice(26)}` as `0x${string}`) : null;
      // Non-ETH pairs: the dev buy runs as an immediate follow-up trade paid in
      // the pair token (same route as the trade desk). The launch stands even
      // if this second transaction is rejected.
      if (!isEthPair && devBuy > 0 && tokenAddr) {
        try {
          const units = BigInt(Math.round(devBuy * 10 ** pairDecimals));
          const buyHash = await (client as any).buyToken(tokenAddr, units);
          pushToast({ kind: "info", title: `Dev buy submitted (${devBuy} ${devSym})`, txHash: buyHash });
        } catch (err) {
          pushToast({ kind: "error", title: "Dev buy failed", body: errorText(err) });
        }
      }
      if (tokenAddr) navigate(`/token/${tokenAddr}`);
      else navigate("/");
    } catch (err) {
      pushToast({ kind: "error", title: "Launch failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kf kf-page kf-launch">
      <h1 className="kf-launch-h1">Launch a token</h1>
      <p className="kf-launch-sub">
        Deploy a coin on {`Base`} paired with a real tokenized stock. Every trade pays holders that stock.
      </p>

      <form onSubmit={submit} className="kf-form">
        <div className="kf-field">
          <label>Token Name</label>
          <input type="text" value={form.name} onChange={set("name")} placeholder="Enter token name..." maxLength={48}
            className={nameError ? "err" : undefined} aria-invalid={!!nameError} />
          {nameError ? <p className="kf-err-msg">{nameError}</p> : null}
        </div>

        <div className="kf-field">
          <label>Ticker Symbol <i>(optional)</i></label>
          <input type="text" value={form.symbol} onChange={set("symbol")} placeholder="e.g. TKN" maxLength={12} />
          <p className="hint">Auto-generated from the name if left blank.</p>
        </div>

        <div className="kf-field">
          <label>Description <i>(optional)</i></label>
          <textarea value={form.description} onChange={set("description")} placeholder="What is this coin about?" maxLength={500} rows={3} />
        </div>

        <div className="kf-field">
          <label>Token Image <i>(optional)</i></label>
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onLogoFile(f); }} />
          <div className="kf-drop-zone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) onLogoFile(f); }}>
            <div className="kf-drop-row">
              {logoPreview ? (
                <img src={logoPreview} alt="" style={{ width: 50, height: 50, borderRadius: 12, objectFit: "cover", flex: "none" }} />
              ) : null}
              <input
                type="text"
                value={logoUrl || (logoData ? "Uploaded image ready" : "")}
                placeholder="Paste image URL or upload..."
                onChange={(e) => { setLogoUrl(e.target.value); if (logoData) setLogoData(""); }}
                onFocus={() => { if (logoData) { setLogoData(""); setLogoUrl(""); } }}
              />
              <button type="button" className="kf-clip" aria-label="Upload image" onClick={() => fileRef.current?.click()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21 11.5-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8L13 4a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.8 1.8 0 0 1-2.6-2.6L15 7.3" /></svg>
              </button>
            </div>
            <p className="kf-drop-hint">
              Paste an image URL, browse, or drag and drop an image here.
              {logoUrl.trim() && !logoUrlOk ? <span style={{ color: "var(--color-down)" }}> Not a valid image URL.</span> : null}
              {logoValue ? <> · <button type="button" style={{ color: "var(--color-accent-ink)", background: "none", border: 0, cursor: "pointer", padding: 0 }} onClick={() => { setLogoData(""); setLogoUrl(""); }}>Remove</button></> : null}
            </p>
          </div>
        </div>

        <div className="kf-field">
          <label>X URL <i>(optional)</i></label>
          <input type="text" value={form.twitter} onChange={set("twitter")} placeholder="https://x.com/user/status/..." />
        </div>

        <div className="kf-field">
          <label>Telegram <i>(optional)</i></label>
          <input type="text" value={form.telegram} onChange={set("telegram")} placeholder="https://t.me/yourgroup or @handle" />
        </div>

        <div className="kf-field">
          <label>Website <i>(optional)</i></label>
          <input type="text" value={form.website} onChange={set("website")} placeholder="https://yourproject.com" />
        </div>

        <div className="kf-field">
          <label>Fee Recipient <i>(optional)</i></label>
          <div className="kf-seg2">
            <button type="button" className={feeMode === "twitter" ? "on" : ""} onClick={() => setFeeMode("twitter")}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden><path d="M17.9 3h3l-6.6 7.6L22 21h-6.1l-4.8-6.3L5.6 21h-3l7.1-8.1L2 3h6.2l4.3 5.7L17.9 3Zm-1.1 16.2h1.7L7.3 4.7H5.5l11.3 14.5Z" /></svg>
              Twitter
            </button>
            <button type="button" className={feeMode === "wallet" ? "on" : ""} onClick={() => setFeeMode("wallet")}>
              <KoiIcon name="wallet" size={16} />
              Wallet / ENS
            </button>
          </div>
          <input
            type="text"
            value={feeRecipient}
            onChange={(e) => setFeeRecipient(e.target.value)}
            placeholder={feeMode === "twitter" ? "@username" : "0x... or name.eth"}
          />
          <p className="hint">Leave blank to keep fees for yourself.</p>
        </div>

        {/* Pool pairing — the coin trades against this asset and holders earn it */}
        <div className="kf-field">
          <label>Pool Pairing</label>
          <div className="kf-pairgrid">
            {PAIRS.map((s, i) => (
              <button
                type="button"
                key={s.address}
                onClick={() => setStock(s.address)}
                title={s.name}
                className={stock === s.address ? "on" : ""}
              >
                {s.symbol}{i === 0 ? " (default)" : ""}
              </button>
            ))}
          </div>
          <p className="hint">Holders earn {selected.symbol} ({selected.name}) on every trade.</p>
        </div>

        {/* Dev buy — initial buy in the pair token: atomic with the launch on
            the ETH pair, an immediate follow-up trade on the others. */}
        <div className="kf-field">
          <label>Dev Buy <i>(optional)</i></label>
          <input type="text" inputMode="decimal" value={devBuy || ""} placeholder="0.0"
            onChange={(e) => { const v = parseFloat(e.target.value); setDevBuy(isFinite(v) && v >= 0 ? Math.min(v, devMax * 5) : 0); }} />
          <p className="hint">
            {isEthPair
              ? "ETH spent buying your own token in the launch transaction."
              : `${devSym} spent buying your own token right after launch.`}
          </p>
          <div className="kf-devbuy-row">
            <span>Dev buy amount</span>
            {devBuy > 0 ? <output>{devBuy} {devSym}{devPct >= 1 ? ` · ~${devPct.toFixed(0)}% of supply` : ""}</output> : null}
          </div>
          <input type="range" min={0} max={devMax} step={devMax / 100} value={Math.min(devBuy, devMax)}
            onChange={(e) => setDevBuy(Number(e.target.value))} aria-label={`Dev buy amount in ${devSym}`} />
          <div className="kf-devbuy-row muted"><span>0 {devSym}</span><span>{devMax}+ {devSym}</span></div>
        </div>

        <div className="kf-divider" />

        {tried && nameError ? <p className="kf-form-summary">Fix the highlighted fields to launch.</p> : null}
        <div className="kf-btnrow">
          <button type="button" className="kf-cancel" onClick={() => (onCancel ? onCancel() : window.history.back())}>Cancel</button>
          <button type="submit" className="kf-submit" disabled={busy}>
            {busy ? "Confirm in wallet…" : isConnected ? "Launch token" : "Connect & launch"}
          </button>
        </div>
        <p className="kf-footnote">
          {isConnected ? "You pay network gas and any dev buy." : "Connect a wallet to launch from your own address."}
        </p>
      </form>
    </div>
  );
}
