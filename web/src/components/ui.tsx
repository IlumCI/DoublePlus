import { type ReactNode } from "react";

import { explorerTx } from "../lib/format";
import { useUi } from "../store";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-edge bg-panel ${className}`}>{children}</div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "up" | "down" | "accent" | "amber";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-panel-2 text-ink-2",
    up: "bg-up/10 text-up",
    down: "bg-down/10 text-down",
    accent: "bg-accent/60 text-ink",
    amber: "bg-panel-2 text-ink-2",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Buttons are quiet pills. Ink is the primary voice (wallet, launch, trade);
 * lime is reserved for Buy, where black text keeps it readable, not neon.
 */
export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "dark" | "ghost" | "buy" | "sell" | "danger";
  className?: string;
  type?: "button" | "submit";
}) {
  const variants: Record<string, string> = {
    primary: "bg-accent text-ink hover:bg-accent-2 disabled:bg-panel-2 disabled:text-ink-3",
    dark: "bg-ink text-bg hover:opacity-90 disabled:bg-panel-2 disabled:text-ink-3",
    ghost:
      "bg-panel border border-edge text-ink hover:border-edge-2 hover:bg-panel-2/60 disabled:text-ink-3",
    buy: "bg-up text-white hover:brightness-110 disabled:bg-panel-2 disabled:text-ink-3",
    sell: "bg-down text-white hover:brightness-110 disabled:bg-panel-2 disabled:text-ink-3",
    danger: "bg-down text-white hover:brightness-105 disabled:opacity-50",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`h-12 rounded-full px-6 text-[14px] font-semibold transition-all duration-150 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="whitespace-nowrap text-[13px] font-medium text-ink">{label}</span>
        {hint ? <span className="truncate text-xs text-ink-3">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border border-edge bg-panel px-4 py-3 text-sm text-ink placeholder:text-ink-3 outline-none transition-colors focus:border-ink/30";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-panel-2 ${className}`} />;
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {body ? <p className="mt-1 max-w-sm text-xs text-ink-3">{body}</p> : null}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useUi();
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-sm flex-col gap-2 sm:inset-x-auto sm:right-4 sm:mx-0 sm:w-80"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`toast-enter flex items-start gap-3 rounded-2xl border bg-panel p-3.5 shadow-[var(--shadow-card-hover)] ${
            t.kind === "error" ? "border-down/40" : t.kind === "success" ? "border-up/40" : "border-edge"
          }`}
        >
          <span
            className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${
              t.kind === "error"
                ? "bg-down/10 text-down"
                : t.kind === "success"
                  ? "bg-up/10 text-up"
                  : "bg-panel-2 text-ink-2"
            }`}
            aria-hidden
          >
            {t.kind === "error" ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            ) : t.kind === "success" ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 6.5l2.6 2.6L10 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6 5.6v2.6M6 3.9v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-5 text-ink">{t.title}</p>
            {t.body ? <p className="mt-0.5 break-words text-xs leading-4 text-ink-2">{t.body}</p> : null}
            {t.txHash && explorerTx(t.txHash) ? (
              <a
                href={explorerTx(t.txHash)!}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-xs font-medium text-ink underline underline-offset-2"
              >
                View transaction
              </a>
            ) : null}
          </div>
          <button
            onClick={() => dismissToast(t.id)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-panel-2 hover:text-ink"
            aria-label="Dismiss"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
