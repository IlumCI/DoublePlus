const paths: Record<string, JSX.Element> = {
  wallet: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2" />
      <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2Z" />
      <circle cx="16.5" cy="13.5" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  zap: <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13L13 2Z" />,
  shield: (
    <>
      <path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6l-7-3Z" />
      <path d="m9 11.8 2.1 2.2L15 9.6" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="m7 14 3.5-4 3 2.5L18 7" />
    </>
  ),
  droplet: <path d="M12 3s6 6.2 6 10.5a6 6 0 0 1-12 0C6 9.2 12 3 12 3Z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.6 2.6 3.8 5.7 3.8 9S14.6 18.4 12 21c-2.6-2.6-3.8-5.7-3.8-9S9.4 5.6 12 3Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </>
  ),
  swap: (
    <>
      <path d="M7 4v13" />
      <path d="m3.5 7.5 3.5-3.5 3.5 3.5" />
      <path d="M17 20V7" />
      <path d="m13.5 16.5 3.5 3.5 3.5-3.5" />
    </>
  ),
  send: (
    <>
      <path d="M5 12h13" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  receive: (
    <>
      <path d="M19 12H6" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
  chevron: <path d="m7 10 5 5 5-5" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19 12c0-.5-.05-1-.15-1.4l2-1.55-2-3.45-2.35.95c-.75-.6-1.6-1.1-2.55-1.4L13.55 2h-4l-.4 2.55c-.9.3-1.75.8-2.5 1.4L4.3 5.6l-2 3.45 2 1.55c-.1.45-.15.9-.15 1.4s.05.95.15 1.4l-2 1.55 2 3.45 2.35-.95c.75.6 1.6 1.1 2.5 1.4l.4 2.55h4l.4-2.55c.95-.3 1.8-.8 2.55-1.4l2.35.95 2-3.45-2-1.55c.1-.4.15-.9.15-1.4Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  home: (
    <>
      <path d="m4 11 8-7 8 7" />
      <path d="M6 9.5V20h12V9.5" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <rect x="13" y="13" width="7" height="7" rx="2" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M19 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.2" r="0.5" fill="currentColor" stroke="none" />
    </>
  ),
  approve: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 9.5a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13.5 6 9.5Z" />
      <path d="M10 18.5a2 2 0 0 0 4 0" />
    </>
  ),
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
  star: (
    <path d="m12 3.5 2.5 5.3 5.8.7-4.3 4 1.1 5.7L12 16.4l-5.1 2.8 1.1-5.7-4.3-4 5.8-.7L12 3.5Z" />
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 15c4.5-1.5 7-6 7-11-5 0-9.5 2.5-11 7l-3.5 1 2.5 2.5L12 15Z" />
      <path d="M9 15c-1.5.5-2.5 2-3 5 3-.5 4.5-1.5 5-3" />
      <circle cx="14" cy="10" r="1.4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5c.7-3.2 2.8-5 5.5-5s4.8 1.8 5.5 5" />
      <path d="M15.5 5.7a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.4 14.8c1.7.7 2.8 2.3 3.1 4.7" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2.5" />
      <path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5" />
      <path d="M3.5 12.5h17" />
    </>
  ),
  flame: (
    <path d="M12 3s1 2.6 1 4.4c0 1.4-.9 2.3-2 2.3s-2-.9-2-2.2c-1.9 1.6-3 3.8-3 6A6.9 6.9 0 0 0 12 21a6.9 6.9 0 0 0 7-7.1C19 9.5 15.5 5.4 12 3Z" />
  ),
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.5 12.8 4.7a3.8 3.8 0 0 1 5.4 0l1.1 1.1a3.8 3.8 0 0 1 0 5.4L17.5 13" />
      <path d="M13 17.5 11.2 19.3a3.8 3.8 0 0 1-5.4 0l-1.1-1.1a3.8 3.8 0 0 1 0-5.4L6.5 11" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.7,
}: {
  name: keyof typeof paths | string;
  size?: number;
  className?: string;
  strokeWidth?: number;
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
    >
      {paths[name] ?? null}
    </svg>
  );
}
