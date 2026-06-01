import * as db from './db'

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, env, url)
    }

    return env.ASSETS.fetch(req)
  }
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  try {
    const path = url.pathname

    if (req.method === 'POST' && path === '/api/players') {
      return await handleCreatePlayer(req, env)
    }

    if (req.method === 'GET' && path === '/api/session') {
      return await handleGetSessionPlayer(req, env)
    }

    if (req.method === 'GET' && path === '/api/leaderboard') {
      return await handleGetLeaderboard(env)
    }

    if (req.method === 'GET' && path.match(/^\/api\/players\/\d+$/)) {
      return await handleGetPlayer(env, path)
    }

    if (req.method === 'POST' && path === '/api/games') {
      return await handleStartGame(req, env)
    }

    if (req.method === 'POST' && path.match(/^\/api\/games\/\d+\/spins$/)) {
      return await handleRecordSpin(req, env, path)
    }

    if (req.method === 'POST' && path.match(/^\/api\/games\/\d+\/end$/)) {
      return await handleEndGame(req, env, path)
    }

    return jsonResponse({ error: 'Not Found' }, 404)
  } catch (error) {
    console.error('API error:', error)

    if (error instanceof Error) {
      if (
        error.message.includes('does not exist') ||
        error.message.includes('Failed to retrieve') ||
        error.message.includes('Failed to calculate') ||
        error.message.includes('Failed to update') ||
        error.message.includes('Failed to create') ||
        error.message.includes('Failed to record')
      ) {
        return jsonResponse({ error: error.message }, 404)
      }

      if (
        error.message.includes('required') ||
        error.message.includes('Invalid') ||
        error.message.includes('must be')
      ) {
        return jsonResponse({ error: error.message }, 400)
      }
    }

    return jsonResponse({ error: 'Internal Server Error' }, 500)
  }
}

async function handleCreatePlayer(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { playerName?: string; sessionId?: string }
  const player = await db.getOrCreatePlayer(env, body.playerName ?? '', body.sessionId)
  return jsonResponse(player)
}

async function handleGetSessionPlayer(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) {
    return jsonResponse({ error: 'Session ID is required' }, 400)
  }
  const player = await db.getPlayerBySessionId(env, sessionId)
  return jsonResponse(player)
}

async function handleGetLeaderboard(env: Env): Promise<Response> {
  const leaderboard = await db.getLeaderboard(env)
  return jsonResponse(leaderboard)
}

async function handleGetPlayer(env: Env, path: string): Promise<Response> {
  const playerId = parseInt(path.split('/').pop() ?? '0', 10)
  if (isNaN(playerId)) {
    return jsonResponse({ error: 'Invalid player ID' }, 400)
  }

  const player = await db.getPlayerById(env, playerId)
  if (!player) {
    return jsonResponse({ error: `Player with ID ${playerId} does not exist` }, 404)
  }

  return jsonResponse(player)
}

async function handleStartGame(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { playerId?: number; startingBalance?: number }
  const result = await db.startGame(env, body.playerId ?? 0, body.startingBalance ?? 0)
  return jsonResponse(result)
}

async function handleRecordSpin(req: Request, env: Env, path: string): Promise<Response> {
  const match = path.match(/^\/api\/games\/(\d+)\/spins$/)
  if (!match) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }
  const gameId = parseInt(match[1], 10)
  if (isNaN(gameId)) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }

  const body = (await req.json()) as { symbols?: string; betAmount?: number }
  const result = await db.recordSpin(env, gameId, body.symbols ?? '', body.betAmount ?? 0)
  return jsonResponse(result)
}

async function handleEndGame(req: Request, env: Env, path: string): Promise<Response> {
  const match = path.match(/^\/api\/games\/(\d+)\/end$/)
  if (!match) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }
  const gameId = parseInt(match[1], 10)
  if (isNaN(gameId)) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }

  const body = (await req.json()) as { endingBalance?: number }
  await db.endGame(env, gameId, body.endingBalance ?? 0)
  return jsonResponse({})
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
