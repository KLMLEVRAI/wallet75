const [,, command, ...rest] = process.argv

const defaultBaseUrl = process.env.WALLET_DEV_SERVER_URL ?? 'http://127.0.0.1:8787'

const parseBaseUrl = () => {
  const urlIndex = rest.findIndex((arg) => arg === '--url')

  if (urlIndex === -1) {
    return defaultBaseUrl.replace(/\/+$/, '')
  }

  const explicitUrl = rest[urlIndex + 1]

  if (!explicitUrl) {
    throw new Error('Missing value after --url')
  }

  rest.splice(urlIndex, 2)
  return explicitUrl.replace(/\/+$/, '')
}

const usage = () => {
  console.log('Usage:')
  console.log('  npm run wallet:server')
  console.log('  npm run wallet:set -- SYMBOL AMOUNT [--url http://127.0.0.1:8787]')
  console.log('  npm run wallet:add -- SYMBOL AMOUNT [--url http://127.0.0.1:8787]')
  console.log('  npm run wallet:reset [-- --url http://127.0.0.1:8787]')
  console.log('  npm run wallet:status [-- --url http://127.0.0.1:8787]')
}

const normalizeSymbol = (value) => value.trim().toUpperCase()

const run = async () => {
  if (!command) {
    usage()
    process.exit(1)
  }

  let baseUrl

  try {
    baseUrl = parseBaseUrl()
  } catch (error) {
    console.error(`[wallet-cli] ${error.message}`)
    process.exit(1)
  }

  if (command === 'status') {
    const response = await fetch(`${baseUrl}/state`)

    if (!response.ok) {
      throw new Error(`status failed with HTTP ${response.status}`)
    }

    const payload = await response.json()
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (command === 'reset') {
    const response = await fetch(`${baseUrl}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`reset failed: ${text}`)
    }

    const payload = await response.json()
    console.log('[wallet-cli] reset complete')
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  if (command === 'set' || command === 'add') {
    const symbol = normalizeSymbol(rest[0] ?? '')
    const amount = Number(rest[1])

    if (!symbol || !Number.isFinite(amount)) {
      usage()
      throw new Error('set/add require SYMBOL and AMOUNT')
    }

    const response = await fetch(`${baseUrl}/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, amount }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`${command} failed: ${text}`)
    }

    const payload = await response.json()
    console.log(`[wallet-cli] ${command} ${symbol} ${amount} OK`)
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  usage()
  throw new Error(`Unknown command: ${command}`)
}

run().catch((error) => {
  console.error(`[wallet-cli] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
})
