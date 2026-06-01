import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import PlayersList from './PlayersList'
import Error from './Error'
import Logo from './Logo'
import RetroButton from './RetroButton'
import { api, setAuthToken, getAuthToken, clearAuthToken } from '../api/client'
import type { LeaderboardEntry } from '../../worker/types'

const Home = (): React.ReactElement => {
  const navigate = useNavigate()
  const [message, setMessage] = useState('')
  const [playerExists, setPlayerExists] = useState<boolean>(false)
  const [playerId, setPlayerId] = useState<number | null>(null)
  const [playerName, setPlayerName] = useState<string>('')
  const [isAdding, setIsAdding] = useState<boolean>(false)
  const [players, setPlayers] = useState<LeaderboardEntry[]>([])

  useEffect(() => {
    const loadPlayers = async (): Promise<void> => {
      try {
        const leaderboard = await api.getLeaderboard()
        setPlayers(leaderboard)
      } catch (error) {
        console.error('Database error:', error)
      }
    }

    loadPlayers()
  }, [])

  useEffect(() => {
    if (!getAuthToken()) return

    const checkExistingPlayer = async (): Promise<void> => {
      try {
        const player = await api.getCurrentPlayer()
        setPlayerExists(true)
        setPlayerId(player.player_id)
        setPlayerName(player.name)
      } catch (error) {
        // Token missing/invalid/expired — clear it so the user can re-register.
        console.error('Error restoring session:', error)
        clearAuthToken()
      }
    }

    checkExistingPlayer()
  }, [])

  const handleAddPlayer = async (): Promise<void> => {
    if (!playerName.trim() || isAdding) return

    setIsAdding(true)
    try {
      const player = await api.getOrCreatePlayer(playerName.trim())

      setAuthToken(player.authToken)
      setMessage(`Welcome ${player.name}! You've been added to the leaderboard.`)

      setPlayerExists(true)
      setPlayerId(player.player_id)
      setPlayerName(player.name)

      try {
        const leaderboard = await api.getLeaderboard()
        setPlayers(leaderboard)
      } catch (error) {
        console.error('Error loading leaderboard:', error)
      }
    } catch (error) {
      console.error('Error adding player:', error)
      setMessage('Error adding player: ' + (error as Error).message)
    } finally {
      setIsAdding(false)
    }
  }

  const handleContinue = (): void => {
    if (playerId !== null) {
      navigate('/play', { state: { playerId, playerName } })
    }
  }

  return (
    <div className="home page-container">
      {message.includes('Error') && <Error error={message} />}
      {!message.includes('Error') && (
        <>
          <Logo />

          {!playerExists ? (
            <div className="add-player-welcome">
              <p className="welcome-message">
                Welcome new player! Enter your name here to enter the leaderboard:{' '}
              </p>
              <div className="add-player-form">
                <input
                  type="text"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  className="add-player-input"
                  disabled={isAdding}
                  placeholder="Enter your name..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAddPlayer()
                    }
                  }}
                />
                <RetroButton onClick={handleAddPlayer} disabled={isAdding || !playerName.trim()}>
                  {isAdding ? 'Adding...' : 'Add'}
                </RetroButton>
              </div>
            </div>
          ) : (
            <div className="continue-section">
              <p className="welcome-back-message">Welcome, {playerName}!</p>
              <RetroButton onClick={handleContinue}>Continue</RetroButton>
            </div>
          )}

          <PlayersList players={players} />
        </>
      )}
    </div>
  )
}

export default Home
