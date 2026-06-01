import type { Player, LeaderboardEntry } from './types'
import { parseSymbols, calculateReward } from './game'

export async function getOrCreatePlayer(
  env: { DB: D1Database },
  playerName: string
): Promise<{ player: Player; created: boolean }> {
  if (!playerName || typeof playerName !== 'string' || playerName.trim().length === 0) {
    throw new Error('Player name is required and must be a non-empty string')
  }

  const name = playerName.trim()

  let player = await env.DB.prepare('SELECT * FROM players WHERE name = ?')
    .bind(name)
    .first<Player>()

  if (!player) {
    const result = await env.DB.prepare(
      'INSERT INTO players (name) VALUES (?)'
    )
      .bind(name)
      .run()

    player = await env.DB.prepare('SELECT * FROM players WHERE player_id = ?')
      .bind(result.meta.last_row_id)
      .first<Player>()

    if (!player) {
      throw new Error('Failed to retrieve newly created player')
    }

    return { player, created: true }
  }

  return { player, created: false }
}

export async function startGame(
  env: { DB: D1Database },
  playerId: number,
  startingBalance: number
): Promise<{ gameId: number }> {
  if (!Number.isInteger(playerId) || playerId <= 0) {
    throw new Error('Invalid player ID: must be a positive integer')
  }

  if (!Number.isInteger(startingBalance) || startingBalance < 0) {
    throw new Error('Invalid starting balance: must be a non-negative integer')
  }

  const player = await env.DB.prepare('SELECT player_id FROM players WHERE player_id = ?')
    .bind(playerId)
    .first<{ player_id: number }>()

  if (!player) {
    throw new Error(`Player with ID ${playerId} does not exist`)
  }

  const result = await env.DB.prepare(
    'INSERT INTO games (player_id, starting_balance) VALUES (?, ?)'
  )
    .bind(playerId, startingBalance)
    .run()

  if (!result.meta.last_row_id) {
    throw new Error('Failed to create game')
  }

  return { gameId: result.meta.last_row_id }
}

export async function recordSpin(
  env: { DB: D1Database },
  gameId: number,
  symbols: string,
  betAmount: number
): Promise<{ spinId: number; winAmount: number }> {
  if (!Number.isInteger(gameId) || gameId <= 0) {
    throw new Error('Invalid game ID: must be a positive integer')
  }

  // SECURITY: validate the symbols and derive the reward authoritatively.
  // The client's claimed win amount (if any) is never trusted.
  const parsedSymbols = parseSymbols(symbols)
  const winAmount = calculateReward(parsedSymbols)

  if (!Number.isInteger(betAmount) || betAmount <= 0) {
    throw new Error('Invalid bet amount: must be a positive integer')
  }

  const game = await env.DB.prepare('SELECT game_id FROM games WHERE game_id = ?')
    .bind(gameId)
    .first<{ game_id: number }>()

  if (!game) {
    throw new Error(`Game with ID ${gameId} does not exist`)
  }

  const normalizedSymbols = parsedSymbols.join(',')

  // ATOMICITY: D1 has no interactive transactions, but `batch()` runs all
  // statements in a single implicit transaction (sequential, all-or-nothing,
  // with later statements seeing earlier ones' effects). We insert the spin and
  // update the player stats in one batch. The player update computes the game's
  // balance inline via a subquery rather than relying on a JS round-trip value,
  // so concurrent spins for the same game cannot interleave and lose updates or
  // read a stale balance.
  const batchResults = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO spins (game_id, symbols, bet_amount, win_amount) VALUES (?, ?, ?, ?)`
    ).bind(gameId, normalizedSymbols, betAmount, winAmount),
    env.DB.prepare(
      `UPDATE players SET
        total_spins = total_spins + 1,
        highest_balance = MAX(
          highest_balance,
          (
            SELECT games.starting_balance + COALESCE(SUM(spins.win_amount - spins.bet_amount), 0)
            FROM games
            LEFT JOIN spins ON games.game_id = spins.game_id
            WHERE games.game_id = ?
          )
        )
      WHERE player_id = (SELECT player_id FROM games WHERE game_id = ?)`
    ).bind(gameId, gameId)
  ])

  const insertResult = batchResults[0]
  if (!insertResult.meta.last_row_id) {
    throw new Error('Failed to record spin')
  }

  if (batchResults[1].meta.changes === 0) {
    throw new Error(`Failed to update player stats for game ID ${gameId}`)
  }

  return { spinId: insertResult.meta.last_row_id, winAmount }
}

export async function endGame(
  env: { DB: D1Database },
  gameId: number,
  endingBalance: number
): Promise<void> {
  if (!Number.isInteger(gameId) || gameId <= 0) {
    throw new Error('Invalid game ID: must be a positive integer')
  }

  if (!Number.isInteger(endingBalance) || endingBalance < 0) {
    throw new Error('Invalid ending balance: must be a non-negative integer')
  }

  const game = await env.DB.prepare('SELECT game_id FROM games WHERE game_id = ?')
    .bind(gameId)
    .first<{ game_id: number }>()

  if (!game) {
    throw new Error(`Game with ID ${gameId} does not exist`)
  }

  const result = await env.DB.prepare(
    `UPDATE games
     SET end_time = CURRENT_TIMESTAMP, ending_balance = ?
     WHERE game_id = ?`
  )
    .bind(endingBalance, gameId)
    .run()

  if (result.meta.changes === 0) {
    throw new Error(`Failed to update game with ID ${gameId}`)
  }
}

export async function getLeaderboard(env: { DB: D1Database }): Promise<LeaderboardEntry[]> {
  const leaderboard = await env.DB.prepare(
    `SELECT player_id, name, highest_balance, total_spins
     FROM players
     ORDER BY highest_balance DESC
     LIMIT 10`
  ).all<LeaderboardEntry>()

  return leaderboard.results
}

export async function getPlayerById(
  env: { DB: D1Database },
  playerId: number
): Promise<Player | null> {
  const player = await env.DB.prepare('SELECT * FROM players WHERE player_id = ?')
    .bind(playerId)
    .first<Player>()

  return player || null
}

export async function createSessionToken(
  env: { DB: D1Database },
  playerId: number
): Promise<string> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString()

  await env.DB.prepare(
    'INSERT INTO auth_tokens (token, player_id, expires_at) VALUES (?, ?, ?)'
  )
    .bind(token, playerId, expiresAt)
    .run()

  return token
}

export async function validateSessionToken(
  env: { DB: D1Database },
  token: string
): Promise<{ playerId: number; expiresAt: string } | null> {
  const result = await env.DB.prepare(
    `SELECT player_id, expires_at FROM auth_tokens 
     WHERE token = ? AND expires_at > datetime('now')`
  )
    .bind(token)
    .first<{ player_id: number; expires_at: string }>()

  if (!result) {
    return null
  }

  return { playerId: result.player_id, expiresAt: result.expires_at }
}

export async function revokeSessionToken(
  env: { DB: D1Database },
  token: string
): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_tokens WHERE token = ?')
    .bind(token)
    .run()
}

export async function revokeAllPlayerTokens(
  env: { DB: D1Database },
  playerId: number
): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_tokens WHERE player_id = ?')
    .bind(playerId)
    .run()
}

export async function getPlayerByIdWithAuth(
  env: { DB: D1Database },
  playerId: number,
  token: string
): Promise<Player | null> {
  const auth = await validateSessionToken(env, token)
  if (!auth || auth.playerId !== playerId) {
    return null
  }

  const player = await env.DB.prepare('SELECT * FROM players WHERE player_id = ?')
    .bind(playerId)
    .first<Player>()

  return player || null
}
