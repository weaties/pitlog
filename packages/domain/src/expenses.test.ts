import { describe, expect, it } from 'vitest'
import type { LedgerExpense, LedgerShare } from './expenses.js'
import { buildLedger, settleUpTransfers, splitEvenly, validateShares } from './expenses.js'

const ANA = 'aaaa'
const BO = 'bbbb'
const CY = 'cccc'

describe('splitEvenly', () => {
  it('divides a clean amount exactly', () => {
    expect(splitEvenly(9000, [ANA, BO, CY], 'e1')).toEqual([
      { driverId: ANA, shareCents: 3000 },
      { driverId: BO, shareCents: 3000 },
      { driverId: CY, shareCents: 3000 },
    ])
  })

  it('always sums to the parent expense, to the cent', () => {
    // 100 cents over 3 people cannot divide. Someone absorbs the odd cent, and
    // the total is what must not move.
    for (const amount of [100, 101, 9607, 1, 2, 33_333]) {
      const shares = splitEvenly(amount, [ANA, BO, CY], 'e1')
      expect(shares.reduce((sum, s) => sum + s.shareCents, 0)).toBe(amount)
    }
  })

  it('never differs by more than a cent between people', () => {
    const shares = splitEvenly(101, [ANA, BO, CY], 'e1')
    const values = shares.map((s) => s.shareCents)
    expect(Math.max(...values) - Math.min(...values)).toBe(1)
  })

  it('is deterministic — the same expense splits the same way every time', () => {
    expect(splitEvenly(101, [ANA, BO, CY], 'e1')).toEqual(splitEvenly(101, [ANA, BO, CY], 'e1'))
  })

  it('does not always hand the odd cent to the same person', () => {
    // Rotating on the expense id keeps a systematic bias from building up over
    // a season of coffee runs. Whoever it lands on, it is one cent.
    const absorbers = new Set(
      ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((id) => {
        const shares = splitEvenly(100, [ANA, BO, CY], id)
        const most = Math.max(...shares.map((s) => s.shareCents))
        return shares.find((s) => s.shareCents === most)?.driverId
      }),
    )
    expect(absorbers.size).toBeGreaterThan(1)
  })

  it('does not care what order the drivers arrive in', () => {
    const forward = splitEvenly(100, [ANA, BO, CY], 'e1')
    const reversed = splitEvenly(100, [CY, BO, ANA], 'e1')
    const asMap = (s: typeof forward) =>
      Object.fromEntries(s.map((x) => [x.driverId, x.shareCents]))
    expect(asMap(reversed)).toEqual(asMap(forward))
  })

  it('refuses to split among nobody', () => {
    expect(() => splitEvenly(100, [], 'e1')).toThrow(/driver/i)
  })

  it('handles a refund, where the amount is negative', () => {
    const shares = splitEvenly(-900, [ANA, BO, CY], 'e1')
    expect(shares.reduce((sum, s) => sum + s.shareCents, 0)).toBe(-900)
  })
})

describe('validateShares', () => {
  it('accepts shares that sum to the expense', () => {
    const result = validateShares(9000, [
      { driverId: ANA, shareCents: 4000 },
      { driverId: BO, shareCents: 5000 },
    ])
    expect(result.ok).toBe(true)
  })

  it('names the shortfall rather than raising a constraint violation', () => {
    // The error has to be legible to whoever is typing, not to a DBA.
    const result = validateShares(9000, [
      { driverId: ANA, shareCents: 4000 },
      { driverId: BO, shareCents: 4500 },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.differenceCents).toBe(-500)
    expect(result.message).toMatch(/5\.00/)
    expect(result.message).toMatch(/short/i)
  })

  it('names an overshoot too', () => {
    const result = validateShares(9000, [{ driverId: ANA, shareCents: 9500 }])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.differenceCents).toBe(500)
    expect(result.message).toMatch(/over/i)
  })

  it('rejects a split with nobody in it', () => {
    const result = validateShares(9000, [])
    expect(result.ok).toBe(false)
  })

  it('rejects the same driver appearing twice', () => {
    const result = validateShares(9000, [
      { driverId: ANA, shareCents: 4500 },
      { driverId: ANA, shareCents: 4500 },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toMatch(/twice|duplicate/i)
  })
})

describe('buildLedger', () => {
  const expenses: LedgerExpense[] = [
    { id: 'e1', payerDriverId: ANA, amountCents: 9000 },
    { id: 'e2', payerDriverId: BO, amountCents: 3000 },
  ]
  const shares: LedgerShare[] = [
    { expenseId: 'e1', driverId: ANA, shareCents: 3000, settled: false },
    { expenseId: 'e1', driverId: BO, shareCents: 3000, settled: false },
    { expenseId: 'e1', driverId: CY, shareCents: 3000, settled: false },
    { expenseId: 'e2', driverId: ANA, shareCents: 1000, settled: false },
    { expenseId: 'e2', driverId: BO, shareCents: 1000, settled: false },
    { expenseId: 'e2', driverId: CY, shareCents: 1000, settled: false },
  ]

  it('is derived from the rows, so it cannot drift', () => {
    const ledger = buildLedger(expenses, shares)

    // Ana paid 9000 and owes 4000; Bo paid 3000 and owes 4000; Cy paid nothing.
    expect(ledger.balances).toEqual([
      { driverId: ANA, netCents: 5000 },
      { driverId: BO, netCents: -1000 },
      { driverId: CY, netCents: -4000 },
    ])
  })

  it('always nets to zero — money does not appear or vanish', () => {
    const ledger = buildLedger(expenses, shares)
    expect(ledger.balances.reduce((sum, b) => sum + b.netCents, 0)).toBe(0)
  })

  it('leaves settled shares out of what is owed but keeps them in the history', () => {
    const settled = shares.map((s) =>
      s.expenseId === 'e1' && s.driverId === CY ? { ...s, settled: true } : s,
    )
    const ledger = buildLedger(expenses, settled)

    const cy = ledger.balances.find((b) => b.driverId === CY)
    expect(cy?.netCents).toBe(-1000)
    expect(ledger.settledCents).toBe(3000)
  })

  it('counts a payer who is not in the split', () => {
    // The team bought tyres; only the drivers who used them share the cost.
    const ledger = buildLedger(
      [{ id: 'e3', payerDriverId: ANA, amountCents: 6000 }],
      [
        { expenseId: 'e3', driverId: BO, shareCents: 3000, settled: false },
        { expenseId: 'e3', driverId: CY, shareCents: 3000, settled: false },
      ],
    )

    expect(ledger.balances.find((b) => b.driverId === ANA)?.netCents).toBe(6000)
  })

  it('ignores an expense with no payer rather than losing the money', () => {
    const ledger = buildLedger(
      [{ id: 'e4', payerDriverId: null, amountCents: 5000 }],
      [{ expenseId: 'e4', driverId: BO, shareCents: 5000, settled: false }],
    )

    expect(ledger.unattributedCents).toBe(5000)
    expect(ledger.balances.reduce((sum, b) => sum + b.netCents, 0)).toBe(-5000)
  })
})

describe('settleUpTransfers', () => {
  it('turns balances into the fewest payments that clear them', () => {
    const transfers = settleUpTransfers([
      { driverId: ANA, netCents: 5000 },
      { driverId: BO, netCents: -1000 },
      { driverId: CY, netCents: -4000 },
    ])

    expect(transfers).toEqual([
      { fromDriverId: CY, toDriverId: ANA, amountCents: 4000 },
      { fromDriverId: BO, toDriverId: ANA, amountCents: 1000 },
    ])
  })

  it('says nothing when everyone is square', () => {
    expect(settleUpTransfers([{ driverId: ANA, netCents: 0 }])).toEqual([])
  })

  it('clears every balance it is given', () => {
    const balances = [
      { driverId: ANA, netCents: 7333 },
      { driverId: BO, netCents: -2111 },
      { driverId: CY, netCents: -5222 },
    ]
    const transfers = settleUpTransfers(balances)

    const applied = new Map(balances.map((b) => [b.driverId, b.netCents]))
    for (const t of transfers) {
      applied.set(t.fromDriverId, (applied.get(t.fromDriverId) ?? 0) + t.amountCents)
      applied.set(t.toDriverId, (applied.get(t.toDriverId) ?? 0) - t.amountCents)
    }
    for (const value of applied.values()) expect(value).toBe(0)
  })

  it('never invents a payment to or from somebody who is square', () => {
    const transfers = settleUpTransfers([
      { driverId: ANA, netCents: 1000 },
      { driverId: BO, netCents: -1000 },
      { driverId: CY, netCents: 0 },
    ])
    expect(transfers.every((t) => t.fromDriverId !== CY && t.toDriverId !== CY)).toBe(true)
  })
})
