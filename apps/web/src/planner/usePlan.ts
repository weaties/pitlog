/**
 * Turning what is on the device into a plan.
 *
 * All the thinking is in `@pitlog/domain`; this only assembles its inputs from
 * IndexedDB and picks between planning from the grid and re-solving from now.
 * The split is deliberate: the solver has no idea a browser exists, and this
 * file has no idea how a stint schedule is chosen.
 */

import type {
  ActualStint,
  BurnRateEstimate,
  PitNowComparison,
  PlannerDriver,
  SeriesRulesConfig,
  StintPlanResult,
} from '@pitlog/domain'
import {
  estimateBurnRate,
  evaluatePitNow,
  inRunningOrder,
  parseSeriesRules,
  replanFromNow,
  solveStintPlan,
} from '@pitlog/domain'
import type { SyncRow } from '@pitlog/sync'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.js'
import { readMeta, writeMeta } from '../offline/idb.js'
import { useLocalTable } from '../offline/useLocalTable.js'

const RULES_KEY = 'rules.active'

interface ActiveRule {
  id: string
  series_id: string
  series_key: string
  series_name: string
  verification_status: string
  config: unknown
}

/**
 * Rule configs, kept on the device.
 *
 * Fetched when there is a network and cached in IndexedDB, because a plan made
 * with no signal must still be able to say which of its inputs are guesses —
 * which is the whole point of the banner.
 */
export function useRules(teamId: string | undefined) {
  return useQuery({
    queryKey: ['rules', teamId],
    enabled: Boolean(teamId),
    networkMode: 'always',
    queryFn: async (): Promise<ActiveRule[]> => {
      try {
        const response = await api<{ rules: ActiveRule[] }>(`/api/teams/${teamId}/rules`)
        await writeMeta(RULES_KEY, response.rules)
        return response.rules
      } catch {
        return (await readMeta<ActiveRule[]>(RULES_KEY)) ?? []
      }
    },
  })
}

interface EventRow {
  name: string
  fuel_capacity_gallons: string | null
  burn_rate_gph: string | null
  series_id: string | null
}
interface SessionRow {
  event_id: string
  name: string
  scheduled_duration_seconds: number | null
  starts_at: string | null
}
interface DriverRow {
  first_name: string
  can_drive: boolean
  sort_order: number | null
  min_stint_seconds: number | null
  max_stint_seconds: number | null
  burn_rate_factor: string | null
}
interface StintRow {
  session_id: string
  driver_id: string | null
  sequence: number
  started_at: string | null
  ended_at: string | null
}
interface FillRow {
  session_id: string
  gallons: string
  filled_at: string
  filled_to_full: boolean
}

export interface PlanView {
  ready: boolean
  /** Why a plan could not be attempted at all, in plain words. */
  blocker: string | null
  event: SyncRow<EventRow> | undefined
  session: SyncRow<SessionRow> | undefined
  drivers: SyncRow<DriverRow>[]
  burnRate: BurnRateEstimate | null
  rules: SeriesRulesConfig | null
  result: StintPlanResult | null
  /** True when the plan was re-solved from now rather than from the grid. */
  live: boolean
  elapsedSeconds: number
  pitNow: PitNowComparison | null
  driverName: (id: string | null) => string
}

/** Not yet a stored field; two gallons is the conservative default. */
const RESERVE_GALLONS = 2
/** Modelled stationary time per stop until a team records their own. */
const DEFAULT_PIT_SECONDS = 300

export function usePlan(teamId: string | undefined): PlanView {
  const events = useLocalTable<EventRow>('events')
  const sessions = useLocalTable<SessionRow>('sessions')
  const drivers = useLocalTable<DriverRow>('drivers')
  const stints = useLocalTable<StintRow>('stints')
  const fills = useLocalTable<FillRow>('fuel_fills')
  const rules = useRules(teamId)

  const event = (events.data ?? [])[0]
  const session = (sessions.data ?? []).find((s) => s.event_id === event?.id)
  // Ordered here, once. The solver's last tiebreak is roster order, and
  // handing it IndexedDB key order would make it arbitrary — see #56.
  const roster = inRunningOrder((drivers.data ?? []).filter((d) => d.can_drive))

  const driverName = (id: string | null) =>
    (drivers.data ?? []).find((d) => d.id === id)?.first_name ?? 'Unknown'

  const empty: PlanView = {
    ready: false,
    blocker: null,
    event,
    session,
    drivers: roster,
    burnRate: null,
    rules: null,
    result: null,
    live: false,
    elapsedSeconds: 0,
    pitNow: null,
    driverName,
  }

  if (!event) return { ...empty, blocker: 'Add a race first.' }
  if (!session?.scheduled_duration_seconds) {
    return { ...empty, blocker: 'Add a session with a length to plan against.' }
  }
  if (roster.length === 0) return { ...empty, blocker: 'Add at least one driver who can drive.' }

  const capacity = Number(event.fuel_capacity_gallons ?? 0)
  if (!(capacity > 0)) return { ...empty, blocker: 'Set the fuel capacity on the race.' }

  const sessionStints = (stints.data ?? []).filter((s) => s.session_id === session.id)
  const sessionFills = (fills.data ?? []).filter((f) => f.session_id === session.id)
  const sessionStart = session.starts_at ? new Date(session.starts_at) : null

  const burnRate = estimateBurnRate({
    stints: sessionStints
      .filter((s) => s.started_at !== null)
      .map((s) => ({
        id: s.id,
        driverId: s.driver_id,
        startedAt: new Date(s.started_at as string),
        endedAt: s.ended_at ? new Date(s.ended_at) : null,
      })),
    fills: sessionFills.map((f) => ({
      id: f.id,
      filledAt: new Date(f.filled_at),
      gallons: Number(f.gallons),
      filledToFull: f.filled_to_full,
    })),
    knownFullAt: sessionStart,
    seedGph: event.burn_rate_gph ? Number(event.burn_rate_gph) : null,
  })

  if (!burnRate) {
    return { ...empty, blocker: 'Set a seed burn rate on the race, or log a full-tank fill.' }
  }

  const config = activeConfig(rules.data ?? [], event.series_id)

  const plannerDrivers: PlannerDriver[] = roster.map((d) => ({
    id: d.id,
    canDrive: true,
    minStintSeconds: d.min_stint_seconds,
    maxStintSeconds: d.max_stint_seconds,
    burnRateFactor: d.burn_rate_factor ? Number(d.burn_rate_factor) : 1,
  }))

  const input = {
    raceSeconds: session.scheduled_duration_seconds,
    fuelCapacityGallons: capacity,
    reserveGallons: Math.min(RESERVE_GALLONS, capacity / 2),
    pitStopSeconds: DEFAULT_PIT_SECONDS,
    burnRate,
    drivers: plannerDrivers,
    rules: config,
  }

  // A stint that has actually run is what makes this a live replan rather than
  // a plan from the grid.
  const actuals: ActualStint[] = sessionStints
    .filter((s) => s.started_at !== null || s.ended_at !== null)
    .map((s) => ({
      driverId: s.driver_id ?? '',
      startOffsetSeconds: offset(s.started_at, sessionStart),
      endOffsetSeconds: s.ended_at ? offset(s.ended_at, sessionStart) : null,
    }))

  const live = actuals.length > 0 && sessionStart !== null
  const elapsedSeconds = live
    ? Math.max(0, Math.floor((Date.now() - (sessionStart?.getTime() ?? 0)) / 1000))
    : 0

  // Fuel state is not yet tracked continuously, so a replan assumes the tank
  // was brimmed at the last stop. Stated on screen rather than assumed silently.
  const fuelNow = capacity

  const result = live
    ? replanFromNow(input, { elapsedSeconds, stints: actuals, fuelGallons: fuelNow })
    : solveStintPlan(input)

  const pitNow = live
    ? evaluatePitNow(input, { elapsedSeconds, stints: actuals, fuelGallons: fuelNow })
    : null

  return {
    ready: true,
    blocker: null,
    event,
    session,
    drivers: roster,
    burnRate,
    rules: config,
    result,
    live,
    elapsedSeconds,
    pitNow,
    driverName,
  }
}

function offset(at: string | null, start: Date | null): number {
  if (!at || !start) return 0
  return Math.max(0, Math.floor((new Date(at).getTime() - start.getTime()) / 1000))
}

/**
 * The rule config for this race, or null.
 *
 * Null when the event names no series. It deliberately does NOT fall back to
 * whichever config happens to come back first: the three shipped series differ
 * in ways that change a schedule — a ChampCar driver change may overlap
 * fuelling and a Lemons one may not — so guessing would produce a plan that
 * looks authoritative and is bound by the wrong rulebook. The plan says "no
 * series rules applied" instead, which is true and visible.
 */
function activeConfig(rules: ActiveRule[], seriesId: string | null): SeriesRulesConfig | null {
  if (!seriesId) return null
  const match = rules.find((r) => r.series_id === seriesId)
  if (!match) return null
  try {
    return parseSeriesRules(match.config)
  } catch {
    // A config the server accepted but this build cannot parse is version
    // skew, not a crash: plan without it, and the missing-config assumption
    // will say so on screen.
    return null
  }
}
