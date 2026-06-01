import * as db from './db'

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
}

interface AuthContext {
  playerId: number
}

async function authMiddleware(
  req: Request,
  env: Env
): Promise<AuthContext | null> {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  const result = await db.validateSessionToken(env, token)

  if (!result) {
    return null
  }

  return { playerId: result.playerId }
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

    if (req.method === 'GET' && path === '/api/me') {
      return await handleGetCurrentPlayer(req, env)
    }

    if (req.method === 'GET' && path === '/api/leaderboard') {
      return await handleGetLeaderboard(env)
    }

    if (req.method === 'GET' && path.match(/^\/api\/players\/\d+$/)) {
      return await handleGetPlayer(req, env, path)
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
        return jsonResponse({ error: 'Not found' }, 404)
      }

      if (
        error.message.includes('required') ||
        error.message.includes('Invalid') ||
        error.message.includes('must be')
      ) {
        return jsonResponse({ error: 'Invalid request' }, 400)
      }
    }

    return jsonResponse({ error: 'Internal server error' }, 500)
  }
}

async function handleCreatePlayer(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { playerName?: string }

  if (!body.playerName || typeof body.playerName !== 'string' || body.playerName.trim().length === 0) {
    return jsonResponse({ error: 'Player name is required' }, 400)
  }

  const name = body.playerName.trim()

  if (name.length > 32 || !/^[A-Za-z0-9 _-]+$/.test(name)) {
    return jsonResponse({ error: 'Invalid player name: must be 1-32 letters, digits, spaces, _ or -' }, 400)
  }

  const player = await db.getOrCreatePlayer(env, name)
  const token = await db.createSessionToken(env, player.player_id)

  return jsonResponse({ ...player, authToken: token })
}

async function handleGetCurrentPlayer(req: Request, env: Env): Promise<Response> {
  const auth = await authMiddleware(req, env)
  if (!auth) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const player = await db.getPlayerById(env, auth.playerId)
  if (!player) {
    return jsonResponse({ error: 'Not found' }, 404)
  }

  return jsonResponse(player)
}

async function handleGetLeaderboard(env: Env): Promise<Response> {
  const leaderboard = await db.getLeaderboard(env)
  return jsonResponse(leaderboard)
}

async function handleGetPlayer(req: Request, env: Env, path: string): Promise<Response> {
  const playerId = parseInt(path.split('/').pop() ?? '0', 10)

  if (isNaN(playerId)) {
    return jsonResponse({ error: 'Invalid player ID' }, 400)
  }

  const auth = await authMiddleware(req, env)
  if (!auth) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const player = await db.getPlayerByIdWithAuth(env, playerId, req.headers.get('Authorization')!.slice(7))
  if (!player) {
    return jsonResponse({ error: 'Not found' }, 404)
  }

  return jsonResponse(player)
}

async function handleStartGame(req: Request, env: Env): Promise<Response> {
  const auth = await authMiddleware(req, env)
  if (!auth) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const body = (await req.json()) as { startingBalance?: number }

  if (!body.startingBalance || !Number.isInteger(body.startingBalance) || body.startingBalance < 0) {
    return jsonResponse({ error: 'Invalid starting balance: must be a non-negative integer' }, 400)
  }

  const result = await db.startGame(env, auth.playerId, body.startingBalance)
  return jsonResponse(result)
}

async function handleRecordSpin(req: Request, env: Env, path: string): Promise<Response> {
  const auth = await authMiddleware(req, env)
  if (!auth) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const match = path.match(/^\/api\/games\/(\d+)\/spins$/)
  if (!match) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }

  const gameId = parseInt(match[1], 10)
  if (isNaN(gameId)) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }

  const body = (await req.json()) as { symbols?: string; betAmount?: number }

  if (!body.symbols || typeof body.symbols !== 'string') {
    return jsonResponse({ error: 'Symbols are required' }, 400)
  }

  if (body.betAmount === undefined || !Number.isInteger(body.betAmount) || body.betAmount <= 0) {
    return jsonResponse({ error: 'Invalid bet amount: must be a positive integer' }, 400)
  }

  if (body.betAmount > 100) {
    return jsonResponse({ error: 'Invalid bet amount: maximum is 100' }, 400)
  }

  const game = await env.DB.prepare(
    'SELECT g.player_id FROM games g WHERE g.game_id = ? AND g.end_time IS NULL'
  )
    .bind(gameId)
    .first<{ player_id: number }>()

  if (!game) {
    return jsonResponse({ error: 'Game not found or already ended' }, 404)
  }

  if (game.player_id !== auth.playerId) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  const result = await db.recordSpin(env, gameId, body.symbols, body.betAmount)
  return jsonResponse(result)
}

async function handleEndGame(req: Request, env: Env, path: string): Promise<Response> {
  const auth = await authMiddleware(req, env)
  if (!auth) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  const match = path.match(/^\/api\/games\/(\d+)\/end$/)
  if (!match) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }

  const gameId = parseInt(match[1], 10)
  if (isNaN(gameId)) {
    return jsonResponse({ error: 'Invalid game ID' }, 400)
  }

  const body = (await req.json()) as { endingBalance?: number }

  if (body.endingBalance === undefined || !Number.isInteger(body.endingBalance) || body.endingBalance < 0) {
    return jsonResponse({ error: 'Invalid ending balance: must be a non-negative integer' }, 400)
  }

  const game = await env.DB.prepare(
    'SELECT g.player_id FROM games g WHERE g.game_id = ?'
  )
    .bind(gameId)
    .first<{ player_id: number }>()

  if (!game) {
    return jsonResponse({ error: 'Game not found' }, 404)
  }

  if (game.player_id !== auth.playerId) {
    return jsonResponse({ error: 'Forbidden' }, 403)
  }

  await db.endGame(env, gameId, body.endingBalance)
  return jsonResponse({})
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
