import type { Player, LeaderboardEntry } from '../../worker/types'

const AUTH_TOKEN_KEY = 'hadoken_auth_token'

export function getAuthToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY)
}

export function setAuthToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token)
}

export function clearAuthToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY)
}

async function get<T>(url: string, params?: Record<string, string>): Promise<T> {
  const queryString = params ? '?' + new URLSearchParams(params).toString() : ''
  const token = getAuthToken()

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(url + queryString, { headers })
  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText)
    throw new Error(`GET ${url} failed: ${response.status} ${errorText}`)
  }
  return response.json()
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const token = getAuthToken()

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
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
  getOrCreatePlayer: (name: string) =>
    post<Player & { authToken: string }>('/api/players', { playerName: name }),
  getCurrentPlayer: () => get<Player>('/api/me'),
  startGame: (startingBalance: number) =>
    post<{ gameId: number }>('/api/games', { startingBalance }),
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
