import { useCallback, useEffect, useRef, useState } from "react";

import type { LaunchpadClient } from "./client";
import type {
  Address,
  Candle,
  CandleInterval,
  HolderRecord,
  PriceUpdate,
  TokenSummary,
  TradeRecord,
  TradingLimits,
} from "./types";

/**
 * React hooks over the LaunchpadClient. Each hook loads a snapshot over REST
 * or RPC and then keeps it fresh over the WebSocket stream, so consuming
 * components update live without polling or page reloads.
 */

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => !cancelled && setState({ data, loading: false, error: null }),
      (error) => !cancelled && setState({ data: null, loading: false, error })
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

export function useToken(client: LaunchpadClient, token: Address | undefined) {
  const result = useAsync<TokenSummary | null>(
    () => (token ? client.getToken(token) : Promise.resolve(null)),
    [token]
  );

  const [live, setLive] = useState<Partial<TokenSummary>>({});
  useEffect(() => {
    if (!token) return;
    const unsub = client.subscribeToPrice(token, (update: PriceUpdate) => {
      setLive({
        priceWei: update.priceWei,
        priceUsd: update.priceUsd,
        marketCapUsd: update.marketCapUsd,
        liquidityWei: update.liquidityWei,
        limitsActive: update.limitsActive,
        remainingToGraduationUsd: update.remainingToGraduationUsd,
        creatorFeesWei: update.creatorFeesWei,
      });
    });
    return unsub;
  }, [client, token]);

  return {
    ...result,
    data: result.data ? { ...result.data, ...live } : null,
  };
}

export function useTokens(
  client: LaunchpadClient,
  opts?: { sort?: "new" | "volume" | "marketCap" | "featured"; limit?: number }
) {
  const result = useAsync<TokenSummary[]>(
    () => client.getTokens(opts),
    [opts?.sort, opts?.limit]
  );

  useEffect(() => {
    const unsub = client.subscribeToLaunches(() => result.reload());
    // Poll on an interval so new launches appear without a reload and a
    // transient RPC failure (mobile rate-limits) self-heals instead of
    // leaving the feed stuck empty.
    const id = setInterval(() => result.reload(), 20_000);
    return () => {
      unsub();
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  return result;
}

export function useCandles(
  client: LaunchpadClient,
  token: Address | undefined,
  interval: CandleInterval,
  opts?: { limit?: number }
) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  /** Set on every stream update; chart code can apply just the last candle. */
  const lastUpdate = useRef<Candle | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    client
      .getCandles(token, interval, { limit: opts?.limit ?? 500 })
      .then((data) => {
        if (cancelled) return;
        setCandles(data);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      });

    const unsub = client.subscribeToCandles(token, interval, ({ candle }) => {
      if (cancelled) return;
      lastUpdate.current = candle;
      setCandles((prev) => {
        if (prev.length === 0) return [candle];
        const last = prev[prev.length - 1];
        if (candle.time === last.time) return [...prev.slice(0, -1), candle];
        if (candle.time > last.time) return [...prev, candle];
        return prev;
      });
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [client, token, interval, opts?.limit]);

  return { candles, loading, error, lastUpdate };
}

export function useTrades(client: LaunchpadClient, token: Address | undefined, limit = 50) {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    client.getTrades(token, { limit }).then((data) => {
      if (cancelled) return;
      setTrades(data);
      setLoading(false);
    });
    const unsub = client.subscribeToTrades(token, (trade) => {
      if (cancelled) return;
      setTrades((prev) => [trade, ...prev].slice(0, limit));
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [client, token, limit]);

  return { trades, loading };
}

export function useHolders(client: LaunchpadClient, token: Address | undefined, limit = 50) {
  return useAsync<HolderRecord[]>(
    () => (token ? client.getHolders(token, { limit }) : Promise.resolve([])),
    [token, limit]
  );
}

export function useTradingLimits(client: LaunchpadClient, token: Address | undefined) {
  const result = useAsync<TradingLimits | null>(
    () => (token ? client.getTradingLimits(token) : Promise.resolve(null)),
    [token]
  );

  useEffect(() => {
    if (!token) return;
    const unsub = client.subscribeToPrice(token, () => result.reload());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, token]);

  return result;
}

export function useLivePrice(client: LaunchpadClient, token: Address | undefined) {
  const [price, setPrice] = useState<PriceUpdate | null>(null);
  useEffect(() => {
    if (!token) return;
    return client.subscribeToPrice(token, setPrice);
  }, [client, token]);
  return price;
}
