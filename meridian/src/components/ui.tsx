import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../lib/store";
import { useInView } from "../lib/hooks";
import { Icon } from "./Icon";

/* Modal ------------------------------------------------------------------- */
export function Modal({
  open,
  onClose,
  children,
  width,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  if (!open) return null;
  // Portal to body: fixed positioning breaks inside ancestors with
  // backdrop-filter (they become the containing block), e.g. the nav.
  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal" style={width ? { maxWidth: width } : undefined}>
        {children}
      </div>
    </div>,
    document.body
  );
}

export function ModalHeader({
  title,
  onClose,
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="row between" style={{ marginBottom: 20 }}>
      <h3 className="h3">{title}</h3>
      <button className="icon-btn" onClick={onClose} aria-label="Close">
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

/* Toasts ------------------------------------------------------------------ */
export function ToastStack() {
  const { toasts } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.leaving ? " leaving" : ""}`}>
          <span
            style={{
              color:
                t.kind === "success"
                  ? "var(--up)"
                  : t.kind === "error"
                  ? "var(--down)"
                  : "var(--cyan)",
              marginTop: 1,
            }}
          >
            <Icon
              name={t.kind === "success" ? "check" : t.kind === "error" ? "alert" : "bell"}
              size={18}
            />
          </span>
          <div>
            <div style={{ fontWeight: 600, fontSize: "0.92rem" }}>{t.title}</div>
            {t.body && (
              <div className="muted" style={{ fontSize: "0.82rem", marginTop: 2 }}>
                {t.body}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* Skeleton ---------------------------------------------------------------- */
export function Skeleton({
  w,
  h = 16,
  r,
  style,
}: {
  w?: number | string;
  h?: number | string;
  r?: number | string;
  style?: CSSProperties;
}) {
  return (
    <div
      className="skeleton"
      style={{ width: w ?? "100%", height: h, borderRadius: r, ...style }}
    />
  );
}

/* Toggle ------------------------------------------------------------------ */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      className={`toggle${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
    />
  );
}

/* Scroll reveal wrapper ---------------------------------------------------- */
export function Reveal({
  children,
  delay = 0,
  style,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  style?: CSSProperties;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLDivElement>(0.12);
  return (
    <div
      ref={ref}
      className={`reveal${inView ? " visible" : ""} ${className}`}
      style={{ transitionDelay: `${delay}ms`, ...style }}
    >
      {children}
    </div>
  );
}

/* Status badge ------------------------------------------------------------- */
export function StatusBadge({ status }: { status: "confirmed" | "pending" | "failed" }) {
  const map = {
    confirmed: { cls: "up", label: "Confirmed", icon: "check" },
    pending: { cls: "warn", label: "Pending", icon: "clock" },
    failed: { cls: "down", label: "Failed", icon: "x" },
  } as const;
  const s = map[status];
  return (
    <span className={`badge ${s.cls}`}>
      <Icon name={s.icon} size={12} strokeWidth={2.2} />
      {s.label}
    </span>
  );
}
