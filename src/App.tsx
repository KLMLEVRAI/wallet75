import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import "./App.css"
import { formatAmount, formatCurrency, formatPercent } from "./lib/format"
import type { MarketCoin, WalletHoldings, WalletState } from "./types"

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

const STATE_STORAGE_KEY = "wallet75.state.snapshot"
const SERVER_URL_STORAGE_KEY = "wallet75.state.serverUrl"
const ENV_STATE_URL = import.meta.env.VITE_WALLET_STATE_URL ?? ""
const PULL_THRESHOLD = 84

type TabId = "wallet" | "market" | "settings"

const normalizeServerBaseUrl = (rawValue: string): string => {
  const trimmed = rawValue.trim().replace(/\/+$/, "")

  if (!trimmed) {
    return ""
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return `http://${trimmed}`
}

const stateEndpointFromBase = (baseUrl: string): string => {
  if (!baseUrl) {
    return ""
  }

  if (baseUrl.endsWith("/state")) {
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
  if (typeof window === "undefined") {
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
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : DEFAULT_STATE.updatedAt,
    }
  } catch {
    return DEFAULT_STATE
  }
}

const loadInitialServerUrl = (): string => {
  if (typeof window === "undefined") {
    return normalizeServerBaseUrl(ENV_STATE_URL)
  }

  const stored = window.localStorage.getItem(SERVER_URL_STORAGE_KEY)
  return normalizeServerBaseUrl(stored ?? ENV_STATE_URL)
}

const marketRequest = (page: number): string => {
  const params = new URLSearchParams({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: "250",
    page: String(page),
    sparkline: "true",
    price_change_percentage: "24h",
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
    .join(" ")

  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={path} className={positive ? "sparkline-line positive" : "sparkline-line negative"} />
    </svg>
  )
}

function App() {
  const [marketCoins, setMarketCoins] = useState<MarketCoin[]>([])
  const [marketError, setMarketError] = useState("")
  const [lastMarketSync, setLastMarketSync] = useState("")

  const [walletState, setWalletState] = useState<WalletState>(() => loadInitialState())

  const [serverBaseUrl, setServerBaseUrl] = useState(() => loadInitialServerUrl())
  const [serverInputValue, setServerInputValue] = useState(() => loadInitialServerUrl())
  const [connectionStatus, setConnectionStatus] = useState<"local" | "online" | "offline">("local")

  const [marketQuery, setMarketQuery] = useState("")
  const [activeTab, setActiveTab] = useState<TabId>("wallet")

  const [pullDistance, setPullDistance] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const stateEndpoint = useMemo(() => stateEndpointFromBase(serverBaseUrl), [serverBaseUrl])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const touchStartRef = useRef<number | null>(null)
  const pullTrackingRef = useRef(false)
  const refreshLockRef = useRef(false)

  const refreshMarket = useCallback(async () => {
    try {
      const responses = await Promise.all([
        fetch(marketRequest(1), { cache: "no-store" }),
        fetch(marketRequest(2), { cache: "no-store" }),
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

      setMarketCoins(mergedCoins)
      setMarketError("")
      setLastMarketSync(new Date().toISOString())
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "Unable to load market data")
    }
  }, [])

  const syncWalletState = useCallback(async () => {
    if (!stateEndpoint) {
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 3500)

    try {
      const response = await fetch(stateEndpoint, {
        cache: "no-store",
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`Wallet bridge error ${response.status}`)
      }

      const payload = (await response.json()) as Partial<WalletState>
      const safeHoldings = sanitizeHoldings((payload.holdings as Record<string, unknown>) ?? {})

      const nextState: WalletState = {
        holdings: safeHoldings,
        updatedAt: typeof payload.updatedAt === "string" ? payload.updatedAt : new Date().toISOString(),
      }

      setWalletState(nextState)
      window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(nextState))
      setConnectionStatus("online")
    } catch {
      setConnectionStatus("offline")
    } finally {
      window.clearTimeout(timeout)
    }
  }, [stateEndpoint])

  const refreshAll = useCallback(async () => {
    if (refreshLockRef.current) {
      return
    }

    refreshLockRef.current = true
    setIsRefreshing(true)

    try {
      await Promise.all([refreshMarket(), syncWalletState()])
    } finally {
      setIsRefreshing(false)
      setPullDistance(0)
      refreshLockRef.current = false
    }
  }, [refreshMarket, syncWalletState])

  useEffect(() => {
    const firstRun = window.setTimeout(() => {
      void refreshMarket()
    }, 0)

    const interval = window.setInterval(() => {
      void refreshMarket()
    }, 45000)

    return () => {
      window.clearTimeout(firstRun)
      window.clearInterval(interval)
    }
  }, [refreshMarket])

  useEffect(() => {
    if (!stateEndpoint) {
      return
    }

    const firstRun = window.setTimeout(() => {
      void syncWalletState()
    }, 0)

    const interval = window.setInterval(() => {
      void syncWalletState()
    }, 3000)

    return () => {
      window.clearTimeout(firstRun)
      window.clearInterval(interval)
    }
  }, [stateEndpoint, syncWalletState])

  const resolvedConnectionStatus = stateEndpoint ? connectionStatus : "local"

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
      .slice(0, 4)
  }, [enrichedMarket])

  const connectionLabel = useMemo(() => {
    if (resolvedConnectionStatus === "local") {
      return "Mode local (snapshot interne)"
    }

    if (resolvedConnectionStatus === "offline") {
      return "Bridge hors ligne"
    }

    return `Bridge en ligne: ${serverBaseUrl}`
  }, [resolvedConnectionStatus, serverBaseUrl])

  const saveBridgeUrl = () => {
    const normalized = normalizeServerBaseUrl(serverInputValue)
    setServerBaseUrl(normalized)
    window.localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized)
  }

  const resetPullTracking = () => {
    touchStartRef.current = null
    pullTrackingRef.current = false
  }

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (isRefreshing) {
      return
    }

    const container = scrollRef.current

    if (!container || container.scrollTop > 1) {
      return
    }

    touchStartRef.current = event.touches[0]?.clientY ?? null
    pullTrackingRef.current = true
  }

  const handleTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    if (!pullTrackingRef.current || isRefreshing) {
      return
    }

    const startY = touchStartRef.current

    if (startY === null) {
      return
    }

    const container = scrollRef.current

    if (!container || container.scrollTop > 1) {
      setPullDistance(0)
      resetPullTracking()
      return
    }

    const currentY = event.touches[0]?.clientY ?? startY
    const delta = currentY - startY

    if (delta <= 0) {
      setPullDistance(0)
      return
    }

    const damped = Math.min(130, delta * 0.5)
    setPullDistance(damped)
  }

  const handleTouchEnd = () => {
    if (!pullTrackingRef.current) {
      setPullDistance(0)
      return
    }

    const shouldRefresh = pullDistance >= PULL_THRESHOLD
    resetPullTracking()

    if (shouldRefresh) {
      void refreshAll()
      return
    }

    setPullDistance(0)
  }

  return (
    <div className="wallet-root">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <div className="phone-shell">
        <div
          className="app-scroll"
          ref={scrollRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          <div className="pull-zone" style={{ height: `${isRefreshing ? 66 : pullDistance}px` }}>
            <div className={`pull-chip ${isRefreshing ? "refreshing" : ""}`}>
              {isRefreshing
                ? "Refresh en cours..."
                : pullDistance >= PULL_THRESHOLD
                  ? "Relache pour actualiser"
                  : "Balaye vers le bas pour refresh"}
            </div>
          </div>

          <header className="wallet-header">
            <div>
              <p className="brand-label">WALLET 75</p>
              <h1 className="screen-title">Wallet</h1>
            </div>
            <button type="button" className="refresh-button" onClick={() => void refreshAll()} disabled={isRefreshing}>
              {isRefreshing ? "Sync..." : "Refresh"}
            </button>
          </header>

          {activeTab === "wallet" ? (
            <section className="screen-section">
              <article className="balance-card">
                <p className="balance-label">Total Balance</p>
                <p className="balance-value">{formatCurrency(portfolioValue)}</p>
                <p className="balance-meta">
                  {trackedAssets.length} assets  |  Market sync {lastMarketSync ? new Date(lastMarketSync).toLocaleTimeString() : "--:--"}
                </p>

                <div className="quick-actions">
                  <button type="button">Receive</button>
                  <button type="button">Send</button>
                  <button type="button">Swap</button>
                  <button type="button">Buy</button>
                </div>
              </article>

              <article className="panel-card">
                <div className="panel-head">
                  <h2>Top Movers</h2>
                </div>
                <div className="mover-grid">
                  {topMovers.map((coin) => (
                    <div key={coin.id} className="mover-card">
                      <img src={coin.image} alt="" loading="lazy" />
                      <div>
                        <p>{coin.normalizedSymbol}</p>
                        <strong>{formatPercent(coin.price_change_percentage_24h)}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel-card">
                <div className="panel-head">
                  <h2>Tokens</h2>
                  <span>{trackedAssets.length}</span>
                </div>
                {trackedAssets.length === 0 ? (
                  <p className="empty-text">Aucun token detecte. Ajoute des soldes via le bridge terminal.</p>
                ) : (
                  <div className="token-list">
                    {trackedAssets.map((coin, index) => (
                      <article key={coin.id} className="token-row">
                        <div className="coin-id">
                          <img src={coin.image} alt="" loading="lazy" />
                          <div>
                            <p>{coin.name}</p>
                            <span>{coin.normalizedSymbol}</span>
                          </div>
                        </div>
                        <div className="coin-value">
                          <p>{formatCurrency(coin.usdValue)}</p>
                          <span>
                            {formatAmount(coin.amount)} {coin.normalizedSymbol}
                          </span>
                        </div>
                        {index < 24 ? (
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
              </article>
            </section>
          ) : null}

          {activeTab === "market" ? (
            <section className="screen-section">
              <article className="panel-card">
                <div className="panel-head market-head">
                  <h2>Market</h2>
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
                          (coin.price_change_percentage_24h ?? 0) >= 0
                            ? "market-change positive"
                            : "market-change negative"
                        }
                      >
                        {formatPercent(coin.price_change_percentage_24h)}
                      </p>
                    </article>
                  ))}
                </div>
              </article>
            </section>
          ) : null}

          {activeTab === "settings" ? (
            <section className="screen-section">
              <article className="panel-card settings-card">
                <div className="panel-head">
                  <h2>Settings</h2>
                </div>
                <p className="settings-copy">IP du bridge dans les parametres. Exemple: 192.168.1.58:8787</p>

                <label htmlFor="bridge-url" className="field-label">
                  IP / URL bridge
                </label>
                <div className="settings-row">
                  <input
                    id="bridge-url"
                    type="text"
                    value={serverInputValue}
                    onChange={(event) => setServerInputValue(event.target.value)}
                    placeholder="192.168.1.58:8787"
                  />
                  <button type="button" onClick={saveBridgeUrl}>
                    Sauver
                  </button>
                </div>

                <p className={`status-line ${resolvedConnectionStatus}`}>{connectionLabel}</p>

                <div className="settings-actions">
                  <button type="button" onClick={() => void refreshAll()} disabled={isRefreshing}>
                    Tester la connexion
                  </button>
                </div>

                <div className="terminal-box">
                  <code>npm run wallet:server</code>
                  <code>npm run wallet:set -- SOL 125</code>
                  <code>npm run wallet:add -- ETH 0.42</code>
                  <code>npm run wallet:status</code>
                </div>

                <p className="update-copy">Derniere update wallet: {new Date(walletState.updatedAt).toLocaleString()}</p>
              </article>
            </section>
          ) : null}

          <div className="screen-safe-space" />
        </div>

        <nav className="tabbar" aria-label="Main tabs">
          <button
            type="button"
            className={activeTab === "wallet" ? "active" : ""}
            onClick={() => setActiveTab("wallet")}
          >
            Wallet
          </button>
          <button
            type="button"
            className={activeTab === "market" ? "active" : ""}
            onClick={() => setActiveTab("market")}
          >
            Market
          </button>
          <button
            type="button"
            className={activeTab === "settings" ? "active" : ""}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
        </nav>
      </div>
    </div>
  )
}

export default App
