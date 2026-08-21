# Meridian — Token Launchpad

A premium, minimal, dark launchpad interface. No marketing landing page — the
app opens directly into the launchpad dashboard, like a professional trading
platform. Original design system: near-black background (`#090B10`), thin
borders, 18px rounded cards, a single green accent (`#22C55E`), and fast,
subtle fade/slide/scale transitions only.

## Stack

- **Vite + React 18 + TypeScript** — no UI framework, no chart library
- Hand-rolled CSS design system (`src/styles.css`): tokens for color, shape,
  motion and type
- Custom SVG charts (smoothed area chart with hover crosshair, sparklines)
- React Router with fade page transitions
- ~71 KB gzipped total

## Pages

- **Explore (`/`)** — the dashboard. Four animated statistics cards (live
  tokens, total volume, tokens created, 24h volume), category filters
  (Trending / Newest / Graduated / Fair launch / Favorites), chain filters,
  sort control, responsive token grid, and a Recent Launches table. Each token
  card shows logo, name, ticker, chain, market cap, liquidity, volume,
  graduation progress bar, creator, age, quick-buy and favorite; the whole
  card is clickable.
- **Token detail (`/token/:ticker`)** — large price chart with ranges, buy/sell
  panel with fee breakdown and confirmation dialog, market statistics, holder
  count, graduation progress, contract address with copy, creator profile,
  social links, recent trades.
- **Create (`/create`)** — five-step wizard (Basics → Tokenomics → Liquidity →
  Review → Deploy) with a progress indicator, validation, and an animated
  deploy sequence.
- **Portfolio (`/portfolio`)** — total value, unrealized P&L and creator
  earnings, positions table with sparklines, and cards for tokens you
  launched.

Global: simulated wallet connect (persisted to `localStorage`), network
selector (Robinhood Chain / Ethereum / Base / Monad), global search with `/`
shortcut, loading skeletons, toasts, confirmation modals, floating bottom
navigation on mobile.

All data is deterministic demo data (`src/lib/data.ts`); no backend required.

## Run

```bash
cd meridian
npm install
npm run dev        # http://localhost:5199
npm run build      # production build in dist/
```
