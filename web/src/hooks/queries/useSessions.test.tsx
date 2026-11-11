import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { SessionsResponse, SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from './useSessions'

afterEach(cleanup)

function row(id: string, at: number): SessionSummary {
    return {
        id, createdAt: 1, lastUserMessageAt: at, updatedAt: at,
        active: false, thinking: false, activeAt: 0, metadata: null,
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0,
        todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [],
        backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null,
        attachedJob: null, attachedJobUpdatedAt: 0,
        model: null, effort: null
    }
}

it('does not let a delayed REST snapshot undo newer user input from SSE', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const initial = { sessions: [row('b', 200), row('a', 100), row('removed', 50)] }
    client.setQueryData(queryKeys.sessions, initial)
    let resolve!: (response: SessionsResponse) => void
    const getSessions = vi.fn(() => new Promise<SessionsResponse>(done => { resolve = done }))
    const api = { getSessions } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        const pending = result.current.refetch()
        client.setQueryData(queryKeys.sessions, { sessions: [row('a', 300), row('b', 200), row('removed', 50)] })
        resolve({ sessions: [row('b', 200), row('a', 100)] })
        await pending
    })
    const data = client.getQueryData<SessionsResponse>(queryKeys.sessions)!
    expect(data.sessions.map(s => s.id)).toEqual(['a', 'b'])
    expect(data.sessions[0]!.lastUserMessageAt).toBe(300)
})

it('keeps cleared attention when an older GET arrives after the user has spoken', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let resolve!: (response: SessionsResponse) => void
    const api = { getSessions: () => new Promise<SessionsResponse>(done => { resolve = done }) } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        const pending = result.current.refetch()
        client.setQueryData(queryKeys.sessions, { sessions: [row('a', 2_000)] })
        resolve({ sessions: [{ ...row('a', 500), pendingRequestsCount: 11, pendingRequestKinds: ['permission'],
            pendingRequests: [{ id: 'old', kind: 'permission', tool: 'Bash', since: 1_000 }] }] })
        await pending
    })
    await waitFor(() => expect(result.current.sessions[0]?.lastUserMessageAt).toBe(2_000))
    expect(result.current.sessions[0]!.pendingRequestsCount).toBe(0)
    expect(result.current.sessions[0]!.pendingRequestKinds).toEqual([])
    expect(result.current.sessions[0]!.pendingRequests).toEqual([])
})

it('recovers crossed state and user-clock snapshots with one fresh GET', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let resolve!: (response: SessionsResponse) => void
    const coherent = { ...row('a', 2_000), agentStateVersion: 3 }
    const getSessions = vi.fn()
        .mockImplementationOnce(() => new Promise<SessionsResponse>(done => { resolve = done }))
        .mockResolvedValue({ sessions: [coherent] })
    const api = { getSessions } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api), { wrapper })
    await act(async () => {
        client.setQueryData(queryKeys.sessions, { sessions: [{ ...row('a', 1_000), agentStateVersion: 3,
            pendingRequestsCount: 1, pendingRequestKinds: ['permission'],
            pendingRequests: [{ id: 'old', kind: 'permission', tool: 'Bash', since: 1_500 }] }] })
        resolve({ sessions: [{ ...row('a', 2_000), agentStateVersion: 2 }] })
    })
    await waitFor(() => expect(getSessions).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.sessions[0]?.pendingRequestsCount).toBe(0))
    expect(result.current.sessions[0]!.lastUserMessageAt).toBe(2_000)
    expect(result.current.sessions[0]!.agentStateVersion).toBe(3)
})

it.each([false, true])('keeps newer attached-job state alongside a newer user clock through a delayed GET (cleared=%s)', async (cleared) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const job = {
        key: 'import', label: 'Long import', status: 'running' as const,
        heartbeatAt: 5_000, startedAt: 1_000, updatedAt: 5_000,
    }
    let resolve!: (response: SessionsResponse) => void
    const api = { getSessions: () => new Promise<SessionsResponse>(done => { resolve = done }) } as unknown as ApiClient
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useSessions(api, { enabled: false }), { wrapper })
    await act(async () => {
        const pending = result.current.refetch()
        client.setQueryData(queryKeys.sessions, { sessions: [{
            ...row('a', 2_000),
            attachedJob: cleared ? null : job,
            attachedJobUpdatedAt: 5_000,
        }] })
        resolve({ sessions: [{
            ...row('a', 500),
            pendingRequestsCount: 1,
            pendingRequestKinds: ['input'],
            pendingRequests: [{ id: 'old', kind: 'input', tool: 'request_user_input', since: 1_000 }],
            attachedJob: cleared ? { ...job, updatedAt: 4_000, heartbeatAt: 4_000 } : null,
            attachedJobUpdatedAt: 4_000,
        }] })
        await pending
    })

    await waitFor(() => expect(result.current.sessions[0]?.lastUserMessageAt).toBe(2_000))
    expect(result.current.sessions[0]!.pendingRequestsCount).toBe(0)
    expect(result.current.sessions[0]!.pendingRequests).toEqual([])
    expect(result.current.sessions[0]!.attachedJob).toEqual(cleared ? null : job)
    expect(result.current.sessions[0]!.attachedJobUpdatedAt).toBe(5_000)
})
