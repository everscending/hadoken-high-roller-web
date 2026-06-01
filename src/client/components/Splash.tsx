import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import RetroButton from './RetroButton'
import Logo from './Logo'
import ryuHadokenSoundUrl from '../assets/sounds/ryu-hadoken.mp3?url'
import confirmSoundUrl from '../assets/sounds/street-fighter-ii-confirm.mp3?url'

const Splash = (): React.ReactElement => {
  const navigate = useNavigate()
  const [isFading, setIsFading] = useState(false)

  useEffect(() => {
    const playHadokenSound = (): void => {
      try {
        const audio = new Audio(ryuHadokenSoundUrl)
        audio.play().catch((error) => {
          console.warn('Could not play hadoken sound:', error)
        })
      } catch (error) {
        console.warn('Could not play hadoken sound:', error)
      }
    }
    playHadokenSound()
  }, [])

  const handleInsertCoin = (): void => {
    try {
      const audio = new Audio(confirmSoundUrl)
      audio.play().catch((error) => {
        console.warn('Could not play confirm sound:', error)
      })
    } catch (error) {
      console.warn('Could not play confirm sound:', error)
    }

    setIsFading(true)
    setTimeout(() => {
      navigate('/home')
    }, 500)
  }

  return (
    <div className={`splash-screen ${isFading ? 'splash-screen--fading' : ''}`}>
      <Logo />
      <RetroButton onClick={handleInsertCoin}>INSERT COIN</RetroButton>
    </div>
  )
}

export default Splash
