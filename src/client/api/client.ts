import type { Player, LeaderboardEntry } from '../../worker/types'

async function get<T>(url: string, params?: Record<string, string>): Promise<T> {
  const queryString = params ? '?' + new URLSearchParams(params).toString() : ''
  const response = await fetch(url + queryString)
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText)
    throw new Error(`POST ${url} failed: ${response.status} ${errorText}`)
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T
  }
  return response.json()
}

export const api = {
  getOrCreatePlayer: (name: string, sessionId?: string) =>
    post<Player>('/api/players', { playerName: name, sessionId }),
  getSessionPlayer: (sessionId: string) =>
    get<Player | null>('/api/session', { sessionId }),
  startGame: (playerId: number, startingBalance: number) =>
    post<{ gameId: number }>('/api/games', { playerId, startingBalance }),
  recordSpin: (gameId: number, symbols: string, betAmount: number) =>
    post<{ spinId: number; winAmount: number }>(`/api/games/${gameId}/spins`, {
      symbols,
      betAmount
    }),
  endGame: (gameId: number, endingBalance: number) =>
    post<void>(`/api/games/${gameId}/end`, { endingBalance }),
  getLeaderboard: () => get<LeaderboardEntry[]>('/api/leaderboard'),
  getPlayerById: (playerId: number) => get<Player>(`/api/players/${playerId}`)
}
