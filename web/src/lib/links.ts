/** Make creator-entered links clickable regardless of how they were typed:
 *  "@handle" becomes the platform URL, and a bare "x.com/…" gets https://
 *  (without it the browser treats it as a relative path on our own site). */
export function normalizeSocial(url: unknown, platform?: "x" | "telegram"): string | undefined {
  const s = String(url ?? "").trim();
  if (!s) return undefined;
  if (s.startsWith("@") && platform) {
    return platform === "x" ? `https://x.com/${s.slice(1)}` : `https://t.me/${s.slice(1)}`;
  }
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}
