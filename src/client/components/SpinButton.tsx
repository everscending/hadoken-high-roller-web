import RetroButton from './RetroButton'

interface SpinButtonProps {
  onClick: () => void
  disabled: boolean
  isSpinning: boolean
  hasInsufficientCoins: boolean
  animateBorder?: boolean
  isGameStartSoundPlaying?: boolean
}

const SpinButton = ({
  onClick,
  disabled,
  isSpinning,
  hasInsufficientCoins,
  animateBorder = false,
  isGameStartSoundPlaying = false
}: SpinButtonProps): React.ReactElement => {
  const getButtonText = (): string => {
    if (isGameStartSoundPlaying) return 'Get ready...'
    if (isSpinning) return 'Spinning...'
    if (hasInsufficientCoins) return 'Insufficient Coins'
    return 'Fight!'
  }

  return (
    <RetroButton
      onClick={onClick}
      disabled={disabled}
      className={animateBorder ? 'spin-button-animate' : ''}
      onMouseDown={(e) => {
        if (disabled) {
          e.preventDefault()
        }
      }}
    >
      {getButtonText()}
    </RetroButton>
  )
}

export default SpinButton
