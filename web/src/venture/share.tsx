import { useState } from "react";

import { BRAND } from "../lib/brand";
import { useWallet } from "../lib/useWallet";
import type { Venture } from "./client";
import { refLink } from "./referral";
import { fmtEth, pct } from "./ui";

/**
 * Share cards: an image-first post for X. Photos earn far more reposts than
 * bare links, and a link in the post body has been deprioritised on X at
 * times, so the card is the payload and the link rides along. The card is
 * drawn on a canvas in the browser: no server, no per-token OG renderer.
 */

const W = 1200, H = 630;

function status(v: Venture): { big: string; small: string; pct: number } {
  const p = v.phase === "graduated" ? 100 : pct(v.raisedWei, v.targetRaiseWei);
  if (v.phase === "graduated") return { big: "LIVE ON UNISWAP", small: `${fmtEth(v.raisedWei, 3)} ETH raised · liquidity locked`, pct: 100 };
  if (v.phase === "failed") return { big: "REFUNDS OPEN", small: "missed the target · every backer gets their ETH back", pct: p };
  const left = v.targetRaiseWei > v.raisedWei ? v.targetRaiseWei - v.raisedWei : 0n;
  // Only an all-or-nothing raise refunds; an open curve just trades until it fills.
  const tail = v.mode === 1 ? "open curve" : "refund or rocket";
  return { big: `${p.toFixed(0)}% TO GRADUATION`, small: `${fmtEth(left, 3)} ETH left to fill · ${tail}`, pct: p };
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // a logo host without CORS would taint the canvas; then we fall back
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

function ribbon(ctx: CanvasRenderingContext2D, y0: number, amp: number, color: string, width: number) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.filter = `blur(${width}px)`;
  ctx.strokeStyle = color;
  ctx.lineWidth = width * 1.6;
  ctx.beginPath();
  for (let x = -40; x <= W + 40; x += 20) {
    const y = y0 + amp * Math.sin(x / 210) + amp * 0.4 * Math.sin(x / 83 + 1.3) - x * 0.18;
    if (x === -40) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

export async function drawShareCard(v: Venture): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) return null;

  // Plex night desktop with the aurora ribbons, as on the site.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#10224a"); bg.addColorStop(0.55, "#060b1c"); bg.addColorStop(1, "#02040b");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ribbon(ctx, 470, 38, "rgba(77,219,148,.55)", 14);
  ribbon(ctx, 560, 52, "rgba(84,120,220,.5)", 20);
  ribbon(ctx, 380, 24, "rgba(178,235,255,.35)", 8);

  // Window frame.
  ctx.fillStyle = "rgba(7,11,24,.86)";
  ctx.strokeStyle = "rgba(110,140,210,.5)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(60, 60, W - 120, H - 120, 14); ctx.fill(); ctx.stroke();
  const tb = ctx.createLinearGradient(0, 60, 0, 110);
  tb.addColorStop(0, "#6584bf"); tb.addColorStop(0.48, "#3f5ca0"); tb.addColorStop(0.52, "#283f7a"); tb.addColorStop(1, "#30498a");
  ctx.fillStyle = tb;
  ctx.beginPath(); ctx.roundRect(60, 60, W - 120, 50, [14, 14, 0, 0]); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = "600 22px 'Segoe UI', Tahoma, sans-serif";
  ctx.fillText(`${BRAND.name}${BRAND.tld} — $${v.symbol}`, 90, 93);

  // Logo or monogram.
  const lx = 100, ly = 150, ls = 150;
  const logo = v.meta.logo ? await loadImage(v.meta.logo) : null;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(lx, ly, ls, ls, 22); ctx.clip();
  if (logo) ctx.drawImage(logo, lx, ly, ls, ls);
  else {
    const g = ctx.createLinearGradient(0, ly, 0, ly + ls);
    g.addColorStop(0, "#78dd55"); g.addColorStop(1, "#2e8b1f");
    ctx.fillStyle = g; ctx.fillRect(lx, ly, ls, ls);
    ctx.fillStyle = "#fff"; ctx.font = "800 84px 'Segoe UI', Tahoma, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(v.name.slice(0, 1).toUpperCase(), lx + ls / 2, ly + ls / 2 + 30);
    ctx.textAlign = "left";
  }
  ctx.restore();

  // Name and ticker.
  ctx.fillStyle = "#fff"; ctx.font = "800 60px 'Segoe UI', Tahoma, sans-serif";
  const name = v.name.length > 22 ? `${v.name.slice(0, 21)}…` : v.name;
  ctx.fillText(name, 285, 215);
  ctx.fillStyle = "#8ff0ae"; ctx.font = "700 40px Consolas, 'Lucida Console', monospace";
  ctx.fillText(`$${v.symbol}`, 285, 268);
  if (v.meta.pitch) {
    ctx.fillStyle = "#a6b3d3"; ctx.font = "26px 'Segoe UI', Tahoma, sans-serif";
    const pitch = v.meta.pitch.length > 64 ? `${v.meta.pitch.slice(0, 63)}…` : v.meta.pitch;
    ctx.fillText(pitch, 285, 308);
  }

  // Status and the progress bar.
  const s = status(v);
  ctx.fillStyle = v.phase === "failed" ? "#ff8a80" : "#fff";
  ctx.font = "800 46px 'Segoe UI', Tahoma, sans-serif";
  ctx.fillText(s.big, 100, 400);
  const bx = 100, by = 425, bw = W - 200, bh = 30;
  ctx.fillStyle = "#060a18"; ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 8); ctx.fill();
  const fill = ctx.createLinearGradient(0, by, 0, by + bh);
  if (v.phase === "graduated") { fill.addColorStop(0, "#6fa8ff"); fill.addColorStop(1, "#2f62c8"); }
  else if (v.phase === "failed") { fill.addColorStop(0, "#e86a5c"); fill.addColorStop(1, "#b52a1d"); }
  else { fill.addColorStop(0, "#7ff09a"); fill.addColorStop(1, "#1c9a24"); }
  ctx.fillStyle = fill;
  ctx.beginPath(); ctx.roundRect(bx, by, Math.max(bh, (bw * Math.min(100, s.pct)) / 100), bh, 8); ctx.fill();
  ctx.fillStyle = "#c9d6f5"; ctx.font = "26px Consolas, 'Lucida Console', monospace";
  ctx.fillText(s.small, 100, 500);

  // Footer.
  ctx.fillStyle = "#9fc4ff"; ctx.font = "700 26px 'Segoe UI', Tahoma, sans-serif";
  ctx.fillText(BRAND.domain, 100, 545);
  ctx.textAlign = "right"; ctx.fillStyle = "#8796bc"; ctx.font = "22px 'Segoe UI', Tahoma, sans-serif";
  ctx.fillText(`@${BRAND.twitterHandle}`, W - 100, 545);
  ctx.textAlign = "left";

  return new Promise((res) => {
    try { c.toBlob((b) => res(b), "image/png"); } catch { res(null); } // tainted canvas: no image, the link still works
  });
}

function postText(v: Venture): string {
  if (v.phase === "graduated") return `$${v.symbol} graduated and is trading on Uniswap. Liquidity locked.`;
  if (v.phase === "failed") return `$${v.symbol} missed its target — refunds are open.`;
  const p = pct(v.raisedWei, v.targetRaiseWei);
  return `$${v.symbol} is ${p.toFixed(0)}% of the way to graduation.${v.mode === 1 ? "" : " Refund or rocket."}`;
}

/** Post on X, copy the card image, or download it. With a wallet connected the
 *  link carries the sharer's referral, and the post says so. */
export function ShareBar({ v }: { v: Venture }) {
  const { address: me } = useWallet();
  const [note, setNote] = useState<string | null>(null);
  const link = me ? refLink(me) : location.href;
  const flash = (t: string) => { setNote(t); setTimeout(() => setNote(null), 1800); };

  const tweet = () => {
    // A referral link earns the sharer a fee share: a material connection, so the post discloses it.
    const text = `${postText(v)}\n\n@${BRAND.twitterHandle}${me ? " (my ref link)" : ""}`;
    const u = new URL("https://x.com/intent/post");
    u.searchParams.set("text", text);
    u.searchParams.set("url", link);
    window.open(u.toString(), "_blank", "noopener,noreferrer");
  };
  const copy = async () => {
    const blob = await drawShareCard(v);
    if (!blob || !navigator.clipboard || typeof ClipboardItem === "undefined") { flash("can't copy here, use download"); return; }
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); flash("image copied ✓"); }
    catch { flash("can't copy here, use download"); }
  };
  const download = async () => {
    const blob = await drawShareCard(v);
    if (!blob) { flash("image unavailable"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${v.symbol.toLowerCase()}-${BRAND.name}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  return (
    <div className="dp-share">
      <button className="dp-share-x" onClick={tweet}>Post on 𝕏</button>
      <button onClick={copy}>Copy image</button>
      <button onClick={download}>Download</button>
      {note && <span className="dp-share-note">{note}</span>}
      <span className="dp-share-tip">Tip: paste the image into your post — image posts travel further.</span>
    </div>
  );
}
