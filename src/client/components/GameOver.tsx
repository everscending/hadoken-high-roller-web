import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import RetroButton from './RetroButton'

interface GameOverProps {
  onRestart: () => void
  onHomeClick: () => void | Promise<void>
}

const GameOver = ({ onRestart, onHomeClick }: GameOverProps): React.ReactElement => {
  const navigate = useNavigate()
  const [countdown, setCountdown] = useState(10)

  const handleHomeClick = useCallback(async (): Promise<void> => {
    await onHomeClick()
    navigate('/home')
  }, [onHomeClick, navigate])

  useEffect(() => {
    if (countdown <= 0) {
      handleHomeClick()
      return
    }

    const timer = setTimeout(() => {
      setCountdown(countdown - 1)
    }, 1000)

    return (): void => {
      clearTimeout(timer)
    }
  }, [countdown, handleHomeClick])

  return (
    <div className="game-over-overlay">
      <div className="game-over-modal">
        <h2 className="game-over-title">Game Over</h2>
        <p className="game-over-message">Restart game?</p>
        <p className="game-over-countdown">{countdown}</p>
        <div className="game-over-actions game-over-actions--horizontal">
          <RetroButton onClick={onRestart}>Yes</RetroButton>
          <RetroButton onClick={handleHomeClick}>No</RetroButton>
        </div>
      </div>
    </div>
  )
}

export default GameOver
