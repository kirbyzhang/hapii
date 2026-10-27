import { describe, expect, it } from 'bun:test'
import { confirmSessionArchiveStop, type SessionStopStatus } from './sessionArchiveStop'

function clock() {
    let time = 0
    const sleeps: number[] = []
    return {
        now: () => time,
        advance: (milliseconds: number) => { time += milliseconds },
        sleep: async (milliseconds: number) => { sleeps.push(milliseconds); time += milliseconds },
        sleeps
    }
}

describe('session archive stop confirmation', () => {
    for (const status of ['stopped', 'already_gone', 'still_alive'] as const) {
        it(`returns first ${status} without delaying or repeating the RPC`, async () => {
            const timer = clock()
            let calls = 0
            expect(await confirmSessionArchiveStop(async () => { calls++; return status }, timer)).toBe(status)
            expect(calls).toBe(1)
            expect(timer.sleeps).toEqual([])
        })
    }
    it('retries only unknown acknowledgements until shutdown is confirmed', async () => {
        const timer = clock()
        const statuses: SessionStopStatus[] = ['unknown', 'unknown', 'already_gone']
        let calls = 0
        expect(await confirmSessionArchiveStop(async () => statuses[calls++]!, timer)).toBe('already_gone')
        expect(calls).toBe(3)
        expect(timer.sleeps).toEqual([100, 100])
    })
    it('stops retrying as soon as a later probe reports still_alive', async () => {
        const timer = clock()
        let calls = 0
        expect(await confirmSessionArchiveStop(async () => ++calls === 1 ? 'unknown' : 'still_alive', timer)).toBe('still_alive')
        expect(calls).toBe(2)
        expect(timer.sleeps).toEqual([100])
    })
    it('bounds persistent unknown confirmations by the total budget including RPC time', async () => {
        const timer = clock()
        let calls = 0
        expect(await confirmSessionArchiveStop(async () => {
            calls++; timer.advance(125); return 'unknown'
        }, { ...timer, timeoutMs: 500 })).toBe('unknown')
        expect(calls).toBe(3)
        expect(timer.now()).toBe(575)
        expect(timer.sleeps).toEqual([100, 100])
    })
    it('propagates a failed confirmation instead of treating it as exit evidence', async () => {
        const timer = clock()
        await expect(confirmSessionArchiveStop(async () => { throw new Error('RPC failed') }, timer)).rejects.toThrow('RPC failed')
        expect(timer.sleeps).toEqual([])
    })
    it('does not abandon an in-flight confirmation when the budget expires', async () => {
        const timer = clock()
        let resolve!: (status: SessionStopStatus) => void
        let entered!: () => void
        const started = new Promise<void>(done => { entered = done })
        let calls = 0
        let settled = false
        const confirmation = confirmSessionArchiveStop(async () => {
            if (++calls === 1) return 'unknown'
            entered()
            return new Promise<SessionStopStatus>(done => { resolve = done })
        }, { ...timer, timeoutMs: 500 }).then(value => { settled = true; return value })
        await started
        timer.advance(1000)
        await Promise.resolve()
        const prematurelySettled = settled
        resolve('already_gone')
        expect(await confirmation).toBe('already_gone')
        expect(prematurelySettled).toBe(false)
        expect(calls).toBe(2)
    })
})
