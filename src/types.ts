export type WalletHoldings = Record<string, number>

export type WalletState = {
  holdings: WalletHoldings
  updatedAt: string
}

export type MarketCoin = {
  id: string
  symbol: string
  name: string
  image: string
  current_price: number
  market_cap: number
  price_change_percentage_24h: number | null
  sparkline_in_7d?: {
    price: number[]
  }
}
