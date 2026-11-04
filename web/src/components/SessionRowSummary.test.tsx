import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { markCodexSessionsImported } from '@/lib/codexImportedSessions'
import { markSessionSeen, markSessionUnread } from '@/lib/sessionLastSeen'
import { SessionRowSummary } from './SessionRowSummary'

afterEach(() => cleanup())

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: 'background-demo',
        active: true,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/demo/status', name: 'Background demo', flavor: 'claude' },
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 2,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        contentRevision: overrides.updatedAt ?? 0,
        ...overrides
    }
}

function renderSummary(showDetailedStatus: boolean) {
    return render(
        <I18nProvider>
            <SessionRowSummary
                session={makeSummary()}
                showDetailedStatus={showDetailedStatus}
            />
        </I18nProvider>
    )
}

describe('SessionRowSummary background status', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('shows green and blue spinners beside titles while quiet rows have no status chrome', () => {
        const background = renderSummary(false).container
        expect(background.querySelector('svg.animate-spin-slow')).toHaveClass('text-blue-400')
        expect(screen.getByTitle('Background demo').nextElementSibling).toBe(background.querySelector('svg.animate-spin-slow'))
        expect(screen.queryByText('Background tasks running')).toBeNull()
        expect(screen.queryByTestId('session-presence')).toBeNull()
        cleanup()

        const thinking = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ thinking: true, backgroundTaskCount: 0 })} showDetailedStatus={false} />
            </I18nProvider>
        ).container
        const title = screen.getByTitle('Background demo')
        expect(thinking.querySelector('svg.animate-spin-slow')).toHaveClass('text-[var(--app-badge-success-text)]')
        expect(title.nextElementSibling).toBe(thinking.querySelector('svg.animate-spin-slow'))
        expect(title.previousElementSibling).toHaveClass('h-4', 'w-4')
        expect(screen.queryByText('Running', { exact: true })).toBeNull()
        expect(screen.queryByTestId('session-presence')).toBeNull()
        cleanup()

        const idle = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ backgroundTaskCount: 0 })} />
            </I18nProvider>
        ).container
        expect(idle.querySelector('[data-testid="session-presence"]')).toBeNull()
        expect(idle.querySelector('svg.animate-spin-slow')).toBeNull()
        expect(screen.queryByText('Waiting for input')).toBeNull()
        expect(screen.queryByTestId('session-task-status')).toBeNull()
    })

    it('dims disconnected rows, greys their title, and hides live task status', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ active: false, backgroundTaskCount: 0 })} />
            </I18nProvider>
        )
        expect(container.querySelector('.opacity-50')).not.toBeNull()
        expect(screen.getByTitle('Background demo')).toHaveClass('text-[var(--app-hint)]')
        expect(container.querySelector('[data-testid="session-presence"]')).toBeNull()
        expect(screen.queryByTestId('session-task-status')).toBeNull()
    })

    it.each([false, true])('keeps foreground work green even with background tasks, then clears the spinner when quiet or disconnected (detailed=%s)', (showDetailedStatus) => {
        const row = (session: SessionSummary) => (
            <I18nProvider>
                <SessionRowSummary session={session} showDetailedStatus={showDetailedStatus} />
            </I18nProvider>
        )
        const running = makeSummary({ thinking: true, backgroundTaskCount: 2 })
        const { container, rerender } = render(row(running))
        expect(container.querySelector('svg.animate-spin-slow')).toHaveClass('text-[var(--app-badge-success-text)]')
        expect(screen.queryByTestId('session-presence')).toBeNull()

        rerender(row({ ...running, thinking: false, backgroundTaskCount: 0 }))
        expect(screen.queryByTestId('session-task-status')).toBeNull()
        expect(screen.queryByText('Waiting for input')).toBeNull()
        expect(container.querySelector('svg.animate-spin-slow')).toBeNull()
        expect(container.querySelector('.opacity-50')).toBeNull()
        expect(screen.getByTitle('Background demo')).toHaveClass('font-normal', 'text-[var(--app-fg)]')

        rerender(row({ ...running, active: false }))
        expect(screen.queryByTestId('session-task-status')).toBeNull()
        expect(screen.queryByTestId('session-presence')).toBeNull()
        expect(container.querySelector('svg.animate-spin-slow')).toBeNull()
        expect(container.querySelector('.opacity-50')).not.toBeNull()
    })

    it.each(['permission', 'input'] as const)('prioritizes a pending %s request over running and background work', (kind) => {
        const session = makeSummary({
            thinking: true,
            pendingRequestsCount: 1,
            pendingRequestKinds: [kind],
            pendingRequests: [{ id: 'request', kind, tool: 'Question', since: 0 }],
        })
        const row = (showDetailedStatus: boolean) => (
            <I18nProvider>
                <SessionRowSummary session={session} showDetailedStatus={showDetailedStatus} />
            </I18nProvider>
        )
        const { container, rerender } = render(row(false))
        const expectedLabel = kind === 'permission' ? 'Permission required' : 'Needs input'
        expect(screen.getByLabelText('pending')).toBeInTheDocument()
        expect(screen.getByText('pending')).toBeInTheDocument()
        expect(container.querySelector('svg.animate-spin-slow')).toBeNull()

        rerender(row(true))
        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent(expectedLabel)
        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Question')
        expect(container.querySelector('svg.animate-spin-slow')).toBeNull()
    })

    it('does not add persistent status text or a spinner to a keepalive-only idle row', () => {
        const idle = makeSummary({
            backgroundTaskCount: 0,
            metadata: { path: '/demo', name: 'Idle session', lifecycleState: 'idle' },
        })
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={idle} />
            </I18nProvider>
        )
        expect(screen.queryByTestId('session-task-status')).toBeNull()
        expect(screen.queryByText('Idle (keepalive only)')).toBeNull()
        expect(screen.queryByText('Waiting for input')).toBeNull()
        expect(container.querySelector('svg.animate-spin-slow')).toBeNull()
        expect(screen.queryByTestId('session-presence')).toBeNull()
    })

    it('shows the detailed background tooltip on the blue spinner in Extended mode', () => {
        const { container } = renderSummary(true)

        expect(screen.queryByText('Running', { exact: true })).not.toBeInTheDocument()
        expect(container.querySelector('svg.animate-spin-slow')).toHaveClass('text-blue-400')
        const tooltip = screen.getByRole('tooltip', { hidden: true })
        expect(tooltip).toHaveTextContent('Background tasks running')
        expect(tooltip).toHaveTextContent('2 tasks running')
    })

    it('refreshes unread attention when the local watermark version changes', () => {
        const session = makeSummary({
            active: false,
            backgroundTaskCount: 0,
            updatedAt: 2_000,
        })
        markSessionSeen(session.id, 2_000)
        const view = render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expect(screen.queryByText('New activity')).not.toBeInTheDocument()
        expect(screen.getByText('Background demo')).toHaveClass('font-normal')

        markSessionUnread(session.id)
        view.rerender(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    showDetailedStatus={true}
                    lastSeenVersion={1}
                />
            </I18nProvider>
        )

        expectUnread()
    })

    it('keeps an explicit unread mark across newer activity', () => {
        const session = makeSummary({
            id: 'selected-unread',
            active: false,
            backgroundTaskCount: 0,
            updatedAt: 2_000,
        })
        markSessionSeen(session.id, 2_000)
        markSessionUnread(session.id)

        const view = render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    selected={true}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expectUnread()

        view.rerender(
            <I18nProvider>
                <SessionRowSummary
                    session={{ ...session, updatedAt: 2_001 }}
                    selected={true}
                    showDetailedStatus={true}
                    lastSeenVersion={1}
                />
            </I18nProvider>
        )

        expectUnread()
    })

    it('preserves the green working spinner beside an unread title without adding a dot', () => {
        const session = makeSummary({
            id: 'selected-thinking-unread',
            thinking: true,
            updatedAt: 2_000,
        })
        markSessionSeen(session.id, 2_000)
        markSessionUnread(session.id)

        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={session}
                    selected={true}
                    showDetailedStatus={true}
                    lastSeenVersion={0}
                />
            </I18nProvider>
        )

        expectUnread()
        expect(container.querySelectorAll('.rounded-full')).toHaveLength(0)
        expect(container.querySelector('svg.animate-spin-slow')).toHaveClass('text-[var(--app-badge-success-text)]')
        expect(screen.queryByTestId('session-presence')).toBeNull()
    })

    it('shows unseen output from a running session', () => {
        const session = makeSummary({ id: 'running-unread', backgroundTaskCount: 1, updatedAt: 2_000 })
        markSessionSeen(session.id, 1_000)

        const { container } = render(
            <I18nProvider>
                <SessionRowSummary session={session} showDetailedStatus={true} lastSeenVersion={0} />
            </I18nProvider>
        )

        expectUnread()
        expect(container.querySelector('svg.animate-spin-slow')).toHaveClass('text-blue-400')
        expect(screen.queryByTestId('session-presence')).toBeNull()
    })

    it('shows pending requests as an amber symbol, not a dot', () => {
        const { container } = render(
            <I18nProvider>
                <SessionRowSummary
                    session={makeSummary({
                        backgroundTaskCount: 0,
                        pendingRequestsCount: 1,
                        pendingRequestKinds: ['permission'],
                        pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: 0 }],
                    })}
                    showDetailedStatus={true}
                />
            </I18nProvider>
        )

        expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Bash')
        expect(container.querySelector('.text-\\[var\\(--app-badge-warning-text\\)\\] svg')).not.toBeNull()
        expect(container.querySelectorAll('.rounded-full')).toHaveLength(0)
    })
})

function expectUnread() {
    expect(screen.getByText('New activity')).toHaveClass('sr-only')
    expect(screen.getByTitle('Background demo')).toHaveClass('font-normal')
}

describe('SessionRowSummary time label', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('advances the relative time without a parent render', () => {
        vi.useFakeTimers()
        vi.setSystemTime(1_800_000_000_000)
        render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({ updatedAt: 1_800_000_000_000, backgroundTaskCount: 0 })} />
            </I18nProvider>
        )
        expect(screen.getByText('just now')).toBeInTheDocument()

        act(() => { vi.advanceTimersByTime(2 * 60_000) })
        expect(screen.getByText('2m ago')).toBeInTheDocument()
    })

    it('shows a Codex import marker set after the first render', () => {
        render(
            <I18nProvider>
                <SessionRowSummary session={makeSummary({
                    updatedAt: Date.now() - 3 * 60 * 60_000,
                    backgroundTaskCount: 0,
                    metadata: { path: '/demo', name: 'Imported', flavor: 'codex', agentSessionId: 'codex-thread' },
                })} />
            </I18nProvider>
        )
        expect(screen.queryByText('just imported from Codex')).toBeNull()

        act(() => { markCodexSessionsImported(['codex-thread']) })
        expect(screen.getByText('just imported from Codex')).toBeInTheDocument()
    })
})
