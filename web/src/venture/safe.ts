/** Sanitisers for creator-supplied data. Pure, so they're tested directly. */

/** A creator-supplied image URL, or "" if it isn't one we load: an inline
 *  image (how logos ride on-chain) or https. Anything else, http or other
 *  schemes, is dropped, so a coin page can't be made to fetch from wherever
 *  its creator likes. */
export function safeImageUrl(u: string | undefined): string {
  if (!u) return "";
  if (/^data:image\/(png|jpe?g|webp|gif|avif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(u)) return u;
  if (/^https:\/\/[^\s"'<>]+$/i.test(u)) return u;
  return "";
}

/** A creator-supplied link, or "" unless it is plain http(s). Blocks
 *  javascript:, data: and every other scheme a click could run. */
export function safeLinkUrl(u: string | undefined): string {
  if (!u) return "";
  return /^https?:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : "";
}

// Bidi overrides and isolates, zero-width and other invisible format marks,
// and C0/C1 controls (newlines and tabs are kept where a field allows them).
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]/g;

/** Creator text made safe to display: right-to-left overrides (which turn
 *  "\u202Egnp.exe" into "exe.png" and flip whatever follows them, our own
 *  brand included) and invisible characters removed, whitespace collapsed
 *  unless `multiline`, length capped. */
export function cleanText(raw: unknown, max: number, multiline = false): string {
  if (typeof raw !== "string") return "";
  let t = raw.replace(INVISIBLE, "");
  t = multiline ? t.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : t.replace(/\s+/g, " ");
  t = t.trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : t;
}

export interface CleanMeta {
  description?: string; pitch?: string; sector?: string; logo?: string; banner?: string;
  website?: string; twitter?: string; telegram?: string; discord?: string; github?: string; docs?: string;
}

/** On-chain metadata as the creator wrote it, which may be anything: not
 *  JSON, JSON null, an array, a number, fields of the wrong type, prototype
 *  keys. Returns only the known fields, each a clean string. A coin with
 *  hostile metadata must never be able to break the page for everyone. */
export function parseMeta(raw: unknown): CleanMeta {
  let v: unknown;
  try { v = JSON.parse(String(raw ?? "")); } catch { return {}; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const out: CleanMeta = {};
  const text = (k: keyof CleanMeta, max: number, multiline = false) => {
    const t = cleanText(own(k), max, multiline);
    if (t) out[k] = t;
  };
  text("pitch", 200);
  text("description", 4000, true);
  text("sector", 40);
  for (const k of ["website", "twitter", "telegram", "discord", "github", "docs"] as const) {
    const u = safeLinkUrl(typeof own(k) === "string" ? (own(k) as string) : "");
    if (u && u.length <= 300) out[k] = u;
  }
  const logo = safeImageUrl(typeof own("logo") === "string" ? (own("logo") as string) : "");
  if (logo && logo.length <= 64_000) out.logo = logo;
  const banner = safeImageUrl(typeof own("banner") === "string" ? (own("banner") as string) : "");
  if (banner && banner.length <= 600) out.banner = banner;
  return out;
}
