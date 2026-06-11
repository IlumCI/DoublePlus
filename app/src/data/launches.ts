export type LaunchStatus = 'live' | 'upcoming' | 'succeeded' | 'failed'

export interface Launch {
  id: number
  name: string
  symbol: string
  emoji: string
  tagline: string
  priceHype: number // HYPE per token
  tokensForSale: number
  tokensForLiquidity: number
  raised: number // HYPE
  softCap: number // HYPE
  startsIn?: string
  endsIn?: string
  endedAgo?: string
  liquidityBps: number
  maxBuyPerWallet: number // HYPE, 0 = unlimited
  buyers: number
  status: LaunchStatus
  creator: string
  // for the detail page demo: what this connected wallet holds
  yourContribution: number
  yourTokens: number
}

export const hardCapOf = (l: Launch) => l.priceHype * l.tokensForSale

export const LAUNCHES: Launch[] = [
  {
    id: 4,
    name: 'Purr Network',
    symbol: 'PURR2',
    emoji: '🐱',
    tagline: 'Community token for the Hyperliquid cat cabal.',
    priceHype: 0.0004,
    tokensForSale: 600_000_000,
    tokensForLiquidity: 400_000_000,
    raised: 187_400,
    softCap: 60_000,
    endsIn: '14h 22m',
    liquidityBps: 7000,
    maxBuyPerWallet: 2_000,
    buyers: 1841,
    status: 'live',
    creator: '0x3fA8…c21D',
    yourContribution: 250,
    yourTokens: 625_000,
  },
  {
    id: 5,
    name: 'Gridline',
    symbol: 'GRID',
    emoji: '⚡',
    tagline: 'Settlement rails for HyperEVM perps vaults.',
    priceHype: 0.0125,
    tokensForSale: 8_000_000,
    tokensForLiquidity: 6_000_000,
    raised: 41_870,
    softCap: 30_000,
    endsIn: '2d 6h',
    liquidityBps: 8000,
    maxBuyPerWallet: 500,
    buyers: 412,
    status: 'live',
    creator: '0x91b4…77Ae',
    yourContribution: 0,
    yourTokens: 0,
  },
  {
    id: 6,
    name: 'Hyperflats',
    symbol: 'FLAT',
    emoji: '📏',
    tagline: 'The anti-curve index. Flat is the new up-only.',
    priceHype: 0.002,
    tokensForSale: 50_000_000,
    tokensForLiquidity: 50_000_000,
    raised: 12_900,
    softCap: 40_000,
    endsIn: '9h 03m',
    liquidityBps: 9000,
    maxBuyPerWallet: 0,
    buyers: 96,
    status: 'live',
    creator: '0xDd02…4f19',
    yourContribution: 0,
    yourTokens: 0,
  },
  {
    id: 7,
    name: 'Kitten Vaults',
    symbol: 'KVLT',
    emoji: '🔐',
    tagline: 'Auto-compounding LP vaults on KittenSwap.',
    priceHype: 0.0085,
    tokensForSale: 12_000_000,
    tokensForLiquidity: 9_000_000,
    raised: 0,
    softCap: 35_000,
    startsIn: '1d 12h',
    liquidityBps: 7500,
    maxBuyPerWallet: 750,
    buyers: 0,
    status: 'upcoming',
    creator: '0x77Cc…09bE',
    yourContribution: 0,
    yourTokens: 0,
  },
  {
    id: 2,
    name: 'Hypecast',
    symbol: 'CAST',
    emoji: '📡',
    tagline: 'Onchain social broadcasting for HL natives.',
    priceHype: 0.0031,
    tokensForSale: 40_000_000,
    tokensForLiquidity: 30_000_000,
    raised: 124_000,
    softCap: 50_000,
    endedAgo: '3d ago',
    liquidityBps: 7000,
    maxBuyPerWallet: 1_000,
    buyers: 2310,
    status: 'succeeded',
    creator: '0x08aF…b3c2',
    yourContribution: 400,
    yourTokens: 129_032,
  },
  {
    id: 1,
    name: 'Moonbag',
    symbol: 'MBAG',
    emoji: '🌙',
    tagline: 'It was never going to make it.',
    priceHype: 0.01,
    tokensForSale: 10_000_000,
    tokensForLiquidity: 10_000_000,
    raised: 18_200,
    softCap: 60_000,
    endedAgo: '1w ago',
    liquidityBps: 5000,
    maxBuyPerWallet: 0,
    buyers: 77,
    status: 'failed',
    creator: '0xB00…5e77',
    yourContribution: 120,
    yourTokens: 0,
  },
]

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
export function compact(n: number): string {
  if (n >= 1_000_000_000) return fmt.format(n / 1_000_000_000) + 'B'
  if (n >= 1_000_000) return fmt.format(n / 1_000_000) + 'M'
  if (n >= 1_000) return fmt.format(n / 1_000) + 'K'
  return fmt.format(n)
}

export function price(n: number): string {
  return n.toLocaleString('en-US', { maximumSignificantDigits: 3 })
}
