import { describe, expect, it } from 'vitest'
import { toSessionSummary } from '@hapi/protocol'
import type { Session } from '@/types/api'
import { mergeSessionSnapshot, mergeSessionSummarySnapshot } from './sessionSnapshot'

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 's', namespace: 'default', seq: 1, createdAt: 1, active: true, activeAt: 0, updatedAt: 2_000,
        metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 1,
        thinking: false, thinkingAt: 0, model: null, modelReasoningEffort: null,
        effort: null, serviceTier: null, ...overrides
    }
}

const oldRequest = { tool: 'Bash', arguments: {}, createdAt: 1_000 }

describe('pending-request snapshot coherence', () => {
    it('keeps newer user input and raw request versions through stale full snapshots', () => {
        const current = session({ lastUserMessageAt: 2_000, agentStateVersion: 3,
            agentState: { requests: { old: oldRequest, fresh: { ...oldRequest, createdAt: 2_500 } } } })
        const incoming = session({ lastUserMessageAt: 500, agentStateVersion: 1,
            agentState: { requests: { old: oldRequest } } })
        const merged = mergeSessionSnapshot(current, incoming)
        expect(merged.lastUserMessageAt).toBe(2_000)
        expect(merged.agentStateVersion).toBe(3)
        expect(merged.agentState).toBe(current.agentState)
        expect(toSessionSummary(merged).pendingRequests.map(r => r.id)).toEqual(['fresh'])
        expect(Object.keys(current.agentState!.requests!)).toEqual(['old', 'fresh'])
    })

    it('does not revive requests from a delayed summary with an older input clock', () => {
        const raw = session({ agentState: { requests: { old: oldRequest } } })
        const current = toSessionSummary({ ...raw, lastUserMessageAt: 2_000 })
        const incoming = toSessionSummary({ ...raw, lastUserMessageAt: 500 })
        expect(incoming.pendingRequestsCount).toBe(1)
        const merged = mergeSessionSummarySnapshot(current, incoming)
        expect(merged.summary.pendingRequestsCount).toBe(0)
        expect(merged.summary.pendingRequestKinds).toEqual([])
        expect(merged.summary.pendingRequests).toEqual([])
        expect(merged.summary.lastUserMessageAt).toBe(2_000)
        expect(merged.needsRefetch).toBe(false)
    })

    it.each(['clock', 'state'] as const)('refetches crossed summary watermarks when the newer %s arrives separately', (newer) => {
        const raw = session({ agentState: { requests: { old: oldRequest } } })
        const current = toSessionSummary({ ...raw, lastUserMessageAt: 1_500, agentStateVersion: 3 })
        const incoming = toSessionSummary({ ...raw,
            lastUserMessageAt: newer === 'clock' ? 2_000 : 1_000,
            agentStateVersion: newer === 'clock' ? 2 : 4 })
        const merged = mergeSessionSummarySnapshot(current, incoming)
        expect(merged.summary.pendingRequestsCount).toBe(0)
        expect(merged.summary.agentStateVersion).toBe(3)
        expect(merged.needsRefetch).toBe(true)
        const coherent = toSessionSummary({ ...raw, lastUserMessageAt: 2_000, agentStateVersion: 4 })
        expect(mergeSessionSummarySnapshot(merged.summary, coherent)).toEqual({
            summary: { ...coherent, contentRevision: 0 }, needsRefetch: false
        })
    })
})
