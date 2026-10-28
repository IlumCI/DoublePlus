import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useBalance, useWalletClient } from "wagmi";
import { formatEther, parseEther, zeroAddress, type Address } from "viem";

import { confirmTx, ercAbi, sendTx, venturePc, type PoolTrade, type Venture } from "../client";
import { dayStats, HOUSE, loadHouseHolders, loadHouseTrades, loadHouseVenture, portalAbi } from "../house";
import { useDexProfile } from "../../lib/dexscreener";
import { PriceChart, TradeTape } from "../Chart";
import { ShareBar } from "../share";
import { Comments, COMMENTS_ENABLED } from "../comments";
import { usePageMeta } from "../seo";
import { priceImpactPct } from "../curve";
import { ago, CopyButton, fmtEth, fmtMcap, fmtTok, fmtUsdV, Monogram, pct, short, StatCell, useEthUsd } from "../ui";
import { env } from "../../lib/env";
import { useWallet, errorText } from "../../lib/useWallet";
import { useUi } from "../../store";
import { AddToWallet, Socials } from "./Header";

type Tab = "chat" | "trades" | "holders" | "contract";
type Holder = { address: Address; balance: bigint };

/** $DOUBLEPLUS on Flap: the market screen of our own coin pages, read from
 *  Flap's Portal and traded through it. */
export function HousePage() {
  const [v, setV] = useState<Venture | null>(null);
  const [trades, setTrades] = useState<PoolTrade[]>([]);
  const [holders, setHolders] = useState<Holder[]>([]);
  const [down, setDown] = useState(false);
  const ethUsd = useEthUsd();
  const dex = useDexProfile(HOUSE.token);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || (COMMENTS_ENABLED ? "chat" : "trades");
  const setTab = (next: Tab) => { const p = new URLSearchParams(params); p.set("tab", next); setParams(p, { replace: true }); };

  useEffect(() => {
    let live = true;
    const refresh = () => {
      loadHouseVenture().then((x) => { if (live) { setV(x); setDown(false); } }).catch(() => live && setDown(true));
      loadHouseTrades().then((t) => live && setTrades(t)).catch(() => undefined);
      loadHouseHolders().then((h) => live && setHolders(h)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  usePageMeta(v ? `${v.name} ($${v.symbol})` : null, v?.meta.pitch);
  const day = useMemo(() => dayStats(trades), [trades]);

  if (!v) {
    return <div className="dp-shell" style={{ padding: "80px 18px", textAlign: "center", color: "var(--faint)" }}>
      {down ? "Can't reach Robinhood Chain. Retrying…" : "Loading…"}
    </div>;
  }
  const progress = v.phase === "graduated" ? 100 : pct(v.raisedWei, v.targetRaiseWei);
  const held = holders.reduce((s, h) => s + h.balance, 0n);
  const top10 = held > 0n ? pct(holders.slice(0, 10).reduce((s, h) => s + h.balance, 0n), held) : 0;
  const money = (wei: bigint) => ethUsd > 0 ? fmtUsdV((Number(wei) / 1e18) * ethUsd) : `${fmtEth(wei, 3)} ETH`;

  const TABS: [Tab, string][] = [
    ...(COMMENTS_ENABLED ? ([["chat", "Chat"]] as [Tab, string][]) : []),
    ["trades", "Trades"], ["holders", "Holders"], ["contract", "Contract"],
  ];

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-coinhead">
        <Monogram v={v} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h1>{v.name} <span className="dp-mono" style={{ fontSize: 14, color: "var(--dim)" }}>${v.symbol}</span></h1>
          {(v.meta.pitch || v.meta.description) && <p className="dp-oneliner">{v.meta.pitch || v.meta.description}</p>}
          <p className="dp-prov" style={{ margin: "4px 0 0" }}>
            CA <CopyButton value={v.address} label={`${short(v.address)} ⧉`} /> · created by <b>{short(v.creator)}</b> · {ago(v.createdAt)} ago
            {" "}· <a className="dp-badge dp-open" href={HOUSE.url} target="_blank" rel="noopener">on Flap ↗</a> <AddToWallet v={v} />
          </p>
          <Socials meta={v.meta} dex={dex} />
        </div>
        <div className="dp-mcbig">
          <span className="dp-k">market cap</span><br />
          <span className="dp-v">{fmtMcap(v, ethUsd)}</span><br />
          <HouseBag />
        </div>
      </div>

      <div className="dp-statbar">
        <StatCell k={v.phase === "graduated" ? "on DEX" : "curve"}>{progress < 1 ? progress.toFixed(2) : progress.toFixed(0)}%</StatCell>
        <StatCell k="in the curve">{money(v.raisedWei)}</StatCell>
        <StatCell k="24h vol">{money(day.volWei)}</StatCell>
        <StatCell k="24h buys / sells">{day.buys} / {day.sells}</StatCell>
        <StatCell k="holders">{holders.length}</StatCell>
        <StatCell k="top 10">{top10.toFixed(1)}%</StatCell>
      </div>

      <div className="dp-coingrid">
        <div className="dp-coinmain">
          <PriceChart v={v} trades={trades} />

          <div className="dp-tabbar">
            {TABS.map(([k, label]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}{k === "holders" && holders.length > 0 && <span className="dp-cnt"> ({holders.length})</span>}
              </button>
            ))}
          </div>
          {COMMENTS_ENABLED && <div className="dp-tabpane" hidden={tab !== "chat"}><Comments v={v} /></div>}
          <div className="dp-tabpane" hidden={tab !== "trades"}>
            {trades.length ? <TradeTape v={v} trades={trades} /> : <p className="dp-agate">No trades yet.</p>}
          </div>
          <div className="dp-tabpane" hidden={tab !== "holders"}><Holders holders={holders} held={held} symbol={v.symbol} /></div>
          <div className="dp-tabpane" hidden={tab !== "contract"}><Contract v={v} /></div>
        </div>

        <div className="dp-coinside">
          <HouseTrade v={v} ethUsd={ethUsd} />
          <ShareBar v={v} />
        </div>
      </div>
    </div>
  );
}

function Holders({ holders, held, symbol }: { holders: Holder[]; held: bigint; symbol: string }) {
  if (holders.length === 0) return <p className="dp-agate">No holders yet.</p>;
  return (
    <table className="dp-holders" style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        {holders.slice(0, 50).map((h) => {
          const share = pct(h.balance, held);
          return (
            <tr key={h.address}>
              <td className="dp-mono">{short(h.address)}{h.address === HOUSE.creator.toLowerCase() && <span className="dp-agate"> dev</span>}</td>
              <td style={{ width: "34%" }}><div className="dp-bar"><i style={{ ["--pct" as string]: `${share}%` }} /></div></td>
              <td className="dp-mono">{fmtTok(h.balance)} ${symbol}</td>
              <td className="dp-mono" style={{ textAlign: "right" }}>{share.toFixed(2)}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Contract({ v }: { v: Venture }) {
  const rows: [string, Address][] = [["Token", v.address], ["Flap Portal", HOUSE.portal], ["Creator", v.creator]];
  return (
    <div className="dp-sheet">
      <p className="dp-sec">Contracts</p>
      {rows.map(([k, a]) => (
        <p key={k} className="dp-prov">
          {k} <CopyButton value={a} label={`${a} ⧉`} />
          {env.explorerUrl && <> · <a href={`${env.explorerUrl}/address/${a}`} target="_blank" rel="noreferrer">explorer ↗</a></>}
        </p>
      ))}
      <p className="dp-prov">Buy tax {v.policy.buyTaxBps / 100}% · sell tax {v.policy.sellTaxBps / 100}% · 1B supply</p>
    </div>
  );
}

function HouseBag() {
  const { address: me } = useWallet();
  const [bal, setBal] = useState<bigint | null>(null);
  useEffect(() => {
    if (!me) { setBal(null); return; }
    let live = true;
    const read = () => venturePc.readContract({ address: HOUSE.token, abi: ercAbi, functionName: "balanceOf", args: [me] })
      .then((x) => live && setBal(x)).catch(() => undefined);
    read();
    const id = setInterval(read, 12_000);
    return () => { live = false; clearInterval(id); };
  }, [me]);
  if (!bal) return null;
  return <span className="dp-k">you hold {fmtTok(bal)}</span>;
}

// Any plain address can price a trade before a wallet connects.
const QUOTE_WALLET = "0x000000000000000000000000000000000000dEaD" as const;
// Measured on a mainnet fork: a buy ~420k gas, a sell ~330k.
const SWAP_GAS = 900_000n;

/** Market buy and sell through Flap's Portal, quoted by the Portal itself. */
function HouseTrade({ v, ethUsd }: { v: Venture; ethUsd: number }) {
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [bal, setBal] = useState(0n);
  const [slipBps, setSlipBps] = useState(300);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [fee, setFee] = useState<{ buy: number; sell: number } | null>(null);
  const eth = useBalance({ address: me });

  useEffect(() => {
    venturePc.readContract({ address: HOUSE.portal, abi: portalAbi, functionName: "getFeeRate" })
      .then(([b, s]) => setFee({ buy: Number(b), sell: Number(s) })).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!me) return;
    let live = true;
    const read = () => venturePc.readContract({ address: HOUSE.token, abi: ercAbi, functionName: "balanceOf", args: [me] })
      .then((x) => live && setBal(x)).catch(() => undefined);
    read();
    const id = setInterval(read, 12_000);
    return () => { live = false; clearInterval(id); };
  }, [me, busy]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);
  const path = side === "buy" ? { inputToken: zeroAddress, outputToken: HOUSE.token } : { inputToken: HOUSE.token, outputToken: zeroAddress };

  useEffect(() => {
    setQuote(null);
    if (parsed === 0n) return;
    let live = true;
    setQuoting(true);
    const id = setTimeout(() => {
      venturePc.simulateContract({ address: HOUSE.portal, abi: portalAbi, functionName: "quoteExactInput", args: [{ ...path, inputAmount: parsed }], account: me ?? QUOTE_WALLET })
        .then((r) => { if (live) setQuote(r.result); })
        .catch(() => { if (live) setQuote(null); })
        .finally(() => { if (live) setQuoting(false); });
    }, 350);
    return () => { live = false; clearTimeout(id); };
  }, [parsed, side, me]);

  const minOut = quote !== null ? (quote * BigInt(10_000 - slipBps)) / 10_000n : 0n;
  const shortOnEth = side === "buy" && eth.data !== undefined && parsed > eth.data.value;
  const shortOnTokens = side === "sell" && parsed > bal;
  const taxBps = side === "buy" ? v.policy.buyTaxBps : v.policy.sellTaxBps;
  const feeBps = fee ? (side === "buy" ? fee.buy : fee.sell) : 0;

  const go = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n || quote === null) return;
    setBusy(true);
    try {
      if (side === "sell") {
        const allowance = await venturePc.readContract({ address: HOUSE.token, abi: ercAbi, functionName: "allowance", args: [wc.account.address, HOUSE.portal] });
        if (allowance < parsed) {
          await confirmTx(await sendTx(wc, { address: HOUSE.token, abi: ercAbi, functionName: "approve", args: [HOUSE.portal, 2n ** 256n - 1n], chain: wc.chain, account: wc.account }));
        }
      }
      const hash = await sendTx(wc, {
        address: HOUSE.portal, abi: portalAbi, functionName: "swapExactInput",
        args: [{ ...path, inputAmount: parsed, minOutputAmount: minOut, permitData: "0x" }],
        value: side === "buy" ? parsed : 0n, gas: SWAP_GAS, chain: wc.chain, account: wc.account,
      });
      pushToast({ kind: "info", title: `${side === "buy" ? "Buy" : "Sell"} submitted`, txHash: hash });
      await confirmTx(hash);
      pushToast({ kind: "success", title: `${side === "buy" ? "Buy" : "Sell"} confirmed`, txHash: hash });
      setAmt("");
    } catch (e) {
      pushToast({ kind: "error", title: "Trade failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-tb-tabs">
        <button className={`dp-buy ${side === "buy" ? "on" : ""}`} onClick={() => { setSide("buy"); setAmt(""); }}>Buy</button>
        <button className={`dp-sell ${side === "sell" ? "on" : ""}`} onClick={() => { setSide("sell"); setAmt(""); }}>Sell</button>
      </div>
      <div className="dp-tb-body">
        <div className="dp-tb-amt">
          <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span>{side === "buy" ? "ETH" : `$${v.symbol}`}</span>
        </div>
        <div className="dp-quicks">
          {side === "buy"
            ? ["0.005", "0.01", "0.05", "0.1"].map((q) => <button key={q} onClick={() => setAmt(q)}>{q}</button>)
            : ["25%", "50%", "75%", "max"].map((q, i) => (
              <button key={q} onClick={() => setAmt(formatEther(bal * BigInt([25, 50, 75, 100][i]) / 100n))}>{q}</button>
            ))}
        </div>
        <p className="dp-tb-est">
          {parsed === 0n ? <span style={{ color: "var(--faint)" }}>Enter an amount to see what you get.</span>
            : quoting ? <span style={{ color: "var(--faint)" }}>Quoting…</span>
            : quote === null ? <span style={{ color: "var(--down)" }}>Could not quote this trade.</span>
            : side === "buy" ? <>you receive ≈ <b>{fmtTok(quote)} ${v.symbol}</b>{ethUsd > 0 && <span style={{ color: "var(--faint)" }}> · {fmtUsdV((Number(parsed) / 1e18) * ethUsd)}</span>}
                {priceImpactPct("buy", parsed, quote, v.priceWei, taxBps + feeBps) >= 1 && <span style={{ color: "var(--faint)" }}> · price impact {priceImpactPct("buy", parsed, quote, v.priceWei, taxBps + feeBps).toFixed(1)}%</span>}</>
            : <>you receive ≈ <b>{fmtEth(quote, 6)} ETH</b>{ethUsd > 0 && <span style={{ color: "var(--faint)" }}> · {fmtUsdV((Number(quote) / 1e18) * ethUsd)}</span>}</>}
        </p>
        <button className={`dp-tb-go ${side === "buy" ? "dp-buy" : "dp-sell"}`}
          disabled={busy || (isConnected && quoting) || shortOnEth || shortOnTokens || (isConnected && (parsed === 0n || quote === null))} onClick={go}>
          {busy ? "Confirm in wallet…"
            : !isConnected ? "Connect wallet"
            : shortOnEth ? "Not enough ETH"
            : shortOnTokens ? `Not enough $${v.symbol}`
            : parsed === 0n ? "Enter an amount"
            : quoting ? "Quoting…"
            : quote === null ? "No price for this trade"
            : `${side === "buy" ? "Buy" : "Sell"} $${v.symbol}`}
        </button>
        <div className="dp-tb-slip">
          <span>
            balance{" "}
            <b style={{ color: "var(--dim)" }}>
              {side === "buy" ? `${eth.data ? fmtEth(eth.data.value, 4) : "—"} ETH` : `${fmtTok(bal)} $${v.symbol}`}
            </b>
          </span>
          <span>tax {taxBps / 100}%{fee ? ` + fee ${fee[side] / 100}%` : ""}</span>
        </div>
        <div className="dp-tb-slip">
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            max slippage
            <select value={slipBps} onChange={(e) => setSlipBps(Number(e.target.value))} className="dp-slip">
              <option value={100}>1%</option>
              <option value={300}>3%</option>
              <option value={500}>5%</option>
              <option value={1000}>10%</option>
            </select>
          </label>
          <span>{quote !== null ? <>min received {side === "buy" ? `${fmtTok(minOut)} $${v.symbol}` : `${fmtEth(minOut, 6)} ETH`}</> : ""}</span>
        </div>
      </div>
    </div>
  );
}
