/**
 * Splitting costs and working out who owes whom — SPEC §5.3.
 *
 * Money is integer cents everywhere, never a float. Not a style rule: a float
 * split three ways and added back up does not reliably equal what was paid, and
 * the resulting penny is the thing people argue about in a paddock at midnight.
 *
 * The ledger is **derived from the rows every time**, never stored. A stored
 * balance is a second source of truth that drifts the first time a share is
 * edited offline and merged later.
 */

export interface Share {
  driverId: string
  shareCents: number
}

/**
 * Split an amount evenly, to the cent.
 *
 * Somebody has to absorb the odd cent when a total does not divide. Which
 * person is arbitrary, so it rotates on the expense id: over a season of coffee
 * runs and entry fees nobody accumulates the rounding, and any single expense
 * is still deterministic — two devices splitting the same expense offline
 * produce identical shares and never conflict.
 */
export function splitEvenly(
  amountCents: number,
  driverIds: readonly string[],
  expenseId: string,
): Share[] {
  if (driverIds.length === 0) {
    throw new Error('cannot split an expense among no drivers')
  }

  const ids = [...driverIds].sort()
  const count = ids.length
  const base = Math.trunc(amountCents / count)
  let remainder = amountCents - base * count

  // Sorting makes the split independent of the order the roster arrived in;
  // the offset makes it independent of who happens to sort first.
  const offset = rotation(expenseId, count)
  const step = remainder >= 0 ? 1 : -1

  const shares = ids.map((driverId) => ({ driverId, shareCents: base }))
  for (let i = 0; remainder !== 0; i++) {
    const target = shares[(offset + i) % count]
    if (!target) break
    target.shareCents += step
    remainder -= step
  }

  return shares
}

/** A small stable hash of the expense id, so the rotation is reproducible. */
function rotation(expenseId: string, count: number): number {
  let hash = 0
  for (const char of expenseId) hash = (hash * 31 + char.charCodeAt(0)) % 100_000_007
  return hash % count
}

export type ShareValidation = { ok: true } | { ok: false; differenceCents: number; message: string }

/**
 * Check custom shares against the expense they belong to.
 *
 * Enforced here rather than by a database constraint so the error can name the
 * shortfall in the currency the person is typing in. "Shares are $5.00 short"
 * is actionable; a constraint violation is not.
 */
export function validateShares(amountCents: number, shares: readonly Share[]): ShareValidation {
  if (shares.length === 0) {
    return { ok: false, differenceCents: -amountCents, message: 'Nobody is sharing this expense.' }
  }

  const seen = new Set<string>()
  for (const share of shares) {
    if (seen.has(share.driverId)) {
      return {
        ok: false,
        differenceCents: 0,
        message: 'The same person appears twice in the split.',
      }
    }
    seen.add(share.driverId)
  }

  const total = shares.reduce((sum, s) => sum + s.shareCents, 0)
  const differenceCents = total - amountCents
  if (differenceCents === 0) return { ok: true }

  return {
    ok: false,
    differenceCents,
    message:
      differenceCents < 0
        ? `Shares are ${money(-differenceCents)} short of the expense.`
        : `Shares are ${money(differenceCents)} over the expense.`,
  }
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

export interface LedgerExpense {
  id: string
  /** Null when nobody recorded who actually paid. */
  payerDriverId: string | null
  amountCents: number
}

export interface LedgerShare {
  expenseId: string
  driverId: string
  shareCents: number
  settled: boolean
}

export interface Balance {
  driverId: string
  /** Positive means the team owes them; negative means they owe the team. */
  netCents: number
}

export interface Ledger {
  balances: Balance[]
  /** Already squared up. Kept visible — settled is not the same as deleted. */
  settledCents: number
  /** Paid by nobody in particular. Surfaced rather than silently absorbed. */
  unattributedCents: number
}

/**
 * Who is up and who is down, derived from expenses and shares.
 *
 * Balances always sum to zero once unattributed spending is accounted for,
 * which is the invariant worth checking: money that appears or vanishes means
 * a bug, not a rounding difference.
 */
export function buildLedger(
  expenses: readonly LedgerExpense[],
  shares: readonly LedgerShare[],
): Ledger {
  const net = new Map<string, number>()
  const bump = (driverId: string, cents: number) =>
    net.set(driverId, (net.get(driverId) ?? 0) + cents)

  let unattributedCents = 0
  for (const expense of expenses) {
    if (expense.payerDriverId === null) {
      unattributedCents += expense.amountCents
      continue
    }
    bump(expense.payerDriverId, expense.amountCents)
  }

  let settledCents = 0
  for (const share of shares) {
    if (share.settled) {
      settledCents += share.shareCents
      continue
    }
    bump(share.driverId, -share.shareCents)
  }

  const balances = [...net.entries()]
    .map(([driverId, netCents]) => ({ driverId, netCents }))
    .sort((a, b) => b.netCents - a.netCents || a.driverId.localeCompare(b.driverId))

  return { balances, settledCents, unattributedCents }
}

export interface Transfer {
  fromDriverId: string
  toDriverId: string
  amountCents: number
}

/**
 * The payments that clear the ledger.
 *
 * Greedy largest-debtor-to-largest-creditor. It is not provably minimal in
 * every case, but for a crew of two to four it always is, and "Cy pays Ana $40"
 * is what people actually want rather than a proof.
 */
export function settleUpTransfers(balances: readonly Balance[]): Transfer[] {
  const creditors = balances.filter((b) => b.netCents > 0).map((b) => ({ ...b }))
  const debtors = balances.filter((b) => b.netCents < 0).map((b) => ({ ...b }))

  creditors.sort((a, b) => b.netCents - a.netCents || a.driverId.localeCompare(b.driverId))
  debtors.sort((a, b) => a.netCents - b.netCents || a.driverId.localeCompare(b.driverId))

  const transfers: Transfer[] = []
  let c = 0
  let d = 0

  while (c < creditors.length && d < debtors.length) {
    const creditor = creditors[c]
    const debtor = debtors[d]
    if (!creditor || !debtor) break

    const amountCents = Math.min(creditor.netCents, -debtor.netCents)
    if (amountCents > 0) {
      transfers.push({ fromDriverId: debtor.driverId, toDriverId: creditor.driverId, amountCents })
      creditor.netCents -= amountCents
      debtor.netCents += amountCents
    }

    if (creditor.netCents === 0) c++
    if (debtor.netCents === 0) d++
  }

  return transfers
}
