import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { SessionCache } from './sessionCache'
import type { Session } from '@hapi/protocol/types'
import type { RpcGateway } from './rpcGateway'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('SyncEngine per-session lifecycle serialization', () => {
    let store: Store
    let engine: SyncEngine
    let cache: SessionCache
    let gateway: RpcGateway
    let spawned: string[]
    let spawnArchiveStates: Array<string | undefined>

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        ;(engine as unknown as { archiveStopConfirmationTimeoutMs: number }).archiveStopConfirmationTimeoutMs = 0
        const internals = engine as unknown as {
            sessionCache: SessionCache
            rpcGateway: RpcGateway
            machineCache: unknown
            waitForSessionActive: (id: string) => Promise<boolean>
        }
        cache = internals.sessionCache
        gateway = internals.rpcGateway
        internals.machineCache = {
            getOnlineMachinesByNamespace: () => [{ id: 'machine-test', metadata: { host: 'localhost' } }],
            expireInactive() {}
        }
        internals.waitForSessionActive = async () => true
        spawned = []
        spawnArchiveStates = []
        gateway.killSession = async () => ({})
        gateway.stopRunnerSession = async () => 'already_gone'
        gateway.spawnSession = async (...args) => {
            const id = args[12]!
            spawned.push(id)
            spawnArchiveStates.push((store.sessions.getSession(id)?.metadata as Session['metadata'])?.lifecycleState)
            return { type: 'success', sessionId: id }
        }
    })
    afterEach(() => { engine.stop(); store.close() })

    function insert(tag: string, archived = false): string {
        const session = cache.getOrCreateSession(tag, {
            path: '/tmp/lifecycle-test', host: 'localhost', machineId: 'machine-test',
            flavor: 'codex', codexSessionId: `native-${tag}`, startedBy: 'runner',
            ...(archived ? { lifecycleState: 'archived' as const, archivedBy: 'hub' as const, archiveReason: 'test archive' } : {})
        }, { startingMode: 'remote' }, 'default')
        store.messages.addMessage(session.id, {
            role: 'user', content: { type: 'text', text: `History for ${tag}` }, meta: { sentFrom: 'test' }
        }, `history-${tag}`)
        if (!archived) cache.markSessionActive(session.id)
        return session.id
    }

    function pendingStop(id: string) {
        const entered = deferred<void>()
        const release = deferred<'already_gone' | 'still_alive' | 'unknown'>()
        let pending = true
        gateway.stopRunnerSession = async (_machine, sid) => {
            if (sid !== id) return 'already_gone'
            // CLI death/heartbeat loss precedes completion of runner StopSession.
            engine.handleSessionEnd({ sid, time: Date.now() })
            entered.resolve()
            const result = await release.promise
            pending = false
            return result
        }
        return { entered: entered.promise, release, isPending: () => pending }
    }

    for (const action of ['resume', 'reopen'] as const) {
        it(`waits for archive stop completion before Codex ${action}, preserving the id and history`, async () => {
            const id = insert(`race-${action}`)
            const history = store.messages.getMessages(id, 10)
            const stop = pendingStop(id)
            const archive = engine.archiveSession(id)
            await stop.entered
            let spawnedWhileStopping = false
            const spawn = gateway.spawnSession
            gateway.spawnSession = async (...args) => {
                spawnedWhileStopping ||= stop.isPending()
                return spawn(...args)
            }
            const resume = action === 'resume'
                ? engine.resumeSession(id, 'default')
                : engine.reopenSession(id, 'default')
            await tick()
            stop.release.resolve('already_gone')
            await archive
            const result = await resume
            expect(result).toMatchObject({ type: 'success', sessionId: id })
            expect({
                spawnedWhileStopping,
                archivedAfterResume: (store.sessions.getSession(id)?.metadata as Session['metadata'])?.lifecycleState === 'archived'
            }).toEqual({ spawnedWhileStopping: false, archivedAfterResume: false })
            expect(spawned).toEqual([id])
            expect(spawnArchiveStates).toEqual([undefined])
            expect((store.sessions.getSession(id)?.metadata as Session['metadata'])?.lifecycleState).not.toBe('archived')
            expect(cache.getSession(id)?.active).toBe(true)
            expect(store.messages.getMessages(id, 10)).toEqual(history)
        })
    }

    it('keeps reopen behind all unknown-stop retries and sends KillSession once', async () => {
        const id = insert('retry-then-reopen')
        ;(engine as unknown as { archiveStopConfirmationTimeoutMs: number }).archiveStopConfirmationTimeoutMs = 3000
        const firstEntered = deferred<void>()
        const finalEntered = deferred<void>()
        const release = deferred<'already_gone'>()
        let kills = 0
        let confirmations = 0
        gateway.killSession = async () => { kills++; return {} }
        gateway.stopRunnerSession = async () => {
            engine.handleSessionEnd({ sid: id, time: Date.now() })
            confirmations++
            if (confirmations === 1) { firstEntered.resolve(); return 'unknown' }
            finalEntered.resolve()
            return release.promise
        }
        const archive = engine.archiveSession(id)
        await firstEntered.promise
        const reopen = engine.reopenSession(id, 'default')
        await finalEntered.promise
        const spawnsBeforeFinalConfirmation = spawned.length
        release.resolve('already_gone')
        await archive
        const result = await reopen
        expect(spawnsBeforeFinalConfirmation).toBe(0)
        expect(result).toMatchObject({ type: 'success', sessionId: id })
        expect(kills).toBe(1)
        expect(confirmations).toBe(2)
        expect(spawned).toEqual([id])
    })

    it('coalesces two ordinary Codex reopens into one spawn', async () => {
        const id = insert('duplicate', true)
        const entered = deferred<void>()
        const release = deferred<void>()
        const spawn = gateway.spawnSession
        gateway.spawnSession = async (...args) => {
            const result = await spawn(...args)
            entered.resolve()
            await release.promise
            return result
        }
        const first = engine.reopenSession(id, 'default')
        await entered.promise
        const second = engine.reopenSession(id, 'default')
        await tick()
        release.resolve()
        const results = await Promise.all([first, second])
        expect(results.every(result => result.type === 'success' && result.sessionId === id)).toBe(true)
        expect(spawned).toEqual([id])
    })

    it('restores archive metadata on failed reopen and allows a later reopen', async () => {
        const id = insert('retry', true)
        const spawn = gateway.spawnSession
        let attempts = 0
        gateway.spawnSession = async (...args) => {
            attempts++
            if (attempts === 1) return { type: 'error', message: 'runner spawn rejected' }
            return spawn(...args)
        }
        const first = await engine.reopenSession(id, 'default')
        expect(first).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(store.sessions.getSession(id)?.metadata).toMatchObject({ lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'test archive' })
        const second = await engine.reopenSession(id, 'default')
        expect(second).toMatchObject({ type: 'success', sessionId: id })
        expect(attempts).toBe(2)
        expect(store.messages.getMessages(id, 10)).toHaveLength(1)
    })

    it('does not block another session while one session is being archived', async () => {
        const busy = insert('busy')
        const independent = insert('independent', true)
        const stop = pendingStop(busy)
        const archive = engine.archiveSession(busy)
        await stop.entered
        const result = await engine.reopenSession(independent, 'default')
        const stillStopping = stop.isPending()
        stop.release.resolve('already_gone')
        await archive
        expect(result).toMatchObject({ type: 'success', sessionId: independent })
        expect(stillStopping).toBe(true)
        expect(spawned).toEqual([independent])
    })

    for (const status of ['still_alive', 'unknown'] as const) {
        it(`releases a failed archive queue but blocks replacement until runner confirms stop (${status})`, async () => {
            const id = insert(`failed-archive-${status}`)
            const history = store.messages.getMessages(id, 10)
            const stop = pendingStop(id)
            const archive = engine.archiveSession(id).then(() => null, error => error as Error)
            await stop.entered
            const reopen = engine.reopenSession(id, 'default')
            await tick()
            stop.release.resolve(status)
            const error = await archive
            const result = await reopen
            expect(error).toBeInstanceOf(Error)
            expect(result).toMatchObject({ type: 'error', code: 'resume_failed' })
            expect(await engine.resumeSession(id, 'default')).toMatchObject({ type: 'error', code: 'resume_failed' })
            await expect(engine.archiveSession(id)).rejects.toThrow('Session process is still running')
            expect(await engine.reopenSession(id, 'default')).toMatchObject({ type: 'error', code: 'resume_failed' })
            expect(spawned).toEqual([])
            const independent = insert(`after-failure-${status}`, true)
            expect(await engine.reopenSession(independent, 'default')).toMatchObject({ type: 'success', sessionId: independent })
            expect(spawned).toEqual([independent])
            gateway.stopRunnerSession = async () => 'already_gone'
            await engine.archiveSession(id)
            const retry = await engine.reopenSession(id, 'default')
            expect(retry).toMatchObject({ type: 'success', sessionId: id })
            expect(spawned).toEqual([independent, id])
            expect(store.messages.getMessages(id, 10)).toEqual(history)
        })
    }

    it('waits for an in-progress resume before archiving its replacement', async () => {
        const id = insert('resume-before-archive', true)
        const history = store.messages.getMessages(id, 10)
        const entered = deferred<void>()
        const release = deferred<void>()
        let spawning = true
        let killedDuringSpawn = false
        const spawn = gateway.spawnSession
        gateway.spawnSession = async (...args) => {
            const result = await spawn(...args)
            entered.resolve()
            await release.promise
            spawning = false
            return result
        }
        gateway.killSession = async () => {
            killedDuringSpawn ||= spawning
            return {}
        }
        const resume = engine.resumeSession(id, 'default')
        await entered.promise
        const archive = engine.archiveSession(id)
        await tick()
        release.resolve()
        const result = await resume
        await archive
        expect(result).toMatchObject({ type: 'success', sessionId: id })
        expect(killedDuringSpawn).toBe(false)
        expect((store.sessions.getSession(id)?.metadata as Session['metadata'])?.lifecycleState).toBe('archived')
        expect(store.messages.getMessages(id, 10)).toEqual(history)
    })

    it('finishes failed-reopen rollback before a queued successful reopen', async () => {
        const id = insert('queued-retry', true)
        const entered = deferred<void>()
        const release = deferred<void>()
        let attempts = 0
        let secondStartedBeforeFailure = false
        let firstPending = true
        const spawn = gateway.spawnSession
        gateway.spawnSession = async (...args) => {
            attempts++
            if (attempts === 1) {
                entered.resolve()
                await release.promise
                firstPending = false
                return { type: 'error', message: 'runner spawn rejected' }
            }
            secondStartedBeforeFailure ||= firstPending
            return spawn(...args)
        }
        const first = engine.reopenSession(id, 'default')
        await entered.promise
        const second = engine.reopenSession(id, 'default')
        await tick()
        release.resolve()
        const results = await Promise.all([first, second])
        expect(results[0]).toMatchObject({ type: 'error', code: 'resume_failed' })
        expect(results[1]).toMatchObject({ type: 'success', sessionId: id })
        expect(secondStartedBeforeFailure).toBe(false)
        expect(attempts).toBe(2)
        expect(cache.getSession(id)?.active).toBe(true)
        expect((store.sessions.getSession(id)?.metadata as Session['metadata'])?.lifecycleState).not.toBe('archived')
    })

    for (const stopStatus of ['already_gone', 'still_alive'] as const) {
    it(`handles the auto-Cursor migration archive callback inside the owning resume lock (${stopStatus})`, async () => {
        const session = cache.getOrCreateSession('cursor-callback', {
            path: '/tmp/lifecycle-test', host: 'localhost', machineId: 'machine-test',
            flavor: 'cursor', cursorSessionId: 'cursor-native-id', cursorSessionProtocol: 'stream-json',
            startedBy: 'runner', lifecycleState: 'running'
        }, null, 'default')
        let callbackCompleted = false
        let callbackFailed = false
        gateway.stopRunnerSession = async () => stopStatus
        const internals = engine as unknown as {
            buildMigratorForRequest: (request: unknown, archive: (id: string) => Promise<void>) => unknown
        }
        internals.buildMigratorForRequest = (_request, archive) => ({
            migrateOne: async (source: Session) => {
                try {
                    await archive(source.id)
                    callbackCompleted = true
                } catch {
                    callbackFailed = true
                }
                return { ok: false, sessionId: source.id, reason: 'internal_error', message: 'Test migration ends after archive', durationMs: 0 }
            }
        })
        const result = await engine.resumeSession(session.id, 'default')
        if (stopStatus === 'still_alive') {
            expect(callbackFailed).toBe(true)
            expect(result).toMatchObject({ type: 'error', code: 'resume_failed', rollbackSafe: false })
            expect(spawned).toEqual([])
            return
        }
        expect(callbackCompleted).toBe(true)
        expect(result).toMatchObject({ type: 'success', sessionId: session.id })
        expect(spawned).toEqual([session.id])
        expect(spawnArchiveStates).toEqual([undefined])
    })
    }
})
