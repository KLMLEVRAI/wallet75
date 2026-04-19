import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const stateFilePath = resolve(process.cwd(), 'dev-state', 'wallet.json')

const defaultState = {
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

const sanitizeHoldings = (input) => {
  const safe = {}

  for (const [symbol, amount] of Object.entries(input ?? {})) {
    const normalizedSymbol = symbol.trim().toUpperCase()
    const parsedAmount = Number(amount)

    if (!normalizedSymbol || !Number.isFinite(parsedAmount) || parsedAmount < 0) {
      continue
    }

    safe[normalizedSymbol] = parsedAmount
  }

  return safe
}

const ensureStateFile = () => {
  mkdirSync(dirname(stateFilePath), { recursive: true })

  try {
    readFileSync(stateFilePath, 'utf8')
  } catch {
    writeFileSync(stateFilePath, JSON.stringify(defaultState, null, 2))
  }
}

export const readState = () => {
  ensureStateFile()

  try {
    const raw = readFileSync(stateFilePath, 'utf8')
    const parsed = JSON.parse(raw)

    return {
      holdings: sanitizeHoldings(parsed.holdings),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return { ...defaultState }
  }
}

export const writeState = (state) => {
  ensureStateFile()
  const payload = {
    holdings: sanitizeHoldings(state.holdings),
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  }

  writeFileSync(stateFilePath, JSON.stringify(payload, null, 2))
  return payload
}

export const resetState = () => {
  return writeState({ ...defaultState, updatedAt: new Date().toISOString() })
}

export const updateAmount = (symbol, amount) => {
  const normalized = symbol.trim().toUpperCase()

  if (!normalized) {
    throw new Error('Symbol is required')
  }

  const parsed = Number(amount)

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('Amount must be a positive number')
  }

  const state = readState()
  const nextHoldings = {
    ...state.holdings,
    [normalized]: parsed,
  }

  return writeState({
    holdings: nextHoldings,
    updatedAt: new Date().toISOString(),
  })
}

export const addAmount = (symbol, amount) => {
  const normalized = symbol.trim().toUpperCase()

  if (!normalized) {
    throw new Error('Symbol is required')
  }

  const parsed = Number(amount)

  if (!Number.isFinite(parsed)) {
    throw new Error('Amount must be a number')
  }

  const state = readState()
  const current = state.holdings[normalized] ?? 0
  const next = Math.max(0, current + parsed)

  return writeState({
    holdings: {
      ...state.holdings,
      [normalized]: next,
    },
    updatedAt: new Date().toISOString(),
  })
}
