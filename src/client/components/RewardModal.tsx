import { useEffect, useRef, useState } from 'react'

interface RewardModalProps {
  reward: number
  onClose: () => void
}

const RewardModal = ({ reward, onClose }: RewardModalProps): React.ReactElement => {
  const [isVisible, setIsVisible] = useState(true)
  const [isFading, setIsFading] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return (): void => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    // Show for 2 seconds, then fade out
    const fadeTimer = setTimeout(() => {
      if (mountedRef.current) {
        setIsFading(true)
      }
    }, 2000)

    // Close after fade animation completes
    const closeTimer = setTimeout(() => {
      if (mountedRef.current) {
        setIsVisible(false)
        onClose()
      }
    }, 2500) // 2000ms display + 500ms fade

    return (): void => {
      clearTimeout(fadeTimer)
      clearTimeout(closeTimer)
    }
  }, [onClose])

  if (!isVisible) {
    return <></>
  }

  const isWin = reward > 0

  return (
    <div className={`reward-modal-overlay ${isFading ? 'reward-modal-overlay--fading' : ''}`}>
      <div className={`reward-modal ${isWin ? 'reward-modal--win' : 'reward-modal--lose'}`}>
        <h2 className="reward-modal-title">{isWin ? '🎉 WIN! 🎉' : '😔 No Win'}</h2>
        <p className="reward-modal-message">
          {isWin ? `You won ${reward} coins!` : 'No win this time'}
        </p>
      </div>
    </div>
  )
}

export default RewardModal

