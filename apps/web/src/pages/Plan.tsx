/**
 * The pit-wall view of the plan — SPEC §5.1, #7 and #10.
 *
 * The rule that governs this screen is SPEC §5.1's: **never a bare number.**
 * Every shipped rule config is UNVERIFIED (SPEC §3), so a schedule here is
 * structurally correct and factually unconfirmed, and it has to say so on the
 * plan itself rather than behind a tooltip or an info page. A placeholder
 * minimum-stop time read as a rule is how a team gets penalised.
 *
 * The banner is therefore not decoration and not dismissible. It disappears on
 * its own the day somebody reads a rulebook and marks the config VERIFIED.
 */

import type { PitNowComparison, StintPlan } from '@pitlog/domain'
import { unverifiedFields } from '@pitlog/domain'
import { useCurrentTeam } from '../lib/team.js'
import { useSync } from '../offline/useSync.js'
import type { PlanView } from '../planner/usePlan.js'
import { usePlan } from '../planner/usePlan.js'
import { Card, Empty } from '../ui/controls.js'
import { Shell } from '../ui/Shell.js'

export function PlanPage() {
  const { teamId, loading } = useCurrentTeam()
  const sync = useSync(teamId)
  const plan = usePlan(teamId)

  if (loading) return <Shell title="Plan">Loading…</Shell>
  if (!teamId) return <Shell title="Plan">You are not a member of any team yet.</Shell>

  return (
    <Shell title="Plan" sync={sync}>
      {plan.blocker && <Empty>{plan.blocker}</Empty>}

      {plan.result && !plan.result.ok && (
        <Card className="border-amber-400/40 bg-amber-400/10" data-testid="plan-refused">
          <p className="font-semibold text-amber-200">No legal plan</p>
          <p className="mt-1 text-pit-fg">{plan.result.detail}</p>
          <p className="mt-2 text-pit-muted text-sm">
            The planner refuses rather than showing a schedule that breaks a limit — a plan that
            looks like an answer is worse than none.
          </p>
        </Card>
      )}

      {plan.result?.ok && (
        <>
          <UnverifiedBanner plan={plan} />
          {plan.pitNow && <PitNowCard comparison={plan.pitNow} />}
          <Schedule plan={plan.result.plan} view={plan} />
          <Assumptions plan={plan.result.plan} view={plan} />
        </>
      )}
    </Shell>
  )
}

/**
 * What in this plan is a guess.
 *
 * Lists the fields rather than saying "some values are unverified", because a
 * crew chief can act on "the minimum stop time is a placeholder" and cannot act
 * on a vague warning.
 */
function UnverifiedBanner({ plan }: { plan: PlanView }) {
  if (!plan.rules) {
    return (
      <Card className="border-amber-400/40 bg-amber-400/10" data-testid="unverified-banner">
        <p className="font-semibold text-amber-200">No series rules applied</p>
        <p className="mt-1 text-pit-fg text-sm">
          This schedule is bound only by the tank, the roster, and the pit time entered by hand.
          Nothing here checks a series rulebook.
        </p>
      </Card>
    )
  }

  const unverified = unverifiedFields(plan.rules)
  if (unverified.length === 0) return null

  return (
    <Card className="border-amber-400/40 bg-amber-400/10" data-testid="unverified-banner">
      <p className="font-semibold text-amber-200">
        Built on {unverified.length} unverified rule value
        {unverified.length === 1 ? '' : 's'}
      </p>
      <p className="mt-1 text-pit-fg text-sm">
        {plan.rules.display_name} rules have not been checked against a rulebook. These inputs are
        placeholders, not rules:
      </p>
      <ul className="mt-2 flex flex-wrap gap-1" data-testid="unverified-fields">
        {unverified.map((field) => (
          <li
            key={field}
            className="rounded bg-black/25 px-2 py-0.5 font-mono text-amber-100 text-xs"
          >
            {field}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** The yellow-flag answer, legible in about three seconds. */
function PitNowCard({ comparison }: { comparison: PitNowComparison }) {
  const { verdict, delta } = comparison

  const copy: Record<string, { title: string; tone: string }> = {
    free: { title: 'Pitting now is free', tone: 'border-emerald-400/40 bg-emerald-400/10' },
    saves_a_stop: {
      title: 'Pitting now saves a stop',
      tone: 'border-emerald-400/40 bg-emerald-400/10',
    },
    costs_a_stop: { title: 'Pitting now costs a stop', tone: 'border-white/10 bg-pit-surface' },
    forced: { title: 'You have to pit', tone: 'border-amber-400/40 bg-amber-400/10' },
    unsolvable: {
      title: 'Pitting now leaves no legal plan',
      tone: 'border-red-400/40 bg-red-400/10',
    },
    no_plan: { title: 'No legal plan either way', tone: 'border-red-400/40 bg-red-400/10' },
  }
  const shown = copy[verdict] ?? copy.costs_a_stop

  return (
    <Card className={shown?.tone ?? ''} data-testid="pit-now">
      <p className="font-semibold text-lg" data-testid="pit-now-verdict">
        {shown?.title}
      </p>
      {delta && (
        <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
          <Stat
            label="Stops"
            value={
              delta.stopCountDelta > 0 ? `+${delta.stopCountDelta}` : String(delta.stopCountDelta)
            }
          />
          <Stat label="Running lost" value={duration(delta.stintCutShortSeconds)} />
          <Stat label="Fuel aboard" value={`${delta.fuelAtStopGallons.toFixed(1)} gal`} />
        </dl>
      )}
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-pit-muted text-xs">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

function Schedule({ plan, view }: { plan: StintPlan; view: PlanView }) {
  const start = view.session?.starts_at ? new Date(view.session.starts_at) : null

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">
        {view.live ? 'Remaining stints' : 'Stint schedule'} · {plan.stopCount} stop
        {plan.stopCount === 1 ? '' : 's'}
      </h2>

      <ul className="flex flex-col gap-2" data-testid="schedule">
        {plan.stints.map((stint) => {
          const fill = plan.fills.find((f) => f.afterStintSequence === stint.sequence)
          return (
            <li key={stint.sequence}>
              <Card className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-lg">
                    <span className="text-pit-muted tabular-nums">{stint.sequence}.</span>{' '}
                    {view.driverName(stint.driverId)}
                  </p>
                  <p className="text-pit-muted text-sm tabular-nums">
                    {clock(stint.startOffsetSeconds, start)} →{' '}
                    {clock(stint.endOffsetSeconds, start)}
                    {' · '}
                    {duration(stint.endOffsetSeconds - stint.startOffsetSeconds)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="tabular-nums">
                    {stint.fuelAtStartGallons} → {stint.fuelAtEndGallons} gal
                  </p>
                  {fill && (
                    <p className="text-pit-accent text-sm tabular-nums">+{fill.gallons} gal</p>
                  )}
                </div>
              </Card>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * The inputs behind the schedule.
 *
 * SPEC §5.1 asks for confidence and assumptions rather than a bare number, and
 * the burn-rate model already returns both — this only renders what it said.
 */
function Assumptions({ plan, view }: { plan: StintPlan; view: PlanView }) {
  const seat = Object.entries(plan.seatTimeSecondsByDriver)

  return (
    <section className="flex flex-col gap-3" data-testid="assumptions">
      <h2 className="font-semibold text-pit-muted text-sm uppercase tracking-wide">Assumptions</h2>

      <Card className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-pit-muted text-sm">Burn rate</span>
          <span className="text-lg tabular-nums" data-testid="burn-rate">
            {plan.burnRate.gph.toFixed(1)} gal/h
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-pit-muted text-sm">Confidence</span>
          <span data-testid="burn-confidence">
            {plan.burnRate.confidence} · {plan.burnRate.method}
            {plan.burnRate.sampleCount > 0 && ` · ${plan.burnRate.sampleCount} fills`}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-pit-muted text-sm">Seat time</span>
          <span className="tabular-nums">
            {seat.map(([id]) => view.driverName(id)).join(' · ')}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-pit-muted text-sm">Spread</span>
          <span className="tabular-nums">{duration(plan.seatTimeSpreadSeconds)}</span>
        </div>
      </Card>

      <ul className="flex flex-col gap-2">
        {plan.assumptions.map((assumption) => (
          <li
            key={assumption.code}
            className="rounded-lg border border-white/10 bg-pit-surface px-3 py-2 text-sm"
          >
            {assumption.detail}
          </li>
        ))}
      </ul>

      <p className="text-pit-muted text-xs">
        Fuel state on a live replan assumes the tank was brimmed at the last stop.
      </p>
    </section>
  )
}

function duration(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

function clock(offsetSeconds: number, start: Date | null): string {
  if (!start) return `+${duration(offsetSeconds)}`
  return new Date(start.getTime() + offsetSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}
