interface CoinCounterProps {
  totalCoins: number
}

const CoinCounter = ({ totalCoins }: CoinCounterProps): React.ReactElement => {
  return <div className="coin-counter">Coins: {totalCoins}</div>
}

export default CoinCounter
