import { useCallback, useEffect, useRef, useState } from "react";
import { useSignMessage } from "wagmi";

import { useWallet } from "../lib/useWallet";
import { env } from "../lib/env";
import {
  call,
  CONSOLE_ENABLED,
  ConsoleError,
  dropConsoleSession,
  ethFromWei,
  readConsoleSession,
  signIn,
  weiFromEth,
  type Income,
  type Ready,
  type Run,
  type RunRequest,
} from "./console";
import { usePageMeta } from "./seo";
import { short } from "./ui";

/**
 * The launch console: the pipeline that used to be a command line, as a page.
 *
 * The page holds no authority of its own. Everything it can do is what the
 * API worker lets a signed-in operator do, and how much of it is what the
 * service's own per-grant budget allows — which is why the allowance is shown
 * at the top rather than buried: it is the number that decides whether the
 * next launch happens.
 *
 * Live and dry run are shown as two separate buttons rather than a checkbox.
 * A checkbox remembers its last state, and a toggle left on from an hour ago
 * is how someone spends ETH they did not mean to.
 */
export function Console() {
  usePageMeta("Launch console");
  const { address, connectFirst } = useWallet();
  const { signMessageAsync } = useSignMessage();

  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (address) setToken(readConsoleSession(address));
  }, [address]);

  /** Run one call, re-signing once if the session has gone. */
  const withSession = useCallback(
    async <T,>(fn: (t: string) => Promise<T>): Promise<T | null> => {
      if (!address) {
        connectFirst();
        return null;
      }
      let t = token ?? readConsoleSession(address);
      try {
        if (!t) {
          t = await signIn(address, (m) => signMessageAsync({ message: m }));
          setToken(t);
        }
        return await fn(t);
      } catch (e) {
        if (e instanceof ConsoleError && e.status === 401) {
          dropConsoleSession(address);
          try {
            const fresh = await signIn(address, (m) => signMessageAsync({ message: m }));
            setToken(fresh);
            return await fn(fresh);
          } catch (again) {
            setNote(again instanceof Error ? again.message : "sign-in failed");
            setToken(null);
            return null;
          }
        }
        setNote(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [address, connectFirst, signMessageAsync, token],
  );

  const refresh = useCallback(async () => {
    const r = await withSession((t) => call<Ready>("/ready", t));
    if (r) {
      setReady(r);
      setNote(null);
    }
  }, [withSession]);

  useEffect(() => {
    if (!token) return;
    void refresh();
    const id = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 20_000);
    return () => clearInterval(id);
  }, [token, refresh]);

  if (!CONSOLE_ENABLED) {
    return (
      <div className="dp-shell" style={{ paddingBottom: 70 }}>
        <div className="dp-page-head">
          <h1 className="dp-page-title">Launch console</h1>
        </div>
        <p className="dp-agate">This build has no API worker configured, so the console is closed.</p>
      </div>
    );
  }

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Launch console</h1>
        <p style={{ maxWidth: "62ch", color: "var(--dim)", fontSize: 13 }}>
          Brief in, coin out: research, design, validate, then launch into this launchpad&apos;s own factory on{" "}
          {env.chainName}. Operators only.
        </p>
      </div>

      {note && (
        <p className="dp-agate" role="alert" style={{ color: "var(--warn, #c66)" }}>
          {note}
        </p>
      )}

      {!token ? (
        <p>
          <button
            type="button"
            className="dp-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setNote(null);
              await withSession(async () => null);
              setBusy(false);
            }}
          >
            {address ? "Sign in to the console" : "Connect a wallet"}
          </button>
        </p>
      ) : (
        <>
          <Allowance ready={ready} />
          <Design ready={ready} withSession={withSession} onLaunched={refresh} />
          <Loop ready={ready} withSession={withSession} onChanged={refresh} />
          <Earned withSession={withSession} />
          <p style={{ marginTop: 28 }}>
            <button
              type="button"
              className="dp-btn dp-btn-quiet"
              onClick={() => {
                if (address) dropConsoleSession(address);
                setToken(null);
                setReady(null);
              }}
            >
              Sign out
            </button>
          </p>
        </>
      )}
    </div>
  );
}

/** What this grant has left. The first thing an operator needs to know. */
function Allowance({ ready }: { ready: Ready | null }) {
  if (!ready) return <p className="dp-agate">Loading…</p>;
  const b = ready.budget;
  const rows: [string, string][] = [
    ["Launchpad", `${ready.tenant} on chain ${ready.chainId}`],
    ["Factory", short(ready.factory)],
    ["Designer", ready.model],
    ["Launches left", b.maxLaunches === undefined ? "no cap" : `${b.launchesLeft} of ${b.maxLaunches}`],
    [
      "Opening buys left",
      b.maxSpendWei === undefined
        ? "no cap"
        : `${ethFromWei(b.spendLeftWei ?? "0", 4)} ETH of ${ethFromWei(b.maxSpendWei, 4)} ETH`,
    ],
    ["Spent so far", `${ethFromWei(b.spentWei, 4)} ETH over ${b.launches} launches`],
    [
      "Live launches",
      ready.canSign ? "possible" : ready.maySign ? "off: the service is in dry-run mode" : "off: this grant may not sign",
    ],
  ];
  return (
    <>
      <h2 className="dp-page-title" style={{ fontSize: 16, marginTop: 24 }}>
        Allowance
      </h2>
      <dl className="dp-props">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {b.broken && (
        <p className="dp-agate" role="alert">
          {b.broken}
        </p>
      )}
    </>
  );
}

type WithSession = <T,>(fn: (t: string) => Promise<T>) => Promise<T | null>;

/** The brief, and the two buttons that act on it. */
function Design({
  ready,
  withSession,
  onLaunched,
}: {
  ready: Ready | null;
  withSession: WithSession;
  onLaunched: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [profile, setProfile] = useState("");
  const [firstBuy, setFirstBuy] = useState("0");
  const [profiles, setProfiles] = useState<{ id: string; displayName: string }[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | null>(null);

  useEffect(() => {
    void withSession((t) => call<{ profiles: { id: string; displayName: string }[] }>("/profiles", t)).then((r) => {
      if (r) setProfiles(r.profiles);
    });
    // Only on mount: the profile list does not change under a running console.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
    },
    [],
  );

  const start = async (mode: "design" | "dry" | "live") => {
    setError(null);
    const wei = weiFromEth(firstBuy);
    if (!wei.ok) {
      setError(`Opening buy: ${wei.error}`);
      return;
    }
    const body: RunRequest = {
      ...(topic.trim() ? { topic: topic.trim() } : {}),
      ...(profile ? { profile } : {}),
      ...(mode === "live" ? { live: true, firstBuyWei: wei.wei } : {}),
      ...(mode === "design" ? { designOnly: true } : {}),
      ...(mode === "dry" ? { firstBuyWei: wei.wei } : {}),
    };
    setBusy(true);
    const started = await withSession((t) => call<{ id: string }>("/runs", t, body));
    setBusy(false);
    if (!started) return;
    onLaunched();
    const watch = async () => {
      const r = await withSession((t) => call<Run>(`/runs/${started.id}`, t));
      if (!r) return;
      setRun(r);
      if (r.state !== "running" && r.state !== "queued") {
        if (poll.current) clearInterval(poll.current);
        poll.current = null;
        onLaunched();
      }
    };
    void watch();
    if (poll.current) clearInterval(poll.current);
    poll.current = window.setInterval(watch, 4_000);
  };

  const running = run?.state === "running" || run?.state === "queued";
  const noAllowance = ready?.budget.launchesLeft === 0 || ready?.budget.broken !== undefined;

  return (
    <>
      <h2 className="dp-page-title" style={{ fontSize: 16, marginTop: 28 }}>
        Design
      </h2>
      <p style={{ maxWidth: "62ch", color: "var(--dim)", fontSize: 13 }}>
        Leave the brief empty to have one written from the profile. A dry run simulates the launch against the real
        factory, so it fails for the same reasons a live one would.
      </p>
      <div style={{ display: "grid", gap: 10, maxWidth: 560, marginTop: 12 }}>
        <label>
          <span className="dp-agate">Brief</span>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value.slice(0, 2000))}
            rows={3}
            placeholder="an agent that watches a DEX for stale oracle prices"
            style={{ width: "100%" }}
          />
        </label>
        <label>
          <span className="dp-agate">Profile</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value)} style={{ width: "100%" }}>
            <option value="">the launchpad&apos;s default</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="dp-agate">Opening buy (ETH)</span>
          <input value={firstBuy} onChange={(e) => setFirstBuy(e.target.value)} inputMode="decimal" style={{ width: "100%" }} />
        </label>
      </div>

      {error && (
        <p className="dp-agate" role="alert" style={{ color: "var(--warn, #c66)" }}>
          {error}
        </p>
      )}

      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" className="dp-btn dp-btn-quiet" disabled={busy || running} onClick={() => start("design")}>
          Design only
        </button>
        <button type="button" className="dp-btn dp-btn-quiet" disabled={busy || running} onClick={() => start("dry")}>
          Dry run
        </button>
        {/* Separate from dry run on purpose: nothing here remembers that the
            last thing you did was live. */}
        <button
          type="button"
          className="dp-btn"
          disabled={busy || running || !ready?.canSign || noAllowance}
          onClick={() => start("live")}
        >
          Launch for real
        </button>
      </p>

      {run && <RunView run={run} withSession={withSession} />}
    </>
  );
}

function RunView({ run, withSession }: { run: Run; withSession: WithSession }) {
  const r = run.result;
  return (
    <div style={{ marginTop: 16 }}>
      <dl className="dp-props">
        <div>
          <dt>Run</dt>
          <dd>
            {run.state}
            {run.live ? " (live)" : " (dry run)"}
          </dd>
        </div>
        {r && (
          <>
            <div>
              <dt>Design</dt>
              <dd>
                {r.name} (${r.ticker}), {r.lines} lines
              </dd>
            </div>
            <div>
              <dt>Brief</dt>
              <dd>{r.brief}</dd>
            </div>
            {r.token && (
              <div>
                <dt>Coin</dt>
                <dd>{r.dryRun ? `${short(r.token)} (predicted, nothing signed)` : short(r.token)}</dd>
              </div>
            )}
            {r.txHash && (
              <div>
                <dt>Transaction</dt>
                <dd>{short(r.txHash)}</dd>
              </div>
            )}
          </>
        )}
        {run.error && (
          <div>
            <dt>Stopped</dt>
            <dd>{run.error}</dd>
          </div>
        )}
      </dl>
      {(run.state === "running" || run.state === "queued") && (
        <p>
          <button
            type="button"
            className="dp-btn dp-btn-quiet"
            onClick={() => void withSession((t) => call(`/runs/${run.id}/cancel`, t, {}))}
          >
            Cancel
          </button>
        </p>
      )}
      {run.log.length > 0 && (
        <pre
          className="dp-mono"
          style={{ maxHeight: 220, overflow: "auto", fontSize: 12, background: "var(--panel, #0002)", padding: 10 }}
        >
          {run.log.join("\n")}
          {run.logTruncated ? "\n…" : ""}
        </pre>
      )}
    </div>
  );
}

/** The persistent loop: one per launchpad, started and stopped from here. */
function Loop({
  ready,
  withSession,
  onChanged,
}: {
  ready: Ready | null;
  withSession: WithSession;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const l = ready?.loop;
  const act = async (path: string) => {
    setBusy(true);
    await withSession((t) => call(path, t, {}));
    setBusy(false);
    onChanged();
  };
  return (
    <>
      <h2 className="dp-page-title" style={{ fontSize: 16, marginTop: 28 }}>
        The loop
      </h2>
      <p style={{ maxWidth: "62ch", color: "var(--dim)", fontSize: 13 }}>
        Launches on its own, breeding the formats that earned and reaping the ones that did not. It stops on its income
        target, its launch cap, or when the market stops absorbing new coins — the last of which is the one worth
        reading, because it means supply ran ahead of demand rather than running out.
      </p>
      <dl className="dp-props">
        <div>
          <dt>State</dt>
          <dd>{l?.running ? "running" : (l?.stopped ?? "idle")}</dd>
        </div>
        <div>
          <dt>Launches</dt>
          <dd>{l?.launches ?? 0}</dd>
        </div>
        {l?.incomeEthWei && (
          <div>
            <dt>Measured income</dt>
            <dd>{ethFromWei(l.incomeEthWei, 5)} ETH</dd>
          </div>
        )}
        {l?.note && (
          <div>
            <dt>Note</dt>
            <dd>{l.note}</dd>
          </div>
        )}
      </dl>
      <p style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="dp-btn dp-btn-quiet"
          disabled={busy || l?.running === true || !ready?.canSign}
          onClick={() => void act("/loop/start")}
        >
          Start
        </button>
        <button type="button" className="dp-btn dp-btn-quiet" disabled={busy || !l?.running} onClick={() => void act("/loop/stop")}>
          Stop
        </button>
      </p>
    </>
  );
}

/** Fee income per format, which is what selection is measuring. */
function Earned({ withSession }: { withSession: WithSession }) {
  const [income, setIncome] = useState<Income | null>(null);
  const [asked, setAsked] = useState(false);
  return (
    <>
      <h2 className="dp-page-title" style={{ fontSize: 16, marginTop: 28 }}>
        What it earned
      </h2>
      {!asked ? (
        <p>
          <button
            type="button"
            className="dp-btn dp-btn-quiet"
            onClick={async () => {
              setAsked(true);
              const r = await withSession((t) => call<Income>("/income", t));
              if (r) setIncome(r);
            }}
          >
            Read the fee events
          </button>
        </p>
      ) : income === null ? (
        <p className="dp-agate">Reading the chain…</p>
      ) : (
        <>
          <dl className="dp-props">
            <div>
              <dt>Fee income</dt>
              <dd>
                {ethFromWei(income.totalEthWei, 5)} ETH over {income.coins.length} coins
              </dd>
            </div>
          </dl>
          <table className="dp-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>Format</th>
                <th>Coins</th>
                <th>Graduated</th>
                <th>Fees (ETH)</th>
              </tr>
            </thead>
            <tbody>
              {income.specs.map((s) => (
                <tr key={s.specId}>
                  <td className="dp-mono">{s.specId.slice(0, 10)}…</td>
                  <td>{s.coins}</td>
                  <td>{s.graduated}</td>
                  <td>{ethFromWei(s.totalEthWei, 5)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

export default Console;
