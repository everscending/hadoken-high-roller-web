import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import * as THREE from 'three'
import WAVES from 'vanta/dist/vanta.waves.min'
import Splash from './components/Splash'
import Home from './components/Home'
import Play from './components/Play'
import ErrorBoundary from './components/ErrorBoundary'

const AnimatedRoutes = (): JSX.Element => {
  const location = useLocation()
  const [displayLocation, setDisplayLocation] = useState(location)
  const [transitionStage, setTransitionStage] = useState<'fadeIn' | 'fadeOut'>('fadeIn')

  useEffect(() => {
    if (location.pathname !== displayLocation.pathname) {
      setTransitionStage('fadeOut')
    }
  }, [location, displayLocation])

  const handleTransitionEnd = (): void => {
    if (transitionStage === 'fadeOut') {
      setDisplayLocation(location)
      setTransitionStage('fadeIn')
    }
  }

  return (
    <div
      className={`route-transition route-transition--${transitionStage}`}
      onTransitionEnd={handleTransitionEnd}
    >
      <Routes location={displayLocation}>
        <Route path="/splash" element={<Splash />} />
        <Route path="/home" element={<Home />} />
        <Route path="/play" element={<Play />} />
      </Routes>
    </div>
  )
}

function App(): JSX.Element {
  const vantaEffectRef = useRef<ReturnType<typeof WAVES> | null>(null)

  useEffect(() => {
    console.log('WAVES', WAVES)

    if (!vantaEffectRef.current) {
      const vantaEffectReturn = WAVES({
        THREE,
        el: '#animation-container',
        mouseControls: true,
        touchControls: true,
        gyroControls: false,
        minHeight: 200.0,
        minWidth: 200.0,
        scale: 1.0,
        scaleMobile: 1.0,
        color: 0x0,
        shininess: 50.0,
        waveHeight: 10.5,
        waveSpeed: 0.3,
        zoom: 0.98
      })
      vantaEffectRef.current = vantaEffectReturn
    }

    return (): void => {
      if (vantaEffectRef.current) {
        vantaEffectRef.current.destroy()
        vantaEffectRef.current = null
      }
    }
  }, [])

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Navigate to="/splash" replace />} />
          <Route path="/*" element={<AnimatedRoutes />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  )
}

export default App
