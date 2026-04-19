import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { formatAmount, formatCurrency, formatPercent } from './lib/format'
import type { MarketCoin, WalletHoldings, WalletState } from './types'

const DEFAULT_STATE: WalletState = {
  holdings: {
    BTC: 0.14,
    ETH: 1.9,
    SOL: 42,
    USDC: 3200,
    SUI: 850,
    BONK: 950000,
  },
  updatedAt: new Date().toISOString(),
}

const STATE_STORAGE_KEY = 'wallet75.state.snapshot'
const SERVER_URL_STORAGE_KEY = 'wallet75.state.serverUrl'
const ENV_STATE_URL = import.meta.env.VITE_WALLET_STATE_URL ?? ''

const normalizeServerBaseUrl = (rawValue: string): string => {
  const trimmed = rawValue.trim().replace(/\/+$/, '')

  if (!trimmed) {
    return ''
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return `http://${trimmed}`
}

const stateEndpointFromBase = (baseUrl: string): string => {
  if (!baseUrl) {
    return ''
  }

  if (baseUrl.endsWith('/state')) {
    return baseUrl
  }

  return `${baseUrl}/state`
}

const sanitizeHoldings = (input: Record<string, unknown>): WalletHoldings => {
  const cleaned: WalletHoldings = {}

  for (const [symbol, amount] of Object.entries(input)) {
    const normalizedSymbol = symbol.trim().toUpperCase()

    if (!normalizedSymbol) {
      continue
    }

    const parsedAmount = Number(amount)

    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      continue
    }

    cleaned[normalizedSymbol] = parsedAmount
  }

  return cleaned
}

const loadInitialState = (): WalletState => {
  if (typeof window === 'undefined') {
    return DEFAULT_STATE
  }

  const rawSnapshot = window.localStorage.getItem(STATE_STORAGE_KEY)

  if (!rawSnapshot) {
    return DEFAULT_STATE
  }

  try {
    const parsed = JSON.parse(rawSnapshot) as Partial<WalletState>
    const holdings = sanitizeHoldings((parsed.holdings as Record<string, unknown>) ?? {})

    return {
      holdings: Object.keys(holdings).length > 0 ? holdings : DEFAULT_STATE.holdings,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : DEFAULT_STATE.updatedAt,
    }
  } catch {
    return DEFAULT_STATE
  }
}

const loadInitialServerUrl = (): string => {
  if (typeof window === 'undefined') {
    return normalizeServerBaseUrl(ENV_STATE_URL)
  }

  const stored = window.localStorage.getItem(SERVER_URL_STORAGE_KEY)
  return normalizeServerBaseUrl(stored ?? ENV_STATE_URL)
}

const marketRequest = (page: number): string => {
  const params = new URLSearchParams({
    vs_currency: 'usd',
    order: 'market_cap_desc',
    per_page: '250',
    page: String(page),
    sparkline: 'true',
    price_change_percentage: '24h',
  })

  return `https://api.coingecko.com/api/v3/coins/markets?${params.toString()}`
}

const Sparkline = ({ points, positive }: { points: number[]; positive: boolean }) => {
  if (points.length < 2) {
    return <div className="sparkline-empty" />
  }

  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1

  const path = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * 100
      const y = 100 - ((value - min) / range) * 100
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} className={positive ? 'sparkline-line positive' : 'sparkline-line negative'} />
    </svg>
  )
}

function App() {
  const [marketCoins, setMarketCoins] = useState<MarketCoin[]>([])
  const [marketError, setMarketError] = useState('')
  const [lastMarketSync, setLastMarketSync] = useState('')

  const [walletState, setWalletState] = useState<WalletState>(() => loadInitialState())

  const [serverBaseUrl, setServerBaseUrl] = useState(() => loadInitialServerUrl())
  const [serverInputValue, setServerInputValue] = useState(() => loadInitialServerUrl())
  const [connectionStatus, setConnectionStatus] = useState<'local' | 'online' | 'offline'>('local')

  const [marketQuery, setMarketQuery] = useState('')
  const [manualRefreshTick, setManualRefreshTick] = useState(0)

  const stateEndpoint = useMemo(() => stateEndpointFromBase(serverBaseUrl), [serverBaseUrl])

  useEffect(() => {
    let cancelled = false

    const fetchMarket = async () => {
      try {
        const responses = await Promise.all([
          fetch(marketRequest(1), { cache: 'no-store' }),
          fetch(marketRequest(2), { cache: 'no-store' }),
        ])

        for (const response of responses) {
          if (!response.ok) {
            throw new Error(`CoinGecko error ${response.status}`)
          }
        }

        const pages = (await Promise.all(responses.map((response) => response.json()))) as MarketCoin[][]

        const seenSymbols = new Set<string>()
        const mergedCoins: MarketCoin[] = []

        for (const coin of pages.flat()) {
          const symbol = coin.symbol.toUpperCase()

          if (seenSymbols.has(symbol)) {
            continue
          }

          seenSymbols.add(symbol)
          mergedCoins.push(coin)
        }

        if (!cancelled) {
          setMarketCoins(mergedCoins)
          setMarketError('')
          setLastMarketSync(new Date().toISOString())
        }
      } catch (error) {
        if (!cancelled) {
          setMarketError(error instanceof Error ? error.message : 'Unable to load market data')
        }
      }
    }

    fetchMarket()
    const interval = window.setInterval(fetchMarket, 45000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!stateEndpoint) {
      return
    }

    let cancelled = false

    const syncState = async () => {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 3500)

      try {
        const response = await fetch(stateEndpoint, {
          cache: 'no-store',
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`Wallet bridge error ${response.status}`)
        }

        const payload = (await response.json()) as Partial<WalletState>
        const safeHoldings = sanitizeHoldings((payload.holdings as Record<string, unknown>) ?? {})

        if (cancelled) {
          return
        }

        const nextState: WalletState = {
          holdings: safeHoldings,
          updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : new Date().toISOString(),
        }

        setWalletState(nextState)
        window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(nextState))
        setConnectionStatus('online')
      } catch {
        if (!cancelled) {
          setConnectionStatus('offline')
        }
      } finally {
        window.clearTimeout(timeout)
      }
    }

    syncState()
    const interval = window.setInterval(syncState, 3000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [stateEndpoint, manualRefreshTick])

  const resolvedConnectionStatus = stateEndpoint ? connectionStatus : 'local'

  const enrichedMarket = useMemo(() => {
    return marketCoins.map((coin) => {
      const symbol = coin.symbol.toUpperCase()
      const amount = walletState.holdings[symbol] ?? 0
      const usdValue = amount * coin.current_price

      return {
        ...coin,
        normalizedSymbol: symbol,
        amount,
        usdValue,
      }
    })
  }, [marketCoins, walletState.holdings])

  const portfolioValue = useMemo(() => {
    return enrichedMarket.reduce((acc, coin) => acc + coin.usdValue, 0)
  }, [enrichedMarket])

  const trackedAssets = useMemo(() => {
    return enrichedMarket
      .filter((coin) => coin.amount > 0)
      .sort((first, second) => second.usdValue - first.usdValue)
  }, [enrichedMarket])

  const marketRows = useMemo(() => {
    const query = marketQuery.trim().toLowerCase()

    return enrichedMarket
      .filter((coin) => {
        if (!query) {
          return true
        }

        return coin.name.toLowerCase().includes(query) || coin.normalizedSymbol.toLowerCase().includes(query)
      })
      .sort((first, second) => {
        if (first.amount > 0 && second.amount === 0) {
          return -1
        }

        if (first.amount === 0 && second.amount > 0) {
          return 1
        }

        if (first.usdValue !== second.usdValue) {
          return second.usdValue - first.usdValue
        }

        return second.market_cap - first.market_cap
      })
      .slice(0, 180)
  }, [enrichedMarket, marketQuery])

  const topMovers = useMemo(() => {
    return [...enrichedMarket]
      .filter((coin) => coin.price_change_percentage_24h !== null)
      .sort((first, second) => (second.price_change_percentage_24h ?? 0) - (first.price_change_percentage_24h ?? 0))
      .slice(0, 6)
  }, [enrichedMarket])

  const connectionLabel = useMemo(() => {
    if (resolvedConnectionStatus === 'local') {
      return 'Local snapshot mode'
    }

    if (resolvedConnectionStatus === 'offline') {
      return 'Bridge offline - fallback snapshot'
    }

    return `Bridge online: ${serverBaseUrl}`
  }, [resolvedConnectionStatus, serverBaseUrl])

  const saveBridgeUrl = () => {
    const normalized = normalizeServerBaseUrl(serverInputValue)
    setServerBaseUrl(normalized)
    window.localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized)
  }

  return (
    <div className="wallet-app">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="ambient ambient-c" />

      <header className="glass-panel topbar">
        <div>
          <p className="eyebrow">WALLET 75</p>
          <h1 className="title">Crypto Glass Wallet</h1>
        </div>
        <div className="connection-pill" data-state={resolvedConnectionStatus}>
          <span className="status-dot" />
          {connectionLabel}
        </div>
      </header>

      <main className="content-grid">
        <section className="glass-panel hero-card">
          <p className="eyebrow">Portfolio Value</p>
          <p className="balance">{formatCurrency(portfolioValue)}</p>
          <div className="meta-row">
            <span>Assets: {trackedAssets.length}</span>
            <span>Markets tracked: {marketCoins.length}</span>
            <span>Last market sync: {lastMarketSync ? new Date(lastMarketSync).toLocaleTimeString() : '--:--'}</span>
          </div>

          <div className="mover-strip">
            {topMovers.map((coin) => (
              <article key={coin.id} className="mover-chip">
                <img src={coin.image} alt="" loading="lazy" />
                <div>
                  <p>{coin.normalizedSymbol}</p>
                  <strong>{formatPercent(coin.price_change_percentage_24h)}</strong>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="glass-panel bridge-card">
          <h2>Terminal Bridge</h2>
          <p className="card-description">
            Lance le serveur sur ton PC, puis modifie les soldes directement au terminal. L&apos;app met a jour automatiquement.
          </p>

          <label htmlFor="bridge-url" className="field-label">
            URL serveur (meme reseau)
          </label>
          <div className="bridge-actions">
            <input
              id="bridge-url"
              type="text"
              value={serverInputValue}
              onChange={(event) => setServerInputValue(event.target.value)}
              placeholder="ex: 192.168.1.20:8787"
            />
            <button type="button" onClick={saveBridgeUrl}>
              Connecter
            </button>
            <button type="button" onClick={() => setManualRefreshTick((value) => value + 1)}>
              Refresh
            </button>
          </div>

          <div className="terminal-box">
            <code>npm run wallet:server</code>
            <code>npm run wallet:set -- SOL 125</code>
            <code>npm run wallet:add -- ETH 0.42</code>
            <code>npm run wallet:status</code>
          </div>
        </section>

        <section className="glass-panel assets-card">
          <h2>My Holdings</h2>
          {trackedAssets.length === 0 ? (
            <p className="empty-text">Aucun solde detecte. Utilise le terminal bridge pour injecter des montants.</p>
          ) : (
            <div className="asset-list">
              {trackedAssets.map((coin, index) => (
                <article key={coin.id} className="asset-row">
                  <div className="coin-id">
                    <img src={coin.image} alt="" loading="lazy" />
                    <div>
                      <p>{coin.name}</p>
                      <span>{coin.normalizedSymbol}</span>
                    </div>
                  </div>
                  <div className="coin-value">
                    <p>{formatCurrency(coin.usdValue)}</p>
                    <span>{formatAmount(coin.amount)} {coin.normalizedSymbol}</span>
                  </div>
                  {index < 20 ? (
                    <Sparkline
                      points={coin.sparkline_in_7d?.price ?? []}
                      positive={(coin.price_change_percentage_24h ?? 0) >= 0}
                    />
                  ) : (
                    <div className="sparkline-empty" />
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="glass-panel market-card">
          <div className="market-head">
            <h2>All Crypto Market</h2>
            <input
              type="search"
              value={marketQuery}
              onChange={(event) => setMarketQuery(event.target.value)}
              placeholder="Search BTC, SOL, Ethereum..."
            />
          </div>

          {marketError ? <p className="error-text">{marketError}</p> : null}

          <div className="market-list">
            {marketRows.map((coin, index) => (
              <article key={`${coin.id}-${coin.normalizedSymbol}`} className="market-row">
                <span className="rank">#{index + 1}</span>
                <div className="coin-id">
                  <img src={coin.image} alt="" loading="lazy" />
                  <div>
                    <p>{coin.name}</p>
                    <span>{coin.normalizedSymbol}</span>
                  </div>
                </div>
                <p className="market-price">{formatCurrency(coin.current_price)}</p>
                <p
                  className={
                    (coin.price_change_percentage_24h ?? 0) >= 0 ? 'market-change positive' : 'market-change negative'
                  }
                >
                  {formatPercent(coin.price_change_percentage_24h)}
                </p>
                <p className="wallet-amount">{coin.amount > 0 ? `${formatAmount(coin.amount)} ${coin.normalizedSymbol}` : '-'}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="bottom-nav glass-panel">
        <p>Wallet updated: {new Date(walletState.updatedAt).toLocaleString()}</p>
        <p>Theme: iOS Glass / slow motion blur</p>
      </footer>
    </div>
  )
}

export default App
