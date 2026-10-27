export type SessionStopStatus = 'stopped' | 'already_gone' | 'still_alive' | 'unknown'

export class SessionArchiveStopUnconfirmedError extends Error {
    constructor() {
        super('Session process is still running and could not be stopped. Wait briefly and retry archiving.')
        this.name = 'SessionArchiveStopUnconfirmedError'
    }
}

/** Retry an ambiguous stop acknowledgement while the CLI finishes shutting down. */
export async function confirmSessionArchiveStop(
    confirm: () => Promise<SessionStopStatus>,
    options: {
        timeoutMs?: number
        intervalMs?: number
        now?: () => number
        sleep?: (milliseconds: number) => Promise<void>
    } = {}
): Promise<SessionStopStatus> {
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    const deadline = now() + (options.timeoutMs ?? 3_000)
    let status = await confirm()
    while (status === 'unknown' && now() < deadline) {
        await sleep(Math.min(options.intervalMs ?? 100, deadline - now()))
        // RPC time counts toward the budget; never abandon an in-flight stop
        // with Promise.race and release the lifecycle lock before it completes.
        if (now() >= deadline) break
        status = await confirm()
    }
    return status
}
