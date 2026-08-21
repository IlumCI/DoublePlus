import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Logo } from "./Logo";
import { Icon } from "./Icon";
import { ChainSelector, WalletButton } from "./wallet";

const LINKS = [
  { to: "/create", label: "Create Token", icon: "plus", end: false },
  { to: "/", label: "Explore", icon: "grid", end: true },
  { to: "/portfolio", label: "Portfolio", icon: "briefcase", end: false },
];

const TAB_ORDER = [LINKS[1], LINKS[0], LINKS[2]]; // Explore first on mobile

export function NavBar() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // "/" focuses the global search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    navigate(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/");
    inputRef.current?.blur();
  };

  return (
    <>
      <header className="nav">
        <div
          className="container"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            gap: 16,
          }}
        >
          <Link to="/" aria-label="Meridian home" style={{ justifySelf: "start" }}>
            <Logo />
          </Link>
          <nav className="nav-links" aria-label="Primary">
            {LINKS.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="row gap-2" style={{ justifySelf: "end" }}>
            <form
              className="nav-search"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Icon name="search" size={15} />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tokens"
                aria-label="Search tokens"
              />
              <kbd>/</kbd>
            </form>
            <ChainSelector />
            <WalletButton />
          </div>
        </div>
      </header>

      <nav className="mobile-tabs" aria-label="Primary mobile">
        {TAB_ORDER.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) => `mobile-tab${isActive ? " active" : ""}`}
          >
            <Icon name={l.icon} size={19} />
            {l.label === "Create Token" ? "Create" : l.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
