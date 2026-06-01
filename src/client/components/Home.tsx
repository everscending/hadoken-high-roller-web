import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import PlayersList from './PlayersList'
import Error from './Error'
import Logo from './Logo'
import RetroButton from './RetroButton'
import { api } from '../api/client'
import type { LeaderboardEntry } from '../../worker/types'

const SESSION_STORAGE_KEY = 'hadoken_session_id'

function generateSessionId(): string {
  return 'session_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36)
}

function getSessionId(): string {
  let sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY)
  if (!sessionId) {
    sessionId = generateSessionId()
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  }
  return sessionId
}

const Home = (): React.ReactElement => {
  const navigate = useNavigate()
  const [message, setMessage] = useState('')
  const [sessionId, setSessionId] = useState<string>('')
  const [playerExists, setPlayerExists] = useState<boolean>(false)
  const [playerId, setPlayerId] = useState<number | null>(null)
  const [playerName, setPlayerName] = useState<string>('')
  const [isAdding, setIsAdding] = useState<boolean>(false)
  const [players, setPlayers] = useState<LeaderboardEntry[]>([])

  useEffect(() => {
    const id = getSessionId()
    setSessionId(id)
  }, [])

  useEffect(() => {
    if (!sessionId) return

    const checkPlayer = async (): Promise<void> => {
      try {
        const player = await api.getSessionPlayer(sessionId)
        if (player) {
          setPlayerExists(true)
          setPlayerId(player.player_id)
          setPlayerName(player.name)
        }
      } catch (error) {
        console.error('Error checking session:', error)
      }
    }

    checkPlayer()
  }, [sessionId])

  const loadPlayers = async (): Promise<void> => {
    try {
      const leaderboard = await api.getLeaderboard()
      setPlayers(leaderboard)
    } catch (error) {
      console.error('Database error:', error)
    }
  }

  useEffect(() => {
    loadPlayers()
  }, [])

  const handleAddPlayer = async (): Promise<void> => {
    if (!playerName.trim() || isAdding) return

    setIsAdding(true)
    try {
      const player = await api.getOrCreatePlayer(playerName.trim(), sessionId)

      setMessage(`Welcome ${player.name}! You've been added to the leaderboard.`)

      setPlayerExists(true)
      setPlayerId(player.player_id)
      setPlayerName(player.name)

      await loadPlayers()
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
