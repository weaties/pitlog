/**
 * Who the caller is and which team they are looking at.
 *
 * Held in one place because every write needs both: the team for the tenancy
 * column, the user for attribution and for breaking merge ties.
 */

import { useQuery } from '@tanstack/react-query'
import type { Team } from './api.js'
import { api } from './api.js'

export interface Me {
  userId: string
  kind: 'user' | 'visitor'
}

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me'), retry: false })
}

export function useTeams() {
  return useQuery({ queryKey: ['teams'], queryFn: () => api<{ teams: Team[] }>('/api/teams') })
}

/** The team in play. One team per crew in M1; multi-team is M4. */
export function useCurrentTeam() {
  const teams = useTeams()
  const me = useMe()
  const team = teams.data?.teams[0]

  return {
    team,
    teamId: team?.id,
    role: team?.role,
    userId: me.data?.userId ?? null,
    isAdmin: team?.role === 'admin',
    canWrite: team?.role === 'admin' || team?.role === 'crew',
    loading: teams.isPending || me.isPending,
  }
}
