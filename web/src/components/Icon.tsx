import type { ReactNode } from "react";

/**
 * Quiverpad icon set. One design language across every glyph: a 24px grid,
 * 2px strokes, round caps and joins, currentColor. Hand-built for this
 * product — no icon-pack imports. Brand marks (X, Telegram) are the only
 * intentional filled exceptions, since they must stay recognizable.
 */
export type IconName =
  | "explore"
  | "launch"
  | "search"
  | "wallet"
  | "buy"
  | "sell"
  | "trade"
  | "trending"
  | "new"
  | "graduated"
  | "volume"
  | "liquidity"
  | "marketcap"
  | "holders"
  | "transactions"
  | "activity"
  | "settings"
  | "notifications"
  | "external"
  | "copy"
  | "share"
  | "website"
  | "twitter"
  | "telegram"
  | "verified"
  | "token"
  | "contract"
  | "docs"
  | "refresh"
  | "filter"
  | "sort"
  | "favorite"
  | "more"
  | "back"
  | "forward"
  | "close";

const glyphs: Record<IconName, ReactNode> = {
  explore: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5 L13 13 L8.5 15.5 L11 11 Z" />
    </>
  ),
  launch: (
    <>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20 L16 16" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 8 A2 2 0 0 1 6 6 H17 A2 2 0 0 1 19 8 V9" />
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <path d="M15 13.5 H20" />
      <circle cx="15.6" cy="13.5" r="0.2" />
    </>
  ),
  buy: (
    <>
      <path d="M8 16 L16 8" />
      <path d="M10 8 H16 V14" />
    </>
  ),
  sell: (
    <>
      <path d="M8 8 L16 16" />
      <path d="M16 10 V16 H10" />
    </>
  ),
  trade: (
    <>
      <path d="M8 4 V20" />
      <path d="M5 7 L8 4 L11 7" />
      <path d="M16 20 V4" />
      <path d="M13 17 L16 20 L19 17" />
    </>
  ),
  trending: (
    <>
      <path d="M4 15 L9.5 9.5 L13 13 L20 6" />
      <path d="M15 6 H20 V11" />
    </>
  ),
  new: (
    <path d="M12 3.5 L13.7 9.8 L20 11.5 L13.7 13.2 L12 19.5 L10.3 13.2 L4 11.5 L10.3 9.8 Z" />
  ),
  graduated: (
    <>
      <path d="M3 9 L12 5 L21 9 L12 13 Z" />
      <path d="M6.5 11 V15.2 C6.5 16.4 9 17.5 12 17.5 C15 17.5 17.5 16.4 17.5 15.2 V11" />
      <path d="M21 9 V14" />
    </>
  ),
  volume: (
    <>
      <path d="M6 20 V13" />
      <path d="M12 20 V5" />
      <path d="M18 20 V10" />
    </>
  ),
  liquidity: <path d="M12 4 C12 4 6 10.5 6 15 A6 6 0 0 0 18 15 C18 10.5 12 4 12 4 Z" />,
  marketcap: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 12 V3.5" />
      <path d="M12 12 L19.4 16.3" />
    </>
  ),
  holders: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.8 18.5 C3.8 15 5.8 13.5 9 13.5 C12.2 13.5 14.2 15 14.2 18.5" />
      <path d="M15.5 6.4 A2.6 2.6 0 0 1 15.5 11.4" />
      <path d="M15.2 13.6 C18 14 20.2 15.3 20.2 18.5" />
    </>
  ),
  transactions: (
    <>
      <path d="M4 8.5 H16" />
      <path d="M13 5.5 L16 8.5 L13 11.5" />
      <path d="M20 15.5 H8" />
      <path d="M11 12.5 L8 15.5 L11 18.5" />
    </>
  ),
  activity: <path d="M3 12 H7 L9.5 6.5 L13.5 17.5 L15.5 12 H21" />,
  settings: (
    <>
      <path d="M4 8 H20" />
      <circle cx="9" cy="8" r="2.3" />
      <path d="M4 16 H20" />
      <circle cx="15" cy="16" r="2.3" />
    </>
  ),
  notifications: (
    <>
      <path d="M6.5 16 V11 A5.5 5.5 0 0 1 17.5 11 V16 L19 18 H5 Z" />
      <path d="M10 20.5 A2.2 2.2 0 0 0 14 20.5" />
    </>
  ),
  external: (
    <>
      <path d="M14 4 H20 V10" />
      <path d="M20 4 L11 13" />
      <path d="M17 14 V18 A2 2 0 0 1 15 20 H6 A2 2 0 0 1 4 18 V9 A2 2 0 0 1 6 7 H10" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 9 V6.5 A2.5 2.5 0 0 0 12.5 4 H6.5 A2.5 2.5 0 0 0 4 6.5 V12.5 A2.5 2.5 0 0 0 6.5 15 H9" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M8.2 10.9 L15.8 7.1" />
      <path d="M8.2 13.1 L15.8 16.9" />
    </>
  ),
  website: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12 H20.5" />
      <path d="M12 3.5 C15 7 15 17 12 20.5 C9 17 9 7 12 3.5 Z" />
    </>
  ),
  twitter: <path d="M17.2 4 H20 L13.9 11 L21 20 H15.4 L11 14.4 L6 20 H3.2 L9.7 12.5 L3 4 H8.7 L12.6 9.1 L17.2 4 Z" fill="currentColor" stroke="none" />,
  telegram: (
    <>
      <path d="M21 4.5 L3.5 11.2 C2.8 11.5 2.9 12.4 3.6 12.6 L8 14 L9.7 19.4 C9.9 20.1 10.8 20.2 11.2 19.7 L13.5 17.2 L17.8 20.4 C18.4 20.8 19.2 20.5 19.4 19.8 L21.9 5.6 C22.1 4.8 21.6 4.2 21 4.5 Z" />
      <path d="M8 14 L18 7" />
    </>
  ),
  verified: (
    <>
      <path d="M12 3 L14.6 4.9 L17.8 4.7 L18.9 7.7 L21.4 9.7 L20.3 12.7 L21 15.9 L17.9 16.9 L16.1 19.5 L13 18.7 L10 20 L8 17.5 L4.8 17.1 L4.6 13.9 L2.8 11.2 L4.8 8.7 L4.9 5.5 L8 4.6 Z" />
      <path d="M8.8 12 L11.2 14.4 L15.4 9.6" />
    </>
  ),
  token: (
    <>
      <path d="M12 3 L19.5 7.5 V16.5 L12 21 L4.5 16.5 V7.5 Z" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  contract: (
    <>
      <path d="M6.5 3.5 H14 L18 7.5 V19.5 A1.5 1.5 0 0 1 16.5 21 H6.5 A1.5 1.5 0 0 1 5 19.5 V5 A1.5 1.5 0 0 1 6.5 3.5 Z" />
      <path d="M14 3.5 V7.5 H18" />
      <path d="M8.5 12.5 H13.5" />
      <path d="M8.5 16 H12" />
    </>
  ),
  docs: (
    <>
      <path d="M6 3.5 H13 L18 8.5 V20 A1 1 0 0 1 17 21 H6 A1 1 0 0 1 5 20 V4.5 A1 1 0 0 1 6 3.5 Z" />
      <path d="M13 3.5 V8.5 H18" />
      <path d="M8.5 13 H14" />
      <path d="M8.5 16.5 H11.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11 A8 8 0 1 0 18.5 15.5" />
      <path d="M20 5 V11 H14" />
    </>
  ),
  filter: <path d="M4 5.5 H20 L13.8 12.5 V18.5 L10.2 16.5 V12.5 Z" />,
  sort: (
    <>
      <path d="M5 7 H19" />
      <path d="M5 12 H14" />
      <path d="M5 17 H9" />
    </>
  ),
  favorite: (
    <path d="M12 4 L14.5 9 L20 9.8 L16 13.7 L17 19.2 L12 16.5 L7 19.2 L8 13.7 L4 9.8 L9.5 9 Z" />
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  back: (
    <>
      <path d="M19 12 H5" />
      <path d="M11 6 L5 12 L11 18" />
    </>
  ),
  forward: (
    <>
      <path d="M5 12 H19" />
      <path d="M13 6 L19 12 L13 18" />
    </>
  ),
  close: (
    <>
      <path d="M6.5 6.5 L17.5 17.5" />
      <path d="M17.5 6.5 L6.5 17.5" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  strokeWidth = 2,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[name]}
    </svg>
  );
}
