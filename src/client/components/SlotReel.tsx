import { useState, useEffect } from 'react'

interface SlotReelProps {
  symbol: string | null
  isSpinning: boolean
  isWinner: boolean
  symbols: string[] // Array of image URLs
  reelIndex: number
  isGameStartSoundPlaying?: boolean
}

const SlotReel = ({
  symbol,
  isSpinning,
  isWinner,
  symbols,
  reelIndex,
  isGameStartSoundPlaying = false
}: SlotReelProps): React.ReactElement => {
  const [displaySymbol, setDisplaySymbol] = useState<string>(symbol || symbols[0] || '')
  const [justStopped, setJustStopped] = useState<boolean>(false)

  useEffect(() => {
    if (isSpinning) {
      // Each reel spins at a slightly different speed for a more realistic effect
      const spinSpeed = 100 + reelIndex * 20 // Vary speed by reel index
      let currentIndex = Math.floor(Math.random() * symbols.length)
      setJustStopped(false)

      const interval = setInterval(() => {
        currentIndex = (currentIndex + 1) % symbols.length
        setDisplaySymbol(symbols[currentIndex])
      }, spinSpeed)

      return (): void => {
        clearInterval(interval)
      }
    }
    // When spinning stops, show the final symbol and trigger animation
    setDisplaySymbol(symbol || '')
    setJustStopped(true)

    // Remove animation class after animation completes (500ms)
    const timer = setTimeout(() => {
      setJustStopped(false)
    }, 500)

    return (): void => {
      clearTimeout(timer)
    }
  }, [isSpinning, symbol, symbols, reelIndex])

  const reelClasses = ['slot-reel']
  if (isWinner) reelClasses.push('slot-reel--winner', 'winning-symbol')
  if (isGameStartSoundPlaying) reelClasses.push('reel-start-pulse')
  if (justStopped) reelClasses.push('slot-reel--just-stopped')

  return (
    <div className={reelClasses.join(' ')} style={{ animationDelay: `${reelIndex * 0.2}s` }}>
      {isSpinning ? (
        displaySymbol ? (
          <img
            src={displaySymbol}
            alt="spinning"
            className="slot-reel__symbol-image slot-reel__symbol-image--spinning"
          />
        ) : (
          <span className="slot-reel__placeholder">?</span>
        )
      ) : displaySymbol ? (
        <img src={displaySymbol} alt="symbol" className="slot-reel__symbol-image" />
      ) : (
        <span className="slot-reel__empty">-</span>
      )}
    </div>
  )
}

export default SlotReel
