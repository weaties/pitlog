/**
 * Expenses, splitting, and who owes whom — SPEC §5.3.
 *
 * Two things this screen refuses to do.
 *
 * It never blocks an expense on a photo. The receipt row syncs immediately with
 * `upload_state: pending` and a null `storage_key`; the image follows when
 * there is a network, or never. An expense is complete and splittable the
 * moment the amount is typed.
 *
 * It never silently rebalances a split. Change the amount after splitting and
 * the shares are shown as wrong, with the shortfall named, because quietly
 * adjusting what somebody agreed to owe is how a crew stops trusting the app.
 */

import { buildLedger, settleUpTransfers, splitEvenly, validateShares } from '@pitlog/domain'
import type { SyncRow } from '@pitlog/sync'
import { useState } from 'react'
import { useCurrentTeam } from '../lib/team.js'
import { useLocalTable, useRefreshLocal } from '../offline/useLocalTable.js'
import { useSync } from '../offline/useSync.js'
import { newId, saveRow } from '../offline/write.js'
import { Button, Card, Empty, Field, Input, Select, Toggle } from '../ui/controls.js'
import { Shell } from '../ui/Shell.js'

interface Expense {
  event_id: string | null
  payer_driver_id: string | null
  amount_cents: number
  currency: string
  category: string
  description: string
  spent_at: string
}
interface ExpenseShare {
  expense_id: string
  driver_id: string
  share_cents: number
  settled_at: string | null
}
interface Receipt {
  expense_id: string
  storage_key: string | null
  upload_state: string
  content_type: string | null
  byte_size: number | null
  sha256: string | null
  captured_at: string | null
}
interface Driver {
  first_name: string
}

const CATEGORIES = [
  'entry_fee',
  'fuel',
  'tires',
  'parts',
  'tools',
  'lodging',
  'travel',
  'food',
  'other',
]

export function MoneyPage() {
  const { teamId, userId, canWrite, isAdmin, loading } = useCurrentTeam()
  const sync = useSync(teamId)
  const expenses = useLocalTable<Expense>('expenses')
  const shares = useLocalTable<ExpenseShare>('expense_shares')
  const receipts = useLocalTable<Receipt>('receipts')
  const drivers = useLocalTable<Driver>('drivers')
  const refresh = useRefreshLocal()
  const [adding, setAdding] = useState(false)

  if (loading) return <Shell title="Money">Loading…</Shell>
  if (!teamId) return <Shell title="Money">You are not a member of any team yet.</Shell>

  const context = { teamId, userId }
  const roster = drivers.data ?? []
  const name = (id: string | null) => roster.find((d) => d.id === id)?.first_name ?? 'Unknown'

  const ledger = buildLedger(
    (expenses.data ?? []).map((e) => ({
      id: e.id,
      payerDriverId: e.payer_driver_id,
      amountCents: e.amount_cents,
    })),
    (shares.data ?? []).map((s) => ({
      expenseId: s.expense_id,
      driverId: s.driver_id,
      shareCents: s.share_cents,
      settled: s.settled_at !== null,
    })),
  )
  const transfers = settleUpTransfers(ledger.balances)

  const settle = async (fromId: string, toId: string) => {
    // Settling marks the shares square; it never deletes them. History is what
    // makes a ledger checkable.
    const owed = (shares.data ?? []).filter((s) => s.driver_id === fromId && s.settled_at === null)
    for (const share of owed) {
      await saveRow('expense_shares', { ...share, settled_at: new Date().toISOString() }, context)
    }
    refresh(['expense_shares'])
    void toId
  }

  return (
    <Shell
      title="Money"
      sync={sync}
      actions={
        canWrite ? (
          <Button tone="primary" onClick={() => setAdding(true)} data-testid="add-expense">
            Add
          </Button>
        ) : null
      }
    >
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">
          Who owes whom
        </h2>
        {transfers.length === 0 ? (
          <Empty>Everyone is square.</Empty>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="ledger">
            {transfers.map((t) => (
              <li key={`${t.fromDriverId}-${t.toDriverId}`}>
                <Card className="flex items-center justify-between gap-3">
                  <span className="text-lg">
                    {name(t.fromDriverId)} → {name(t.toDriverId)}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-lg tabular-nums">{money(t.amountCents)}</span>
                    {isAdmin && (
                      <Button
                        data-testid={`settle-${t.fromDriverId}`}
                        onClick={() => void settle(t.fromDriverId, t.toDriverId)}
                      >
                        Settle
                      </Button>
                    )}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {ledger.unattributedCents !== 0 && (
          <p className="text-pit-muted text-sm">
            {money(ledger.unattributedCents)} spent with no payer recorded — not in the balances
            above.
          </p>
        )}
      </section>

      {adding && (
        <ExpenseForm
          roster={roster}
          onCancel={() => setAdding(false)}
          onSave={async (draft) => {
            const expenseId = newId()
            await saveRow(
              'expenses',
              {
                id: expenseId,
                deleted_at: null,
                event_id: null,
                payer_driver_id: draft.payerDriverId,
                amount_cents: draft.amountCents,
                currency: 'USD',
                category: draft.category,
                description: draft.description,
                spent_at: new Date().toISOString(),
              } as unknown as SyncRow<Expense>,
              context,
            )

            for (const share of splitEvenly(draft.amountCents, draft.splitWith, expenseId)) {
              await saveRow(
                'expense_shares',
                {
                  id: newId(),
                  deleted_at: null,
                  expense_id: expenseId,
                  driver_id: share.driverId,
                  share_cents: share.shareCents,
                  settled_at: null,
                } as unknown as SyncRow<ExpenseShare>,
                context,
              )
            }

            if (draft.receipt) {
              // The row goes now; the blob follows. Object storage is still
              // undecided (SPEC §6.4), so `storage_key` stays null and the
              // upload state says exactly where this stands.
              await saveRow(
                'receipts',
                {
                  id: newId(),
                  deleted_at: null,
                  expense_id: expenseId,
                  storage_key: null,
                  upload_state: 'pending',
                  content_type: draft.receipt.type,
                  byte_size: draft.receipt.size,
                  sha256: draft.receipt.sha256,
                  captured_at: new Date().toISOString(),
                } as unknown as SyncRow<Receipt>,
                context,
              )
            }

            refresh(['expenses', 'expense_shares', 'receipts'])
            setAdding(false)
          }}
        />
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">Expenses</h2>
        {(expenses.data ?? []).length === 0 && <Empty>Nothing spent yet.</Empty>}
        <ul className="flex flex-col gap-2" data-testid="expenses">
          {[...(expenses.data ?? [])]
            .sort((a, b) => String(b.spent_at).localeCompare(String(a.spent_at)))
            .map((expense) => {
              const own = (shares.data ?? []).filter((s) => s.expense_id === expense.id)
              const check = validateShares(
                expense.amount_cents,
                own.map((s) => ({ driverId: s.driver_id, shareCents: s.share_cents })),
              )
              const receipt = (receipts.data ?? []).find((r) => r.expense_id === expense.id)

              return (
                <li key={expense.id}>
                  <Card className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-lg">{expense.description}</span>
                      <span className="text-lg tabular-nums">{money(expense.amount_cents)}</span>
                    </div>
                    <p className="text-pit-muted text-sm">
                      {expense.category.replace('_', ' ')} · paid by {name(expense.payer_driver_id)}
                      {own.length > 0 && ` · split ${own.length} ways`}
                    </p>
                    {receipt && (
                      <p className="text-pit-muted text-sm" data-testid="receipt-state">
                        Receipt{' '}
                        {receipt.upload_state === 'pending'
                          ? 'waiting to upload'
                          : receipt.upload_state}
                      </p>
                    )}
                    {!check.ok && own.length > 0 && (
                      <p className="text-amber-300 text-sm" data-testid="split-mismatch">
                        {check.message}
                      </p>
                    )}
                  </Card>
                </li>
              )
            })}
        </ul>
      </section>
    </Shell>
  )
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

interface Draft {
  description: string
  amountCents: number
  category: string
  payerDriverId: string | null
  splitWith: string[]
  receipt: { type: string; size: number; sha256: string } | null
}

function ExpenseForm({
  roster,
  onCancel,
  onSave,
}: {
  roster: SyncRow<Driver>[]
  onCancel: () => void
  onSave: (draft: Draft) => Promise<void>
}) {
  const [description, setDescription] = useState('')
  const [dollars, setDollars] = useState('')
  const [category, setCategory] = useState('other')
  // Same shape of bug as the split below, and worse in its consequence: a
  // payer captured from an empty roster stays empty, and the expense is
  // silently recorded as paid by nobody.
  const [chosenPayer, setChosenPayer] = useState<string | null>(null)
  const payer = chosenPayer ?? roster[0]?.id ?? ''
  // Null means "nobody has chosen yet", which resolves to everyone. Capturing
  // the roster into state at mount looked equivalent and was not: open this
  // form before the local read finishes and the default was an empty split,
  // leaving Save disabled with no way to recover.
  const [chosen, setChosen] = useState<string[] | null>(null)
  const splitWith = chosen ?? roster.map((d) => d.id)
  const [receipt, setReceipt] = useState<Draft['receipt']>(null)
  const [hashing, setHashing] = useState(false)

  const amountCents = Math.round(Number(dollars) * 100)
  const valid = description.trim() !== '' && Number.isFinite(amountCents) && amountCents !== 0

  const capture = async (file: File) => {
    setHashing(true)
    // sha256 is recorded so a re-upload is idempotent — the same photo sent
    // twice must not become two receipts.
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    setReceipt({ type: file.type, size: file.size, sha256 })
    setHashing(false)
  }

  return (
    <Card className="flex flex-col gap-4" data-testid="expense-form">
      <Field label="What was it?">
        {(id) => (
          <Input
            id={id}
            value={description}
            autoFocus
            onChange={(e) => setDescription(e.target.value)}
            data-testid="expense-description"
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount ($)">
          {(id) => (
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              step="0.01"
              value={dollars}
              onChange={(e) => setDollars(e.target.value)}
              data-testid="expense-amount"
            />
          )}
        </Field>
        <Field label="Category">
          {(id) => (
            <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace('_', ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field label="Who paid?">
        {(id) => (
          <Select
            id={id}
            value={payer}
            onChange={(e) => setChosenPayer(e.target.value)}
            data-testid="expense-payer"
          >
            {roster.map((d) => (
              <option key={d.id} value={d.id}>
                {d.first_name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className="flex flex-col gap-2">
        <span className="font-medium text-pit-muted text-sm">Split between</span>
        {roster.map((driver) => (
          <Toggle
            key={driver.id}
            label={driver.first_name}
            checked={splitWith.includes(driver.id)}
            onChange={(on) =>
              setChosen(on ? [...splitWith, driver.id] : splitWith.filter((id) => id !== driver.id))
            }
          />
        ))}
      </div>

      <Field label="Receipt photo" hint="Optional, and never blocks the expense.">
        {(id) => (
          <input
            id={id}
            type="file"
            accept="image/*"
            capture="environment"
            data-testid="expense-receipt"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void capture(file)
            }}
            className="min-h-tap rounded-xl border border-white/10 bg-pit-surface px-4 py-3 text-pit-fg"
          />
        )}
      </Field>
      {receipt && (
        <p className="text-pit-muted text-sm" data-testid="receipt-captured">
          Receipt captured · {Math.round(receipt.size / 1024)} KB · will upload when online
        </p>
      )}

      <div className="flex gap-2">
        <Button
          tone="primary"
          className="flex-1"
          disabled={!valid || splitWith.length === 0 || hashing}
          data-testid="save-expense"
          onClick={() =>
            void onSave({
              description: description.trim(),
              amountCents,
              category,
              payerDriverId: payer || null,
              splitWith,
              receipt,
            })
          }
        >
          Save
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}
