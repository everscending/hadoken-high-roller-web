/// <reference types="vite/client" />

declare module 'vanta/dist/vanta.waves.min' {
  interface VantaEffect {
    destroy(): void
  }

  interface VantaOptions {
    THREE: unknown
    el: string | HTMLElement | null
    mouseControls?: boolean
    touchControls?: boolean
    gyroControls?: boolean
    minHeight?: number
    minWidth?: number
    scale?: number
    scaleMobile?: number
    color?: number
    shininess?: number
    waveHeight?: number
    waveSpeed?: number
    zoom?: number
  }

  function WAVES(options: VantaOptions): VantaEffect | null
  export default WAVES
}
