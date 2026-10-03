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
