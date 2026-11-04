import { mergeReadState } from '@hapi/protocol'
import type { Session, SessionSummary } from '@/types/api'

/** Merge a full REST/SSE snapshot without reviving superseded requests. */
export function mergeSessionSnapshot(current: Session | undefined, incoming: Session): Session {
    const keepAgentState = current !== undefined && current.agentStateVersion > incoming.agentStateVersion
    return {
        ...incoming,
        lastUserMessageAt: incoming.lastUserMessageAt === undefined
            ? current?.lastUserMessageAt
            : Math.max(current?.lastUserMessageAt ?? 0, incoming.lastUserMessageAt),
        agentState: keepAgentState ? current.agentState : incoming.agentState,
        agentStateVersion: keepAgentState ? current.agentStateVersion : incoming.agentStateVersion,
        contentRevision: Math.max(current?.contentRevision ?? 0, incoming.contentRevision ?? 0),
        readState: mergeReadState(current?.readState, incoming.readState)
    }
}

/** A summary has only a capped request slice, so keep coherent derived fields. */
export function mergeSessionSummarySnapshot(current: SessionSummary | undefined, incoming: SessionSummary): {
    summary: SessionSummary
    needsRefetch: boolean
} {
    const currentClock = current?.lastUserMessageAt ?? 0
    const incomingClock = incoming.lastUserMessageAt ?? 0
    const keepPending = current !== undefined && (currentClock > incomingClock
        || current.agentStateVersion > incoming.agentStateVersion)
    return {
        summary: {
            ...incoming,
            lastUserMessageAt: Math.max(currentClock, incomingClock) || undefined,
            contentRevision: Math.max(current?.contentRevision ?? 0, incoming.contentRevision ?? 0),
            readState: mergeReadState(current?.readState, incoming.readState),
            ...(keepPending ? {
                pendingRequestsCount: current.pendingRequestsCount,
                pendingRequestKinds: current.pendingRequestKinds,
                pendingRequests: current.pendingRequests,
                agentStateVersion: current.agentStateVersion
            } : {})
        },
        // Neither capped summary has all requests at both new watermarks.
        needsRefetch: keepPending && (incomingClock > currentClock
            || incoming.agentStateVersion > current.agentStateVersion)
    }
}
