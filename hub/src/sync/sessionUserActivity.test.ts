import { describe, expect, it } from 'bun:test'
import type { AgentState, SyncEvent } from '@hapi/protocol'
import { toSessionSummary } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('user-activity ordering SSE', () => {
    it('publishes the full unmodified agent-state snapshot at its existing version when user input supersedes requests', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast: (event: SyncEvent) => events.push(event) } as never)
        try {
            const agentState: AgentState = {
                controlledByUser: true,
                startingMode: 'remote',
                requests: {
                    old: { tool: 'request_user_input', arguments: { question: 'Earlier question' }, createdAt: 100 },
                    current: { tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 3_500 },
                    undated: { tool: 'AskUserQuestion', arguments: {} }
                },
                completedRequests: {
                    answered: { tool: 'AskUserQuestion', arguments: {}, status: 'resolved', completedAt: 50 }
                }
            }
            const session = engine.getOrCreateSession('pending-request-watermark', { path: '/tmp', host: 'mac' }, agentState, 'default')
            const originalVersion = session.agentStateVersion
            const rawStoredState = structuredClone(store.sessions.getSession(session.id)!.agentState)
            const receive = (content: unknown, at: number, localId?: string) => {
                const message = store.messages.addMessage(session.id, content, localId, null, at)
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
            }
            const user = { role: 'user', content: { type: 'text', text: 'Continue with the new task' } }
            events.length = 0
            receive(user, 1_000, 'new-user-input')

            expect(events).toContainEqual(expect.objectContaining({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    lastUserMessageAt: 1_000,
                    agentState: { version: originalVersion, value: agentState }
                }
            }))
            expect(toSessionSummary(engine.getSession(session.id)!).pendingRequestsCount).toBe(2)
            expect(engine.getSession(session.id)!.agentStateVersion).toBe(originalVersion)
            expect(engine.getSession(session.id)!.agentState).toEqual(agentState)
            expect(store.sessions.getSession(session.id)!.agentState).toEqual(rawStoredState)
            expect(store.sessions.getSession(session.id)!.agentStateVersion).toBe(originalVersion)

            events.length = 0
            receive(user, 2_000, 'new-user-input')
            receive({ role: 'agent', content: { type: 'text', text: 'Assistant output' } }, 3_000)
            expect(engine.getSession(session.id)!.lastUserMessageAt).toBe(1_000)
            expect(toSessionSummary(engine.getSession(session.id)!).pendingRequestsCount).toBe(2)
            expect(events.filter(event => event.type === 'session-updated' && event.data && 'lastUserMessageAt' in event.data)).toHaveLength(0)

            receive(user, 4_000, 'later-user-input')
            expect(toSessionSummary(engine.getSession(session.id)!).pendingRequestsCount).toBe(1)
            expect(store.sessions.getSession(session.id)!.agentState).toEqual(rawStoredState)
            expect(store.sessions.getSession(session.id)!.agentStateVersion).toBe(originalVersion)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('publishes a summary patch only when stored user input advances the clock', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast: (event: SyncEvent) => events.push(event) } as never)
        try {
            const session = engine.getOrCreateSession('tag', { path: '/tmp', host: 'mac' }, null, 'default')
            const receive = (content: unknown, at: number, localId?: string) => {
                const message = store.messages.addMessage(session.id, content, localId, null, at)
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
            }
            const user = { role: 'user', content: { type: 'text', text: 'hello' } }
            receive(user, 100, 'prompt')
            expect(toSessionSummary(engine.getSession(session.id)!).lastUserMessageAt).toBe(100)
            expect(events.some(e => e.type === 'session-updated' && e.data && 'lastUserMessageAt' in e.data && e.data.lastUserMessageAt === 100)).toBe(true)
            events.length = 0
            receive(user, 500, 'prompt')
            receive({ role: 'agent', content: { type: 'text', text: 'working' } }, 900)
            engine.recordSessionActivity(session.id, 1_000)
            expect(toSessionSummary(engine.getSession(session.id)!).lastUserMessageAt).toBe(100)
            expect(events.filter(e => e.type === 'session-updated' && e.data && 'lastUserMessageAt' in e.data)).toHaveLength(0)
            receive(user, 2_000, 'next')
            expect(toSessionSummary(engine.getSession(session.id)!).lastUserMessageAt).toBe(2_000)
        } finally {
            engine.stop()
            store.close()
        }
    })
})
