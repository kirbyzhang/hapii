import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { markSessionSeen } from '@/lib/sessionLastSeen'
import { SessionList } from './SessionList'

afterEach(() => cleanup())

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        attachedJob: null,
        attachedJobUpdatedAt: 0,
        contentRevision: overrides.updatedAt ?? 0,
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    return render(
        <QueryClientProvider client={new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false },
            }
        })}>
            <ToastProvider>
                <I18nProvider>{children}</I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

function renderSessionList(sessions: SessionSummary[], headerActions?: ReactNode, api: ApiClient | null = null, selectedSessionId: string | null = null) {
    return renderWithProviders(
        <SessionList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelect={vi.fn()}
            onNewSession={vi.fn()}
            onRefresh={vi.fn()}
            isLoading={false}
            renderHeader
            headerActions={headerActions}
            api={api}
        />
    )
}

function seedReads(values: Record<string, number>) {
    for (const [id, revision] of Object.entries(values)) markSessionSeen(id, revision)
}

describe('SessionList unread visibility', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    it('hides unread rows on first load, after collapsing, and on remount', () => {
        seedReads({ read: 1000, unread: 1000 })
        const sessions = [
            makeSession({ id: 'read', updatedAt: 1000, metadata: { path: '/work/quiet', name: 'Read row' } }),
            makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/quiet', name: 'Unread row' } })
        ]

        const first = renderSessionList(sessions)
        expect(screen.getByTitle('/work/quiet')).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('button', { name: /Unread row/ })).toBeNull()
        fireEvent.click(screen.getByTitle('/work/quiet'))
        expect(screen.getByRole('button', { name: /Read row/ })).toBeInTheDocument()
        const unreadRow = screen.getByRole('button', { name: /Unread row/ })

        fireEvent.click(screen.getByTitle('/work/quiet'))
        const panel = unreadRow.closest('.collapsible-panel')!
        expect(panel).not.toHaveAttribute('data-open')
        fireEvent.transitionEnd(panel)
        expect(screen.queryByRole('button', { name: /Unread row/ })).toBeNull()
        fireEvent.click(screen.getByTitle('/work/quiet'))
        expect(screen.getByRole('button', { name: /Unread row/ })).toBeInTheDocument()
        first.unmount()
        renderSessionList(sessions)
        expect(screen.queryByRole('button', { name: /Unread row/ })).toBeNull()
    })

    it.each([false, true])('restores an explicit fold after reload, isolated by account (unread lens: %s)', unread => {
        localStorage.setItem('hapi-session-list-unread-only', String(unread))
        const sessions = [makeSession({ id: 'busy', active: true, updatedAt: 42, metadata: { path: '/work/busy', name: 'Busy row' } })]
        const api = (ns: string) => ({ getReadStateScope: () => ns } as ApiClient)
        const first = renderSessionList(sessions, undefined, api('a'))
        fireEvent.click(screen.getByTitle('/work/busy'))
        first.unmount()
        const second = renderSessionList(sessions, undefined, api('a'))
        expect(screen.queryByText('Busy row')).toBeNull()
        second.unmount()
        renderSessionList(sessions, undefined, api('b'))
        expect(screen.getByText('Busy row')).toBeInTheDocument()
    })

    it('shows nothing under a collapsed project once everything is read', () => {
        seedReads({ read: 1000 })
        renderSessionList([
            makeSession({ id: 'read', updatedAt: 1000, metadata: { path: '/work/quiet', name: 'Read row' } })
        ])

        expect(screen.queryByRole('button', { name: /Read row/ })).toBeNull()
    })

    it('keeps unread and selected closed rows in the zero-row preview, then hides unread rows after marking them read', () => {
        const sessions = [
            makeSession({ id: 'active', active: true, metadata: { path: '/work/mixed', name: 'Connected row' } }),
            makeSession({ id: 'selected', metadata: { path: '/work/mixed', name: 'Selected closed row' } }),
            makeSession({ id: 'read', metadata: { path: '/work/mixed', name: 'Read closed row' } }),
            makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/mixed', name: 'Unread closed row' } }),
        ]
        seedReads({ unread: 1000 })
        renderSessionList(sessions, undefined, null, 'selected')
        fireEvent.click(screen.getByRole('button', { name: 'Collapse 1' }))

        expect(screen.getByRole('button', { name: /Connected row/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Selected closed row/ })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('button', { name: /Unread closed row/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Read closed row/ })).toBeNull()

        act(() => markSessionSeen('unread', 2000))
        expect(screen.queryByRole('button', { name: /Unread closed row/ })).toBeNull()
        expect(screen.getByRole('button', { name: /Selected closed row/ })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('button', { name: /Connected row/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Expand 2' })).toBeInTheDocument()
    })

    it('shows unread rows above the preview limit only in an expanded project', () => {
        localStorage.setItem('hapi-session-preview-limit', '2')
        const unreadSessions = Array.from({ length: 5 }, (_, index) => makeSession({
            id: `peek-${index}`,
            updatedAt: 2000,
            metadata: { path: '/work/peek', name: `Unread peek ${index}` }
        }))
        seedReads(Object.fromEntries(unreadSessions.map(session => [session.id, 1000])))
        renderSessionList([
            ...unreadSessions,
            makeSession({ id: 'peek-read', metadata: { path: '/work/peek', name: 'Already read row' } })
        ])

        const header = screen.getByTitle('/work/peek')
        expect(header).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('button', { name: /Unread peek/ })).toBeNull()

        fireEvent.click(header)
        expect(header).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getAllByRole('button', { name: /Unread peek/ })).toHaveLength(5)
        expect(screen.queryByRole('button', { name: /Already read row/ })).toBeNull()

        fireEvent.click(header)
        for (const panel of document.querySelectorAll('.collapsible-panel:not([data-open])')) {
            fireEvent.transitionEnd(panel)
        }
        expect(header).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('button', { name: /Unread peek/ })).toBeNull()
    })
})

describe('SessionList unread visibility setting off', () => {
    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem('hapi-keep-unread-sessions-visible', 'false')
    })

    it('folds a collapsed project completely, with no unread peek', () => {
        seedReads({ read: 1000, unread: 1000 })
        renderSessionList([
            makeSession({ id: 'read', updatedAt: 1000, metadata: { path: '/work/quiet', name: 'Read row' } }),
            makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/quiet', name: 'Unread row' } })
        ])

        expect(screen.queryByRole('button', { name: /Unread row/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Read row/ })).toBeNull()
    })

    it('applies the preview limit to unread rows', () => {
        const sessions = Array.from({ length: 10 }, (_, i) => makeSession({
            id: `s${i}`,
            active: i === 0,
            updatedAt: 1000 - i,
            metadata: { path: '/work/busy', name: `Row ${i}` }
        }))
        // The oldest row is the only unread one: it would normally be forced visible.
        seedReads(Object.fromEntries(sessions.map(s => [s.id, s.id === 's9' ? 0 : 1000])))
        renderSessionList(sessions)

        expect(screen.queryByRole('button', { name: /Row 9/ })).toBeNull()
        expect(screen.getByRole('button', { name: /Row 0/ })).toBeInTheDocument()
    })

    it('hides closed unread rows at zero preview while retaining connected and selected rows', () => {
        seedReads({ unread: 1000 })
        renderSessionList([
            makeSession({ id: 'active', active: true, metadata: { path: '/work/mixed', name: 'Connected row' } }),
            makeSession({ id: 'selected', metadata: { path: '/work/mixed', name: 'Selected closed row' } }),
            makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/mixed', name: 'Unread closed row' } }),
            makeSession({ id: 'read', metadata: { path: '/work/mixed', name: 'Read closed row' } }),
        ], undefined, null, 'selected')

        fireEvent.click(screen.getByRole('button', { name: 'Collapse 2' }))

        expect(screen.getByRole('button', { name: /Connected row/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Selected closed row/ })).toHaveAttribute('aria-current', 'page')
        expect(screen.queryByRole('button', { name: /Unread closed row/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Read closed row/ })).toBeNull()
        expect(screen.getByTitle('/work/mixed')).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('button', { name: 'Expand 2' })).toBeInTheDocument()
    })
})

describe('SessionList toolbar order', () => {
    beforeEach(() => {
        localStorage.clear()
    })

    const slotIds = () => Array.from(document.querySelectorAll('[data-testid^="session-toolbar-slot-"]'))
        .map(node => node.getAttribute('data-testid')?.replace('session-toolbar-slot-', ''))

    it('groups list controls, then New, then navigation, with mark all read last', () => {
        seedReads({ unread: 1000 })
        renderSessionList(
            [makeSession({ id: 'unread', updatedAt: 2000, metadata: { path: '/work/unread', name: 'Unread' } })],
            <button type="button">Settings</button>
        )

        expect(slotIds()).toEqual(['view', 'new', 'header-actions', 'mark-all'])
    })

    it('keeps the other controls in place when there is nothing unread', () => {
        seedReads({ read: 1000 })
        renderSessionList(
            [makeSession({ id: 'read', updatedAt: 1000, metadata: { path: '/work/read', name: 'Read' } })],
            <button type="button">Settings</button>
        )

        expect(slotIds()).toEqual(['view', 'new', 'header-actions'])
    })
})
