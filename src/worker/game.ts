// Authoritative, server-side game logic.
//
// SECURITY: The reward for a spin is computed here from the submitted symbols,
// never trusted from the client. The client may render whatever it likes, but
// the balance/leaderboard impact is derived exclusively from this code.

// Stable symbol identifiers shared with the client (see src/client/lib/symbols.ts).
// These are intentionally NOT the asset URLs (which are build-time hashed and not
// a stable contract). Keep this list in sync with the client symbol list.
export const SYMBOL_IDS = [
  'balrog',
  'blanka',
  'cammy',
  'chunli',
  'deejay',
  'dhalsim',
  'ehonda',
  'feilong',
  'guile',
  'ken',
  'mbison',
  'ryu',
  'sagat',
  'thawk',
  'vega',
  'zangief'
] as const

export type SymbolId = (typeof SYMBOL_IDS)[number]

// Number of reels in a single spin. Must match the client's totalSlots.
export const TOTAL_SLOTS = 5

const SYMBOL_ID_SET = new Set<string>(SYMBOL_IDS)

/**
 * Parse and validate a client-submitted symbols string.
 *
 * Expected format: comma-separated stable symbol ids, exactly TOTAL_SLOTS of them,
 * each one a member of SYMBOL_IDS.
 *
 * Throws an Error (message starting with "Invalid") on any malformed input.
 */
export function parseSymbols(symbols: string): SymbolId[] {
  if (typeof symbols !== 'string' || symbols.trim().length === 0) {
    throw new Error('Invalid symbols: must be a non-empty string')
  }

  const parts = symbols.split(',').map((s) => s.trim())

  if (parts.length !== TOTAL_SLOTS) {
    throw new Error(`Invalid symbols: expected exactly ${TOTAL_SLOTS} symbols`)
  }

  for (const part of parts) {
    if (!SYMBOL_ID_SET.has(part)) {
      throw new Error(`Invalid symbols: unknown symbol "${part}"`)
    }
  }

  return parts as SymbolId[]
}

/**
 * Authoritative reward calculation. Mirrors the client UX rules:
 * - all symbols the same: 100 (does not accumulate)
 * - each three-of-a-kind (or more): 50
 * - each pair: 20
 */
export function calculateReward(symbols: string[]): number {
  if (symbols.length === 0) {
    return 0
  }

  const symbolCounts = new Map<string, number>()
  for (const symbol of symbols) {
    symbolCounts.set(symbol, (symbolCounts.get(symbol) || 0) + 1)
  }

  let maxCount = 0
  for (const count of symbolCounts.values()) {
    if (count > maxCount) {
      maxCount = count
    }
  }

  if (maxCount === symbols.length) {
    return 100
  }

  let totalReward = 0
  for (const count of symbolCounts.values()) {
    if (count >= 3) {
      totalReward += 50
    } else if (count === 2) {
      totalReward += 20
    }
  }

  return totalReward
}
