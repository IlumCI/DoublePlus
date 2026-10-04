import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { Venture } from "./client";
import { useSwitchChain } from "wagmi";

import { Toasts } from "../components/ui";
import { BRAND } from "../lib/brand";
import { env } from "../lib/env";
import { useWallet } from "../lib/useWallet";
import { Board } from "./Board";
import { Boundary } from "./Boundary";
import { NotFound } from "./HttpCat";
import { VENTURE } from "./client";
import { captureRef } from "./referral";
import { FilterDefs } from "./ui";
import { Sidebar } from "./longhorn/Sidebar";
import { Wallpaper } from "./longhorn/Wallpaper";
import { useVentures } from "./useVentures";
import { diffWatched, notify } from "./alerts";
import { useUi } from "../store";
import "./venture.css";
import "./longhorn.css";

captureRef();

// The board is the landing page and ships with the app; every other page is
// its own chunk, so the chart libraries (klinecharts, recharts) and the
// trade/launch flows only download when someone opens them.
const VenturePage = lazy(() => import("./coin").then((m) => ({ default: m.VenturePage })));
const LaunchVenture = lazy(() => import("./Launch").then((m) => ({ default: m.LaunchVenture })));
const Desk = lazy(() => import("./Desk").then((m) => ({ default: m.Desk })));
const Flywheel = lazy(() => import("./Flywheel").then((m) => ({ default: m.Flywheel })));
const Stats = lazy(() => import("./Stats").then((m) => ({ default: m.Stats })));
const Docs = lazy(() => import("./Docs").then((m) => ({ default: m.Docs })));
const Legal = lazy(() => import("./Legal"));

/** Shown in the window body while a page chunk loads. */
function PageLoading() {
  return <div className="lh-loading" role="status"><i /><span>Loading…</span></div>;
}

const NAV: [string, string][] = [
  ["/", "Coins"],
  ["/desk", "Portfolio"],
  ["/rewards", "Rewards"],
  ["/stats", "Stats"],
  ["/docs", "How it works"],
];

/** doubleplus: day-zero funding for startups and research projects. */
export function VentureApp() {
  return (
    <BrowserRouter>
      <Routes>
        {/* The legal document renders outside the app chrome on purpose: no
            desktop, no window, no marketing furniture. It is a document that
            happens to live at a URL. */}
        <Route path="/legal" element={<Suspense fallback={null}><Legal /></Suspense>} />
        <Route path="*" element={<Shell />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}

/** Where the window is, as breadcrumb segments: [label, link][]. */
function usePlace(ventures: Venture[] | null): [string, string][] {
  const { pathname } = useLocation();
  if (pathname.startsWith("/venture/")) {
    const addr = pathname.split("/")[2]?.toLowerCase();
    const v = ventures?.find((x) => x.address.toLowerCase() === addr);
    return [["Coins", "/"], [v ? `$${v.symbol}` : "Coin", pathname]];
  }
  if (pathname === "/launch") return [["Launch a coin", "/launch"]];
  const hit = NAV.find(([to]) => to === pathname);
  return [hit ? [hit[1], hit[0]] : ["Coins", "/"]];
}

function readPref(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}
function writePref(key: string, on: boolean) {
  try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* private mode: the toggle just won't stick */ }
}

/**
 * The Longhorn desktop: live aurora wallpaper, one application window holding
 * the launchpad, the Sidebar of market gadgets, and the taskbar. The window's
 * caption buttons work: minimise to the taskbar, maximise over the Sidebar.
 */
function Shell() {
  const { ventures } = useVentures();
  const place = usePlace(ventures);
  const title = place[place.length - 1][0];
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(() => readPref("lh-max"));

  // The window body is the scroller now, so each navigation starts at its top.
  useEffect(() => { mainRef.current?.scrollTo(0, 0); setMinimized(false); }, [pathname]);

  // Alerts for coins the viewer chose to watch, diffed on every board poll.
  const navigate = useNavigate();
  const pushToast = useUi((s) => s.pushToast);
  useEffect(() => {
    if (!ventures) return;
    for (const a of diffWatched(ventures)) {
      pushToast({ kind: "info", title: a.title, body: a.body });
      notify(a, () => navigate(`/venture/${a.token}`));
    }
  }, [ventures, navigate, pushToast]);

  // Flare the wallpaper when money comes in anywhere on the board.
  const [pulse, setPulse] = useState(0);
  const raised = useRef<bigint | null>(null);
  useEffect(() => {
    if (!ventures) return;
    const total = ventures.reduce((a, v) => a + v.raisedWei, 0n);
    if (raised.current !== null && total > raised.current) setPulse((n) => n + 1);
    raised.current = total;
  }, [ventures]);

  const toggleMax = () => setMaximized((m) => { writePref("lh-max", !m); return !m; });

  return (
    <>
      <FilterDefs />
      <Wallpaper pulse={pulse} />
      <div className={`lh-desk${maximized ? " is-max" : ""}`}>
        <div className={`lh-window${minimized ? " is-min" : ""}`} role="application" aria-label={`${title} - ${BRAND.name}`}>
          <div className="lh-title" onDoubleClick={toggleMax}>
            <span className="lh-appicon" aria-hidden="true">++</span>
            <span className="lh-title-text">{title} - {BRAND.name}</span>
            <div className="lh-caps">
              <button className="lh-cap" onClick={() => setMinimized(true)} title="Minimise" aria-label="Minimise window"><i className="lh-ico-min" /></button>
              <button className="lh-cap" onClick={toggleMax} title={maximized ? "Restore" : "Maximise"} aria-label={maximized ? "Restore window" : "Maximise window"}><i className={maximized ? "lh-ico-restore" : "lh-ico-max"} /></button>
              <CloseCap />
            </div>
          </div>
          <AddressBar place={place} />
          <ChainBar />
          <div className="lh-body">
            <TaskPane />
            <main ref={mainRef} className="lh-client">
              <Boundary key={pathname}>
              <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/" element={<Board />} />
                <Route path="/venture/:address" element={<VenturePage />} />
                <Route path="/launch" element={<LaunchVenture />} />
                <Route path="/desk" element={<Desk />} />
                <Route path="/rewards" element={<Flywheel />} />
                <Route path="/stats" element={<Stats />} />
                <Route path="/docs" element={<Docs />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
              </Suspense>
              </Boundary>
            </main>
          </div>
          <StatusBar />
        </div>
        {!maximized && <Sidebar ventures={ventures} />}
      </div>
      <Taskbar title={title} minimized={minimized} onTask={() => setMinimized((m) => !m)} />
    </>
  );
}

/** Close returns to the board; on the board itself there is nothing to close. */
function CloseCap() {
  const navigate = useNavigate();
  const onBoard = useLocation().pathname === "/";
  return (
    <button className="lh-cap lh-cap-close" onClick={() => navigate("/", { viewTransition: true })} disabled={onBoard}
      title={onBoard ? "Close" : "Close page (back to Coins)"} aria-label="Close page">
      <i className="lh-ico-close" />
    </button>
  );
}

/** Explorer's address bar: back/forward, a breadcrumb of where you are, and search. */
function AddressBar({ place }: { place: [string, string][] }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const [q, setQ] = useState(params.get("q") ?? "");

  // Keep the field in step with the URL when the board clears its own filters.
  useEffect(() => { setQ(params.get("q") ?? ""); }, [params]);

  const search = (value: string) => {
    setQ(value);
    const next = new URLSearchParams(location.pathname === "/" ? params : undefined);
    if (value) next.set("q", value); else next.delete("q");
    navigate({ pathname: "/", search: next.toString() }, { replace: location.pathname === "/" });
  };

  return (
    <div className="lh-addr">
      <div className="lh-nav-btns">
        <button className="lh-round" onClick={() => navigate(-1)} aria-label="Back" title="Back">‹</button>
        <button className="lh-round" onClick={() => navigate(1)} aria-label="Forward" title="Forward">›</button>
      </div>
      <nav className="lh-crumbs" aria-label="Breadcrumb">
        <Link to="/" viewTransition className="lh-crumb-root">{BRAND.domain}</Link>
        {place.map(([label, to], i) => (
          <span key={to}>
            <span className="lh-sep" aria-hidden="true">▸</span>
            {i === place.length - 1
              ? <span aria-current="page">{label}</span>
              : <Link to={to} viewTransition>{label}</Link>}
          </span>
        ))}
      </nav>
      <div className="lh-search">
        <input value={q} onChange={(e) => search(e.target.value)} placeholder="Search coins" aria-label="Search coins" />
      </div>
      <WalletButton className="lh-addr-wallet" />
    </div>
  );
}

/** Explorer's left task pane, as launchpad tasks. */
function TaskPane() {
  return (
    <nav className="lh-pane" aria-label="Primary">
      <section>
        <h2>Coin tasks</h2>
        <Link className="lh-task lh-task-go" to="/launch" viewTransition>Launch a coin</Link>
        {NAV.slice(0, 2).map(([to, label]) => (
          <NavLink key={to} className="lh-task" to={to} end={to === "/"} viewTransition>{label}</NavLink>
        ))}
      </section>
      <section>
        <h2>Other places</h2>
        {NAV.slice(2, 4).map(([to, label]) => (
          <NavLink key={to} className="lh-task" to={to} viewTransition>{label}</NavLink>
        ))}
      </section>
      <section>
        <h2>Help</h2>
        <NavLink className="lh-task" to="/docs" viewTransition>How it works</NavLink>
        <Link className="lh-task" to="/legal" viewTransition>Terms</Link>
        <a className="lh-task" href={BRAND.twitter} target="_blank" rel="noreferrer">@{BRAND.twitterHandle} on X</a>
      </section>
      <section className="lh-details">
        <h2>Details</h2>
        <p><b>{env.chainName}</b></p>
        <p>Platform fee {(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade</p>
        <p>{VENTURE.refShareBps / 100}% of that goes to referrers</p>
      </section>
    </nav>
  );
}

function WalletButton({ className }: { className: string }) {
  const { address, isConnected, connectFirst, disconnect, isPending } = useWallet();
  return isConnected && address ? (
    <button className={`lh-wallet is-on ${className}`} onClick={() => disconnect()} title="Disconnect">
      <i className="lh-dot" />{`${address.slice(0, 4)}…${address.slice(-4)}`}
    </button>
  ) : (
    <button className={`lh-wallet ${className}`} onClick={connectFirst} disabled={isPending}>
      {isPending ? "Connecting…" : "Connect wallet"}
    </button>
  );
}

/** The taskbar: Start, the running window, and the tray (wallet, network). No clock. */
function Taskbar({ title, minimized, onTask }: { title: string; minimized: boolean; onTask: () => void }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div className="lh-taskbar" ref={ref}>
      <button className={`lh-start${open ? " is-open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        start
      </button>
      {open && <StartMenu />}
      <button className={`lh-taskbtn${minimized ? "" : " is-active"}`} onClick={onTask} title={minimized ? "Restore window" : "Minimise window"}>
        <span className="lh-appicon" aria-hidden="true">++</span>{title}
      </button>
      <nav className="lh-tasknav" aria-label="Pages">
        {NAV.slice(0, 4).map(([to, label]) => (
          <NavLink key={to} to={to} end={to === "/"} viewTransition>{label}</NavLink>
        ))}
      </nav>
      <div className="lh-tray">
        <WalletButton className="lh-tray-wallet" />
        <span className="lh-tray-net" title={env.chainName}><i className="lh-dot" /></span>
      </div>
    </div>
  );
}

function StartMenu() {
  return (
    <div className="lh-startmenu" role="menu">
      <div className="lh-sm-head"><span className="lh-appicon">++</span>{BRAND.name}{BRAND.tld}</div>
      <div className="lh-sm-cols">
        <div className="lh-sm-main">
          <Link role="menuitem" className="lh-sm-go" to="/launch" viewTransition>
            <b>Launch a coin</b><span>Name it, set your cut, open the curve</span>
          </Link>
          {NAV.map(([to, label]) => (
            <Link key={to} role="menuitem" to={to} viewTransition><b>{label}</b></Link>
          ))}
        </div>
        <div className="lh-sm-side">
          <a role="menuitem" href={BRAND.twitter} target="_blank" rel="noreferrer">@{BRAND.twitterHandle}</a>
          {env.explorerUrl && <a role="menuitem" href={env.explorerUrl} target="_blank" rel="noreferrer">Block explorer</a>}
          <Link role="menuitem" to="/legal" viewTransition>Terms</Link>
        </div>
      </div>
    </div>
  );
}

/** Wrong network is the most common reason a trade fails. Say so, and fix it. */
function ChainBar() {
  const { isConnected, chainId } = useWallet();
  const { switchChain } = useSwitchChain();
  if (!isConnected || !chainId || chainId === env.chainId) return null;
  return (
    <div className="lh-infobar" role="alert">
      <span>Your wallet is on another network. {BRAND.name} runs on {env.chainName}.</span>
      <button className="lh-wallet" onClick={() => switchChain({ chainId: env.chainId })}>
        Switch to {env.chainName}
      </button>
    </div>
  );
}

/** The window's status bar carries what the footer used to. */
function StatusBar() {
  return (
    <div className="lh-status">
      <span>{env.chainName}</span>
      {/* Read from config, never hardcoded: this line is on every page, so a
          stale number here is the fee statement most users actually see. It
          said 1% for the whole period the hook charged 0.55%. */}
      <span>
        Platform fee {(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade, {VENTURE.refShareBps / 100}% of that to referrers
      </span>
      {env.explorerUrl && <a href={env.explorerUrl} target="_blank" rel="noreferrer">Block explorer</a>}
      <Link to="/legal" viewTransition>Terms</Link>
    </div>
  );
}
