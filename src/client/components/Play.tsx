import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { streetFighterSymbols, streetFighterSymbolIds, calculateReward } from '../lib/symbols'
import SlotMachine from './SlotMachine'
import SpinButton from './SpinButton'
import CoinCounter from './CoinCounter'
import RetroButton from './RetroButton'
import Logo from './Logo'
import GameOver from './GameOver'
import RewardModal from './RewardModal'
import { api } from '../api/client'

// Import the cash register sound file using Vite's asset handling
import youWonSoundUrl from '../assets/sounds/youwin.mp3?url'
import youLostSoundUrl from '../assets/sounds/death.mp3?url'
import gameOverSoundUrl from '../assets/sounds/youlose.mp3?url'
import symbolChosenSoundUrl from '../assets/sounds/sfii-44-fierce-hit.mp3?url'
import perfectWinSoundUrl from '../assets/sounds/perfect.mp3?url'
import betaVsScreenSoundUrl from '../assets/sounds/street-fighter-2-beta-vs-screen.mp3?url'
import round1SoundUrl from '../assets/sounds/street_fighter_round_1.mp3?url'

const startingCoins = 100
const betAmount = 10
const totalSlots = 5
const slotUpdateInterval = 500

const getAudio = (() => {
  const cache = new Map<string, HTMLAudioElement>()
  return (url: string): HTMLAudioElement => {
    let audio = cache.get(url)
    if (!audio) {
      audio = new Audio(url)
      cache.set(url, audio)
    }
    audio.currentTime = 0
    return audio
  }
})()

const playYouWonSound = (): void => {
  try {
    getAudio(youWonSoundUrl).play().catch((error) => {
      console.warn('Could not play you won sound:', error)
    })
  } catch (error) {
    console.warn('Could not play you won sound:', error)
  }
}

const playYouLostSound = (): void => {
  try {
    getAudio(youLostSoundUrl).play().catch((error) => {
      console.warn('Could not play you lost sound:', error)
    })
  } catch (error) {
    console.warn('Could not play you lost sound:', error)
  }
}

const playGameOverSound = (): void => {
  try {
    const betaVsScreenAudio = getAudio(betaVsScreenSoundUrl)
    betaVsScreenAudio.play().catch(() => {
      getAudio(gameOverSoundUrl).play().catch((error) => {
        console.warn('Could not play game over sound:', error)
      })
    })

    betaVsScreenAudio.addEventListener('ended', () => {
      getAudio(gameOverSoundUrl).play().catch((error) => {
        console.warn('Could not play you lose sound:', error)
      })
    }, { once: true })
  } catch (error) {
    console.warn('Could not play game over sound:', error)
    try {
      getAudio(gameOverSoundUrl).play().catch((error) => {
        console.warn('Could not play fallback game over sound:', error)
      })
    } catch (fallbackError) {
      console.warn('Could not play fallback game over sound:', fallbackError)
    }
  }
}

const playSymbolChosenSound = (): void => {
  try {
    getAudio(symbolChosenSoundUrl).play().catch((error) => {
      console.warn('Could not play symbol chosen sound:', error)
    })
  } catch (error) {
    console.warn('Could not play symbol chosen sound:', error)
  }
}

const playPerfectWinSound = (): void => {
  try {
    getAudio(perfectWinSoundUrl).play().catch((error) => {
      console.warn('Could not play perfect win sound:', error)
    })
  } catch (error) {
    console.warn('Could not play perfect win sound:', error)
  }
}

const playGameStartSound = (onFinished: () => void): void => {
  const round1Audio = getAudio(round1SoundUrl)
  round1Audio
    .play()
    .then(() => {
      round1Audio.addEventListener('ended', onFinished, { once: true })
    })
    .catch((err) => {
      console.warn('Could not play round 1 sound:', err)
      onFinished()
    })
}

const getWinningSymbolIndices = (symbols: string[]): Set<number> => {
  const winningIndices = new Set<number>()

  const symbolCounts = new Map<string, number[]>()
  symbols.forEach((symbol, index) => {
    if (!symbolCounts.has(symbol)) {
      symbolCounts.set(symbol, [])
    }
    symbolCounts.get(symbol)?.push(index)
  })

  for (const [, indices] of symbolCounts.entries()) {
    if (indices.length >= 2) {
      indices.forEach((index) => winningIndices.add(index))
    }
  }

  return winningIndices
}

const Play = (): React.ReactElement => {
  const location = useLocation()
  const navigate = useNavigate()
  const playerInfo = (location.state as { playerId?: number; playerName?: string } | null) || {}
  const playerId = playerInfo.playerId?.toString() ?? ''
  const playerName = playerInfo.playerName ?? ''
  const [currentSymbols, setCurrentSymbols] = useState<string[]>([])
  const [reward, setReward] = useState<number | null>(null)
  const [isSpinning, setIsSpinning] = useState(false)
  const [totalCoins, setTotalCoins] = useState<number>(startingCoins)
  const [winningIndices, setWinningIndices] = useState<Set<number>>(new Set())
  const [gameId, setGameId] = useState<number | null>(null)
  const [isGameOver, setIsGameOver] = useState<boolean>(false)
  const [spinningReels, setSpinningReels] = useState<Set<number>>(new Set())
  const [isGameStartSoundPlaying, setIsGameStartSoundPlaying] = useState<boolean>(false)
  const [animateSpinButton, setAnimateSpinButton] = useState<boolean>(false)
  const [isAutoSpinning, setIsAutoSpinning] = useState<boolean>(false)
  const [isRewardModalVisible, setIsRewardModalVisible] = useState<boolean>(false)
  const autoSpinRef = useRef<boolean>(false)
  const isGameOverRef = useRef<boolean>(false)
  const isRewardModalVisibleRef = useRef<boolean>(false)
  const coinsAfterBetRef = useRef<number>(0)

  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null
    const startGame = async (): Promise<void> => {
      if (!playerId) return
      try {
        const playerIdNum = parseInt(playerId, 10)
        if (isNaN(playerIdNum)) {
          console.error('Invalid player ID:', playerId)
          return
        }
        const game = await api.startGame(startingCoins)
        setGameId(game.gameId)
        setIsGameStartSoundPlaying(true)
        playGameStartSound(() => {
          setIsGameStartSoundPlaying(false)
          setAnimateSpinButton(true)
          timeoutId = setTimeout(() => {
            setAnimateSpinButton(false)
          }, 800)
        })
      } catch (error) {
        console.error('Error starting game:', error)
      }
    }
    startGame()
    return (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
  }, [playerId])

  const restartGame = async (): Promise<void> => {
    if (!playerId) return

    setIsAutoSpinning(false)
    autoSpinRef.current = false

    if (gameId !== null) {
      try {
        await api.endGame(gameId, totalCoins)
      } catch (error) {
        console.error('Error ending game:', error)
      }
    }

    setCurrentSymbols([])
    setReward(null)
    setIsSpinning(false)
    setTotalCoins(startingCoins)
    setWinningIndices(new Set())
    setIsGameOver(false)
    setSpinningReels(new Set())
    setIsGameStartSoundPlaying(false)
    setAnimateSpinButton(false)

    try {
      const playerIdNum = parseInt(playerId, 10)
      if (isNaN(playerIdNum)) {
        console.error('Invalid player ID:', playerId)
        return
      }
      const game = await api.startGame(startingCoins)
      setGameId(game.gameId)
      setIsGameStartSoundPlaying(true)
      playGameStartSound(() => {
        setIsGameStartSoundPlaying(false)
        setAnimateSpinButton(true)
        setTimeout(() => {
          setAnimateSpinButton(false)
        }, 1000)
      })
    } catch (error) {
      console.error('Error starting new game:', error)
    }
  }

  const spin = (): void => {
    setTotalCoins((prev) => {
      coinsAfterBetRef.current = prev - betAmount
      return coinsAfterBetRef.current
    })
    setIsSpinning(true)
    setReward(null)
    setIsRewardModalVisible(false)
    setWinningIndices(new Set())
    setSpinningReels(new Set(Array.from({ length: totalSlots }, (_, i) => i)))

    const randomIndices = Array.from({ length: totalSlots }, () =>
      Math.floor(Math.random() * streetFighterSymbols.length)
    )
    const randomSymbols = randomIndices.map((i) => streetFighterSymbols[i])
    const randomSymbolIds = randomIndices.map((i) => streetFighterSymbolIds[i])

    const stopTimers: ReturnType<typeof setTimeout>[] = []
    for (let i = 0; i < totalSlots; i++) {
      const timer = setTimeout(
        () => {
          setSpinningReels((prev) => {
            const next = new Set(prev)
            next.delete(i)
            return next
          })
          playSymbolChosenSound()
        },
        (i + 1) * slotUpdateInterval
      )
      stopTimers.push(timer)
    }

    setCurrentSymbols(randomSymbols)

    setTimeout(async () => {
      // Provisional reward for instant UX; the server is authoritative and may
      // override this once the spin is recorded.
      let calculatedReward = calculateReward(randomSymbols)

      if (gameId !== null) {
        try {
          const symbolsString = randomSymbolIds.join(',')
          const result = await api.recordSpin(gameId, symbolsString, betAmount)
          // SECURITY: trust the server-computed win amount.
          calculatedReward = result.winAmount
        } catch (error) {
          console.error('Error recording spin:', error)
        }
      }

      setReward(calculatedReward)
      setIsRewardModalVisible(true)
      const finalCoins = coinsAfterBetRef.current + calculatedReward
      setTotalCoins(finalCoins)

      const isGameEnding = finalCoins < betAmount

      if (calculatedReward > 0) {
        const winners = getWinningSymbolIndices(randomSymbols)
        setWinningIndices(winners)
        const allSymbolsAreWinners = winners.size === randomSymbols.length
        if (allSymbolsAreWinners) {
          playPerfectWinSound()
        } else {
          playYouWonSound()
        }
      } else {
        setWinningIndices(new Set())
        if (!isGameEnding) {
          playYouLostSound()
        }
      }

      setIsSpinning(false)
      setSpinningReels(new Set())

      stopTimers.forEach((timer) => clearTimeout(timer))

      if (isGameEnding) {
        setIsAutoSpinning(false)
        autoSpinRef.current = false

        if (gameId !== null) {
          try {
            await api.endGame(gameId, finalCoins)
          } catch (error) {
            console.error('Error ending game:', error)
          }
        }
        playGameOverSound()
        setIsGameOver(true)
      } else {
        if (autoSpinRef.current && finalCoins >= betAmount && !isGameOver) {
          setTimeout(() => {
            if (
              autoSpinRef.current &&
              finalCoins >= betAmount &&
              !isGameOverRef.current &&
              !isRewardModalVisibleRef.current
            ) {
              spin()
            }
          }, 2500)
        }
      }
    }, totalSlots * slotUpdateInterval)
  }

  const handleRewardModalClose = (): void => {
    setIsRewardModalVisible(false)
    setReward(null)
  }

  const toggleAutoSpin = (): void => {
    const newAutoSpinState = !isAutoSpinning
    setIsAutoSpinning(newAutoSpinState)
    autoSpinRef.current = newAutoSpinState

    if (
      newAutoSpinState &&
      !isSpinning &&
      totalCoins >= betAmount &&
      !isGameOver &&
      !isGameStartSoundPlaying &&
      !isRewardModalVisible
    ) {
      spin()
    }
  }

  const quitGame = async (): Promise<void> => {
    setIsAutoSpinning(false)
    autoSpinRef.current = false

    if (gameId !== null) {
      try {
        await api.endGame(gameId, totalCoins)
        navigate('/home')
      } catch (error) {
        console.error('Error ending game:', error)
      }
    }
  }

  useEffect(() => {
    autoSpinRef.current = isAutoSpinning
  }, [isAutoSpinning])

  useEffect(() => {
    isGameOverRef.current = isGameOver
  }, [isGameOver])

  useEffect(() => {
    isRewardModalVisibleRef.current = isRewardModalVisible
  }, [isRewardModalVisible])

  return (
    <div className="play page-container-play">
      {isGameOver && <GameOver onRestart={restartGame} onHomeClick={quitGame} />}

      <Logo />

      <div className="content-container">
        <CoinCounter totalCoins={totalCoins} />
        <div className="player-name">{playerName || 'Player'} vs Computer</div>
        <SlotMachine
          totalSlots={totalSlots}
          currentSymbols={currentSymbols}
          winningIndices={winningIndices}
          reward={reward}
          spinningReels={spinningReels}
          symbols={streetFighterSymbols}
          isGameStartSoundPlaying={isGameStartSoundPlaying}
        />

        {reward !== null && isRewardModalVisible && (
          <RewardModal reward={reward} onClose={handleRewardModalClose} />
        )}

        <div className="button-container">
          <SpinButton
            onClick={spin}
            disabled={
              isSpinning ||
              totalCoins < betAmount ||
              isGameStartSoundPlaying ||
              isAutoSpinning ||
              isRewardModalVisible
            }
            isSpinning={isSpinning}
            hasInsufficientCoins={totalCoins < betAmount}
            animateBorder={animateSpinButton}
            isGameStartSoundPlaying={isGameStartSoundPlaying}
          />

          <RetroButton
            onClick={toggleAutoSpin}
            disabled={
              isGameStartSoundPlaying ||
              isGameOver ||
              totalCoins < betAmount ||
              isRewardModalVisible
            }
            className={isAutoSpinning ? 'auto-spin-active' : ''}
          >
            {isAutoSpinning ? 'Stop Auto-Spin' : 'Auto-Spin'}
          </RetroButton>

          <RetroButton
            onClick={restartGame}
            disabled={isSpinning || isRewardModalVisible || isGameStartSoundPlaying}
          >
            Restart
          </RetroButton>
          <RetroButton
            onClick={quitGame}
            disabled={isSpinning || isRewardModalVisible || isGameStartSoundPlaying}
          >
            Quit
          </RetroButton>
        </div>
      </div>
    </div>
  )
}

export default Play
