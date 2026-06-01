import SlotReel from './SlotReel'

interface SlotMachineProps {
  totalSlots: number
  currentSymbols: string[]
  winningIndices: Set<number>
  reward: number | null
  spinningReels: Set<number>
  symbols: string[]
  isGameStartSoundPlaying: boolean
}

const SlotMachine = ({
  totalSlots,
  currentSymbols,
  winningIndices,
  reward,
  spinningReels,
  symbols,
  isGameStartSoundPlaying
}: SlotMachineProps): React.ReactElement => {
  return (
    <div className="slot-machine-container">
      {Array.from({ length: totalSlots }, (_, index) => {
        const isWinner = winningIndices.has(index) && reward !== null && reward > 0
        const isReelSpinning = spinningReels.has(index)
        return (
          <SlotReel
            key={index}
            symbol={currentSymbols[index] || null}
            isSpinning={isReelSpinning}
            isWinner={isWinner}
            symbols={symbols}
            reelIndex={index}
            isGameStartSoundPlaying={isGameStartSoundPlaying}
          />
        )
      })}
    </div>
  )
}

export default SlotMachine
