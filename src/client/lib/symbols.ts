import symbol1 from '../assets/symbols/balrog.png'
import symbol2 from '../assets/symbols/blanka.png'
import symbol3 from '../assets/symbols/cammy.png'
import symbol4 from '../assets/symbols/chunli.png'
import symbol5 from '../assets/symbols/deejay.png'
import symbol6 from '../assets/symbols/dhalsim.png'
import symbol7 from '../assets/symbols/ehonda.png'
import symbol8 from '../assets/symbols/feilong.png'
import symbol9 from '../assets/symbols/guile.png'
import symbol10 from '../assets/symbols/ken.png'
import symbol11 from '../assets/symbols/mbison.png'
import symbol12 from '../assets/symbols/ryu.png'
import symbol13 from '../assets/symbols/sagat.png'
import symbol14 from '../assets/symbols/thawk.png'
import symbol15 from '../assets/symbols/vega.png'
import symbol16 from '../assets/symbols/zangief.png'
import { SYMBOL_IDS } from '../../worker/game'

// Stable symbol ids (shared with the server) paired with their image URLs.
// The ids are what we send to the server; the server recomputes the reward
// authoritatively from them.
export const symbolImages: Record<string, string> = {
  balrog: symbol1,
  blanka: symbol2,
  cammy: symbol3,
  chunli: symbol4,
  deejay: symbol5,
  dhalsim: symbol6,
  ehonda: symbol7,
  feilong: symbol8,
  guile: symbol9,
  ken: symbol10,
  mbison: symbol11,
  ryu: symbol12,
  sagat: symbol13,
  thawk: symbol14,
  vega: symbol15,
  zangief: symbol16
}

// Ordered list of stable symbol ids used by the slot machine.
export const streetFighterSymbolIds = [...SYMBOL_IDS]

// Image URLs in the same order, for components that render by URL.
export const streetFighterSymbols = streetFighterSymbolIds.map((id) => symbolImages[id])

export const calculateReward = (randomSymbols: string[]): number => {
  // function to calculate the reward based on the symbols
  // if all symbols are the same, return 100
  // if there are 2 of the same symbol, return 20 per pair
  // if there are 3 of the same symbol, return 50 per three-of-a-kind
  // rewards accumulate (e.g., 2 pairs = 40, pair + three-of-a-kind = 70)

  if (randomSymbols.length === 0) {
    return 0
  }

  // Count occurrences of each symbol
  const symbolCounts = new Map<string, number>()
  for (const symbol of randomSymbols) {
    symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1)
  }

  // Find the maximum count of any symbol
  let maxCount = 0
  for (const count of symbolCounts.values()) {
    if (count > maxCount) {
      maxCount = count
    }
  }

  // Special case: if all symbols are the same, return 100 (doesn't accumulate)
  if (maxCount === randomSymbols.length) {
    return 100
  }

  // Accumulate rewards for all winning combinations
  let totalReward = 0
  for (const count of symbolCounts.values()) {
    if (count >= 3) {
      // Three-of-a-kind or more: 50 coins
      totalReward += 50
    } else if (count === 2) {
      // Pair: 20 coins
      totalReward += 20
    }
  }

  return totalReward
}
