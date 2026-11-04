import { useQuery, useQueryClient } from '@tanstack/react-query'
import { compareSessionSummaries } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { mergeSessionSummarySnapshot } from '@/lib/sessionSnapshot'

export type UseSessionsOptions = {
    enabled?: boolean
}

export function useSessions(api: ApiClient | null, options: UseSessionsOptions = {}): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const response = await api.getSessions()
            // SSE may have delivered newer input while this GET was in flight.
            // Retain its monotonic ordering clock, not deleted rows or stale data.
            const current = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions)
            const cached = new Map(current?.sessions.map(s => [s.id, s]))
            let needsRefetch = false
            const result = {
                ...response,
                sessions: response.sessions.map(session => {
                    const merged = mergeSessionSummarySnapshot(cached.get(session.id), session)
                    needsRefetch ||= merged.needsRefetch
                    return merged.summary
                }).sort(compareSessionSummaries)
            }
            if (needsRefetch) {
                // Let this GET settle before recovering a crossed SSE/REST snapshot.
                setTimeout(() => { void queryClient.invalidateQueries({ queryKey: queryKeys.sessions }) }, 0)
            }
            return result
        },
        enabled: Boolean(api) && (options.enabled ?? true),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
