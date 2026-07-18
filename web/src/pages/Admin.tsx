import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import { isAddress } from "viem";
import { useWalletClient } from "wagmi";

import { TokenLogo } from "../components/TokenLogo";
import { Button, EmptyState, Skeleton } from "../components/ui";
import { client, v4Client } from "../lib/client";
import { env } from "../lib/env";
import { compact, fmtUsd, fmtWei, shortAddr } from "../lib/format";
import { erc20Abi, factoryAbi, hookAbi, wethAbi } from "../lib/v4/abis";
import { errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

/**
 * Operations console for the protocol owner. Access is enforced on-chain by the
 * factory's Ownable owner: any other wallet reads a 403 and can call nothing.
 * Actions here are direct transactions to the factory (pause launches, lift a
 * launches) and the hook (distribute a token's accrued fees).
 */
export function AdminPage() {
  const { address, isConnected, connectFirst } = useWallet();
  const { data: walletClient } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Access is the immutable protocolAdmin — the only surviving privilege once
  // ownership is renounced (it gates the LP unwind). Not owner().
  const owner = useQuery({
    queryKey: ["v4-protocol-admin"],
    queryFn: () =>
      v4Client.publicClient.readContract({
        address: v4Client.v4.factory,
        abi: factoryAbi,
        functionName: "protocolAdmin",
      }),
  });
  const isAdmin =
    owner.data && address ? (owner.data as string).toLowerCase() === address.toLowerCase() : false;

  const stats = useQuery({
    queryKey: ["v4-stats"],
    queryFn: async () => {
      const [count, treasury] = await Promise.all([
        v4Client.publicClient.readContract({ address: v4Client.v4.factory, abi: factoryAbi, functionName: "totalTokens" }),
        v4Client.publicClient.readContract({ address: v4Client.v4.hook, abi: hookAbi, functionName: "protocolTreasury" }),
      ]);
      const treasuryWeth = (await v4Client.publicClient.readContract({
        address: v4Client.v4.weth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [treasury as `0x${string}`],
      })) as bigint;
      return { totalTokens: Number(count), treasury: treasury as `0x${string}`, treasuryWeth };
    },
    refetchInterval: 20_000,
    enabled: isAdmin,
  });

  const { data: tokens, loading: tokensLoading } = useTokens(client, { sort: "volume", limit: 50 });

  // Connected admin wallet's WETH — protocol fees are pushed here as WETH on
  // every harvest; unwrap converts them to native ETH in the same wallet.
  const myWeth = useQuery({
    queryKey: ["admin-weth", address?.toLowerCase()],
    queryFn: async () =>
      (await v4Client.publicClient.readContract({
        address: v4Client.v4.weth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      })) as bigint,
    enabled: isAdmin && Boolean(address),
    refetchInterval: 20_000,
  });

  const unwrapWeth = () => {
    const bal = myWeth.data ?? 0n;
    if (bal === 0n) return;
    runTx("Unwrap WETH", () => writeContract(v4Client.v4.weth, wethAbi, "withdraw", [bal]), () => myWeth.refetch());
  };

  const [unwind, setUnwind] = useState<{ address: string; symbol: string } | null>(null);
  const [unwindPct, setUnwindPct] = useState("100");
  const [unwindTo, setUnwindTo] = useState("");

  // "Manage by address" lookup: paste any launched token's contract address.
  const [lookupInput, setLookupInput] = useState("");
  const trimmedLookup = lookupInput.trim();
  const lookupAddr = isAddress(trimmedLookup) ? (trimmedLookup as `0x${string}`) : null;
  const lookup = useQuery({
    queryKey: ["admin-token-lookup", lookupAddr?.toLowerCase()],
    queryFn: () => client.getToken(lookupAddr!),
    enabled: isAdmin && Boolean(lookupAddr),
    retry: false,
  });

  const runTx = async (label: string, fn: () => Promise<`0x${string}`>, after?: () => void) => {
    setBusyAction(label);
    try {
      const hash = await fn();
      pushToast({ kind: "info", title: `${label} submitted`, txHash: hash });
      await v4Client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `${label} confirmed`, txHash: hash });
      after?.();
    } catch (err) {
      pushToast({ kind: "error", title: `${label} failed`, body: errorText(err) });
    } finally {
      setBusyAction(null);
    }
  };

  const writeContract = async (to: `0x${string}`, abi: unknown, functionName: string, args: unknown[]) => {
    if (!walletClient) throw new Error("Connect a wallet first");
    const { request } = await v4Client.publicClient.simulateContract({
      account: address,
      address: to,
      abi: abi as never,
      functionName: functionName as never,
      args: args as never,
    });
    return walletClient.writeContract(request as never);
  };
  const writeFactory = (functionName: string, args: unknown[]) =>
    writeContract(v4Client.v4.factory, factoryAbi, functionName, args);

  const submitUnwind = () => {
    if (!unwind) return;
    const pct = Number(unwindPct);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      pushToast({ kind: "error", title: "Invalid percent", body: "Enter a number from 1 to 100." });
      return;
    }
    const to = unwindTo.trim();
    if (!isAddress(to)) {
      pushToast({ kind: "error", title: "Invalid address", body: "Enter a valid recipient address." });
      return;
    }
    const target = unwind;
    setUnwind(null);
    runTx("Unwind liquidity", () => writeFactory("unwindPosition", [target.address, Math.round(pct * 100), to]));
  };

  // Per-token owner actions: distribute accrued fees, or unwind pooled liquidity.
  const tokenActions = (t: { address: string; symbol: string }) => (
    <div className="flex justify-end gap-1.5">
      <button
        disabled={busyAction !== null}
        onClick={() => runTx("Distribute rewards", () => v4Client.harvest(t.address as `0x${string}`))}
        className="rounded-md border border-edge bg-panel px-2.5 py-1 text-[11px] font-semibold text-ink-2 transition-colors hover:border-edge-2 hover:text-ink disabled:opacity-50"
      >
        Distribute
      </button>
      <button
        disabled={busyAction !== null}
        onClick={() => {
          setUnwind({ address: t.address, symbol: t.symbol });
          setUnwindPct("100");
          setUnwindTo(address ?? "");
        }}
        className="rounded-md border border-down/40 bg-down/5 px-2.5 py-1 text-[11px] font-semibold text-down transition-colors hover:bg-down/10 disabled:opacity-50"
      >
        Unwind LP
      </button>
    </div>
  );

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <p className="text-[11px] uppercase tracking-wide text-ink-3">Operations console</p>
        <h1 className="mt-2 text-xl font-bold text-ink">Restricted area</h1>
        <p className="mt-2 text-sm text-ink-2">Connect the protocol owner wallet to continue.</p>
        <div className="mt-6">
          <Button variant="dark" onClick={connectFirst}>
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  if (owner.isLoading) {
    return (
      <div className="mx-auto max-w-[1100px] px-4 py-6">
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <p className="text-5xl font-bold text-down">403</p>
        <h1 className="mt-3 text-xl font-bold text-ink">Unauthorized</h1>
        <p className="mt-2 text-sm text-ink-2">
          This wallet is not the protocol admin. Only the protocol admin can recover liquidity.
        </p>
        <Link to="/" className="mt-6 inline-block text-sm font-medium text-accent-ink underline underline-offset-2">
          Back to Markets
        </Link>
      </div>
    );
  }

  const s = stats.data;

  return (
    <div className="mx-auto max-w-[1100px] px-3 py-4 sm:px-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          <h1 className="text-[15px] font-bold tracking-tight text-ink">Operations</h1>
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-3">protocol admin</span>
        </div>
        <p className="text-[11px] text-ink-3">Ownership renounced · LP recovery only</p>
      </div>

      {/* Figures strip */}
      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-edge bg-edge">
        <Figure label="Tokens launched" value={s ? compact(s.totalTokens) : "—"} />
        <Figure label="Treasury balance" value={s ? `${fmtWei(s.treasuryWeth)} WETH` : "—"} accent />
      </div>

      {/* Protocol treasury */}
      <div className="mt-3 rounded-xl border border-edge bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-ink">Protocol treasury</h2>
            <p className="mt-0.5 text-[11px] text-ink-3">
              The protocol's 25% share of every trade's tax is sent here as WETH on each distribution.
              Unwrap converts it to native ETH in this wallet.
            </p>
            <p className="mt-1.5 font-mono text-[12px] text-ink-2">{s ? s.treasury : "—"}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="tnum text-[15px] font-semibold text-accent-ink">
                {myWeth.data !== undefined ? `${fmtWei(myWeth.data)} WETH` : "—"}
              </p>
              <p className="text-[11px] text-ink-3">in your wallet</p>
            </div>
            <Button
              variant="primary"
              disabled={busyAction !== null || !myWeth.data || myWeth.data === 0n}
              onClick={unwrapWeth}
            >
              {busyAction === "Unwrap WETH" ? "Unwrapping" : "Unwrap to ETH"}
            </Button>
          </div>
        </div>
      </div>

      {/* Manage by address */}
      <div className="mt-3 overflow-hidden rounded-xl border border-edge bg-panel">
        <div className="border-b border-edge px-4 py-3">
          <h2 className="text-[13px] font-semibold text-ink">Manage a token by address</h2>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Paste a token contract address to distribute its accrued fees or unwind its liquidity.
          </p>
        </div>
        <div className="space-y-3 p-4">
          <input
            value={lookupInput}
            onChange={(e) => setLookupInput(e.target.value)}
            placeholder="Paste token contract address (0x…)"
            spellCheck={false}
            autoComplete="off"
            className="h-10 w-full rounded-lg border border-edge bg-panel-2/40 px-3 font-mono text-[12px] text-ink placeholder:text-ink-3 focus:border-edge-2 focus:outline-none"
          />
          {trimmedLookup.length > 0 && !lookupAddr ? (
            <p className="text-[11px] text-down">That is not a valid address.</p>
          ) : lookup.isLoading ? (
            <Skeleton className="h-14" />
          ) : lookup.isError ? (
            <p className="text-[11px] text-down">This address is not a token launched here.</p>
          ) : lookup.data ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-edge bg-panel-2/40 px-3 py-2.5">
              <Link to={`/token/${lookup.data.address}`} className="flex min-w-0 items-center gap-3">
                <TokenLogo token={lookup.data} size={30} />
                <span className="min-w-0">
                  <span className="text-[13px] font-semibold text-ink">${lookup.data.symbol}</span>
                  <span className="block truncate font-mono text-[11px] text-ink-3">
                    {lookup.data.name} · {fmtUsd(lookup.data.marketCapUsd)}
                  </span>
                </span>
              </Link>
              {tokenActions(lookup.data)}
            </div>
          ) : null}
        </div>
      </div>

      {/* Token table */}
      <div className="mt-3 overflow-hidden rounded-xl border border-edge bg-panel">
        <h2 className="border-b border-edge px-4 py-3 text-[13px] font-semibold text-ink">Tokens</h2>
        {tokensLoading ? (
          <div className="space-y-2 p-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !tokens || tokens.length === 0 ? (
          <EmptyState title="No tokens yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-edge text-[10px] uppercase tracking-wide text-ink-3">
                  <th className="px-4 py-2 font-semibold">Token</th>
                  <th className="px-2 py-2 text-right font-semibold">MCap</th>
                  <th className="px-4 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.address} className="border-b border-edge/60 transition-colors last:border-0 hover:bg-panel-2">
                    <td className="px-4 py-2.5">
                      <Link to={`/token/${t.address}`} className="flex items-center gap-2.5">
                        <TokenLogo token={t} size={26} />
                        <span>
                          <span className="text-[13px] font-semibold text-ink">{t.symbol}</span>
                          <span className="block text-[11px] text-ink-3">{t.name}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-2 py-2.5 text-right font-mono text-[12px] text-ink-2">{fmtUsd(t.marketCapUsd)}</td>
                    <td className="px-4 py-2.5">{tokenActions(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Unwind LP modal */}
      {unwind ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setUnwind(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-edge bg-panel p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[14px] font-bold text-ink">Unwind {unwind.symbol} liquidity</h3>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
              Pulls pooled liquidity (token + WETH) to a recipient. This is not reversible and lowers the pool's liquidity.
            </p>
            <label className="mt-3 block text-[11px] font-medium text-ink-2">Percent to remove (1–100)</label>
            <input
              value={unwindPct}
              onChange={(e) => setUnwindPct(e.target.value)}
              inputMode="decimal"
              placeholder="100"
              className="mt-1 h-9 w-full rounded-lg border border-edge bg-panel-2/40 px-3 text-[13px] text-ink placeholder:text-ink-3 focus:border-edge-2 focus:outline-none"
            />
            <label className="mt-3 block text-[11px] font-medium text-ink-2">Recipient</label>
            <input
              value={unwindTo}
              onChange={(e) => setUnwindTo(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              className="mt-1 h-9 w-full rounded-lg border border-edge bg-panel-2/40 px-3 font-mono text-[12px] text-ink placeholder:text-ink-3 focus:border-edge-2 focus:outline-none"
            />
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setUnwind(null)}
                className="h-9 flex-1 rounded-lg border border-edge text-[12.5px] font-semibold text-ink-2 transition-colors hover:text-ink"
              >
                Cancel
              </button>
              <button
                disabled={busyAction !== null}
                onClick={submitUnwind}
                className="h-9 flex-1 rounded-lg bg-down text-[12.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Unwind
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Figure({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-panel px-3 py-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className={`mt-0.5 font-mono text-[14px] font-bold ${accent ? "text-accent-ink" : "text-ink"}`}>{value}</dd>
    </div>
  );
}
