export interface Player {
  player_id: number
  name: string
  created_at: string
  highest_balance: number
  total_spins: number
}

export interface LeaderboardEntry {
  player_id: number
  name: string
  highest_balance: number
  total_spins: number
}

export interface GetOrCreatePlayerRequest {
  playerName: string
}

export interface StartGameRequest {
  playerId: number
  startingBalance: number
}

export interface RecordSpinRequest {
  gameId: number
  symbols: string
  betAmount: number
}

export interface RecordSpinResponse {
  spinId: number
  winAmount: number
}

export interface EndGameRequest {
  gameId: number
  endingBalance: number
}
