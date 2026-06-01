import { useState } from 'react'

interface Player {
  player_id: number
  name: string
  created_at: string
}

interface AddPlayerProps {
  onAddPlayer: (playerName: string) => Promise<void>
  lastAddedPlayer?: Player | null
}

const AddPlayer = ({ onAddPlayer }: AddPlayerProps): React.ReactElement => {
  // const playerNameRef = useRef<HTMLInputElement>(null)
  const [playerName, setPlayerName] = useState<string>('TestPlayer')
  const [isAdding, setIsAdding] = useState<boolean>(false)

  const handlePlayerNameChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setPlayerName(e.target.value)
  }

  const handleAddPlayer = async (): Promise<void> => {
    setIsAdding(true)
    try {
      await onAddPlayer(playerName)
      setPlayerName('')
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <>
      <div className="add-player-container">
        <input
          // ref={playerNameRef}
          type="text"
          value={playerName}
          onChange={handlePlayerNameChange}
          className="add-player-input"
          disabled={isAdding}
          autoFocus
        />
        <button
          onClick={handleAddPlayer}
          disabled={isAdding || playerName.trim().length === 0}
          className="btn-add-player"
        >
          {isAdding ? 'Adding...' : 'Add Player'}
        </button>
      </div>
    </>
  )
}

export default AddPlayer
