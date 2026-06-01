import type { LeaderboardEntry } from '../../worker/types'

interface PlayersListProps {
  players: LeaderboardEntry[]
}

const PlayersList = ({ players }: PlayersListProps): React.ReactElement => {
  return (
    <div>
      {players.length > 0 ? (
        <table className="player-list">
          <thead>
            <tr>
              <th className="table-header-cell">Name</th>
              <th className="table-header-cell">High Score</th>
              <th className="table-header-cell">Total Spins</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player, index) => (
              <tr key={index}>
                <td className="table-cell">{player.name}</td>
                <td className="table-cell">{player.highest_balance}</td>
                <td className="table-cell">{player.total_spins}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No players in database yet.</p>
      )}
    </div>
  )
}

export default PlayersList
