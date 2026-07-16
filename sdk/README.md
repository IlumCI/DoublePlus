# @launchpad/sdk

TypeScript SDK for the Robinhood Chain Uniswap V3 token launchpad. Real wallet signing through viem, indexer-backed reads, and WebSocket live streams.

## Install

```bash
npm install @launchpad/sdk viem
```

## Quick start

```ts
import { LaunchpadClient, parseEther } from "@launchpad/sdk";
import { createWalletClient, custom, defineChain } from "viem";

const robinhoodChain = defineChain({
  id: Number(import.meta.env.VITE_CHAIN_ID),
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC_URL] } },
});

const client = new LaunchpadClient({
  chain: robinhoodChain,
  addresses: {
    launchpad: "0x...",
    feeDistributor: "0x...",
    treasury: "0x...",
    tokenFactory: "0x...",
    weth: "0x...",
  },
  apiUrl: "https://api.yourlaunchpad.xyz",
  wsUrl: "wss://api.yourlaunchpad.xyz/ws",
});

// Connect the user's wallet (MetaMask, WalletConnect, any EIP-1193 provider)
const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum) });
client.connectWallet(wallet);

// Launch a token: deploys the ERC-20, creates the Uniswap V3 pool,
// seeds liquidity and enables trading in one transaction.
const hash = await client.createToken({
  name: "My Token",
  symbol: "MTK",
  description: "A community token",
  logo: "ipfs://...",
  website: "https://mytoken.xyz",
  twitter: "https://x.com/mytoken",
  telegram: "https://t.me/mytoken",
  maxTxBps: 100,        // 1% of supply per transaction until graduation
  maxWalletBps: 200,    // 2% of supply per wallet until graduation
  buyCooldownSeconds: 30,
  initialLiquidityWei: parseEther("1"),
});

// Trade
await client.buyToken("0xToken", parseEther("0.1"));
await client.sellToken("0xToken", 1000n * 10n ** 18n);

// Read
const token = await client.getToken("0xToken");
const { priceWei, priceUsd } = await client.getPrice("0xToken");
const { marketCapUsd } = await client.getMarketCap("0xToken");
const limits = await client.getTradingLimits("0xToken");
const trades = await client.getTrades("0xToken", { limit: 50 });
const holders = await client.getHolders("0xToken");
const pool = await client.getPoolInfo("0xToken");
const candles = await client.getCandles("0xToken", "1m", { limit: 500 });

// Live streams
const unsubPrice = client.subscribeToPrice("0xToken", (p) => console.log(p.priceUsd));
const unsubTrades = client.subscribeToTrades("0xToken", (t) => console.log(t));
const unsubCandles = client.subscribeToCandles("0xToken", "1m", ({ candle }) => console.log(candle));
```

## React hooks

```tsx
import { useToken, useCandles, useTrades, useHolders, useTradingLimits } from "@launchpad/sdk/react";

function TokenPage({ client, address }) {
  const { data: token } = useToken(client, address);
  const { candles } = useCandles(client, address, "1m");
  const { trades } = useTrades(client, address);
  const { data: holders } = useHolders(client, address);
  const { data: limits } = useTradingLimits(client, address);
  // candles/trades/token update live over WebSocket, no polling.
}
```

## Notes

- All value fields cross the API as decimal strings (wei); convert with viem's `formatEther`.
- Anti-whale limits lift automatically at the graduation market cap (40,000 USD by default); `getTradingLimits` exposes progress.
- Liquidity is protocol-managed: the Uniswap V3 position NFT is held by the Launchpad contract and managed by the liquidity manager role.
