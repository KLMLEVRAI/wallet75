const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

const compactCurrencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
})

export const formatCurrency = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '$0.00'
  }

  if (Math.abs(value) >= 1000000) {
    return compactCurrencyFormatter.format(value)
  }

  return currencyFormatter.format(value)
}

export const formatAmount = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '0'
  }

  if (Math.abs(value) >= 1000) {
    return compactNumberFormatter.format(value)
  }

  if (Math.abs(value) < 0.01 && value !== 0) {
    return value.toFixed(6)
  }

  return value.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

export const formatPercent = (value: number | null): string => {
  if (value === null || Number.isNaN(value)) {
    return '0.00%'
  }

  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}
