import { createServer } from 'node:http'
import { URL } from 'node:url'
import { addAmount, readState, resetState, updateAmount } from './wallet-state-store.mjs'

const port = Number(process.env.WALLET_DEV_PORT ?? 8787)

const jsonResponse = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  response.end(JSON.stringify(payload))
}

const readBody = async (request) => {
  const chunks = []

  for await (const chunk of request) {
    chunks.push(chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('JSON body is invalid')
  }
}

const server = createServer(async (request, response) => {
  if (!request.url || !request.method) {
    jsonResponse(response, 400, { error: 'Invalid request' })
    return
  }

  if (request.method === 'OPTIONS') {
    jsonResponse(response, 204, {})
    return
  }

  const parsedUrl = new URL(request.url, `http://127.0.0.1:${port}`)

  try {
    if (request.method === 'GET' && parsedUrl.pathname === '/state') {
      jsonResponse(response, 200, readState())
      return
    }

    if (request.method === 'GET' && parsedUrl.pathname === '/health') {
      jsonResponse(response, 200, { status: 'ok', updatedAt: new Date().toISOString() })
      return
    }

    if (request.method === 'POST' && parsedUrl.pathname === '/set') {
      const body = await readBody(request)
      const next = updateAmount(body.symbol, body.amount)
      jsonResponse(response, 200, next)
      return
    }

    if (request.method === 'POST' && parsedUrl.pathname === '/add') {
      const body = await readBody(request)
      const next = addAmount(body.symbol, body.amount)
      jsonResponse(response, 200, next)
      return
    }

    if (request.method === 'POST' && parsedUrl.pathname === '/reset') {
      const next = resetState()
      jsonResponse(response, 200, next)
      return
    }

    jsonResponse(response, 404, { error: 'Route not found' })
  } catch (error) {
    jsonResponse(response, 400, {
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  }
})

server.listen(port, () => {
  console.log(`[wallet-dev-server] running on http://127.0.0.1:${port}`)
  console.log('[wallet-dev-server] endpoints: GET /state, POST /set, POST /add, POST /reset')
})
