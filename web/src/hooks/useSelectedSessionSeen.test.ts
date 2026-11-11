import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionLastSeenAt, getSessionManualUnreadAt, getUnreadSessionCount, observeSessionReadStates } from '@/lib/sessionLastSeen'
import { useSelectedSessionSeen } from './useSelectedSessionSeen'

function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    document.dispatchEvent(new Event('visibilitychange'))
}
function viewport(atBottom = true) {
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 100 })
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 200 })
    element.scrollTop = atBottom ? 100 : 0
    return { current: element }
}
const content = { current: document.createElement('div') }
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(100) })

class ObservedResize {
    static instances: ObservedResize[] = []
    readonly targets = new Set<Element>()
    constructor(private readonly callback: ResizeObserverCallback) { ObservedResize.instances.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    static trigger(target: Element) {
        for (const observer of this.instances) {
            if (observer.targets.has(target)) observer.callback([{ target } as ResizeObserverEntry], observer as unknown as ResizeObserver)
        }
    }
}

beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); setVisibility('visible')
    ObservedResize.instances = []
    vi.stubGlobal('ResizeObserver', ObservedResize)
})
afterEach(() => { vi.useRealTimers(); setVisibility('visible'); vi.unstubAllGlobals() })

describe('rendered read receipt', () => {
    it('acknowledges a tail exposed only by viewport growth and retains the receipt after leaving', async () => {
        const view = viewport(false)
        const head = { id: 's', contentRevision: 3 }
        const { unmount } = renderHook(() => useSelectedSessionSeen('s', 3, 0, view, content))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        expect(getUnreadSessionCount([head])).toBe(1)

        Object.defineProperty(view.current, 'clientHeight', { configurable: true, value: 200 })
        act(() => ObservedResize.trigger(view.current))
        await settle()

        expect(getSessionLastSeenAt('s')).toBe(3)
        expect(getUnreadSessionCount([head])).toBe(0)
        unmount()
        expect(getUnreadSessionCount([head])).toBe(0)
        expect(ObservedResize.instances.every(observer => observer.targets.size === 0)).toBe(true)
    })

    it('acknowledges a previously zero-height viewport becoming visible without a scroll', async () => {
        const view = viewport(false)
        Object.defineProperty(view.current, 'clientHeight', { configurable: true, value: 0 })
        const { unmount } = renderHook(() => useSelectedSessionSeen('s', 3, 0, view, content))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        Object.defineProperty(view.current, 'clientHeight', { configurable: true, value: 200 })
        act(() => ObservedResize.trigger(view.current))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
        unmount()
        expect(getUnreadSessionCount([{ id: 's', contentRevision: 3 }])).toBe(0)
    })

    it('updates tail following on content-only resize and restores unread after scrolling away', async () => {
        const view = viewport(false)
        const head = { id: 's', contentRevision: 4 }
        const { unmount } = renderHook(() => useSelectedSessionSeen('s', 3, 0, view, content))
        await settle()
        expect(getUnreadSessionCount([head])).toBe(1)

        Object.defineProperty(view.current, 'scrollHeight', { configurable: true, value: 100 })
        act(() => ObservedResize.trigger(content.current))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
        expect(getUnreadSessionCount([head])).toBe(0)

        Object.defineProperty(view.current, 'scrollHeight', { configurable: true, value: 200 })
        act(() => view.current.dispatchEvent(new Event('scroll')))
        expect(getUnreadSessionCount([head])).toBe(1)
        unmount()
        expect(getUnreadSessionCount([head])).toBe(1)
    })

    it('waits for visible rendered tail and uses only its observed revision', async () => {
        setVisibility('hidden')
        const view = viewport()
        const { rerender } = renderHook(({ revision }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 2 },
        })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        rerender({ revision: 3 })
        act(() => setVisibility('visible'))
        expect(getSessionLastSeenAt('s')).toBe(0)
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('does not clear unread while browsing history or when no loaded receipt exists', async () => {
        const view = viewport(false)
        const { rerender } = renderHook(({ revision }: { revision?: number }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 3 as number | undefined },
        })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        rerender({ revision: undefined })
        view.current.scrollTop = 100
        act(() => view.current.dispatchEvent(new Event('scroll')))
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(0)
        rerender({ revision: 3 })
        await settle()
        expect(getSessionLastSeenAt('s')).toBe(3)
    })

    it('hides output that arrives ahead of the rendered tail only while following it', async () => {
        const view = viewport(true)
        const head = { id: 's', contentRevision: 4 }
        const { rerender, unmount } = renderHook(({ revision }: { revision?: number }) => useSelectedSessionSeen('s', revision, 0, view, content), {
            initialProps: { revision: 3 as number | undefined },
        })
        expect(getUnreadSessionCount([head])).toBe(0)
        view.current.scrollTop = 0
        act(() => view.current.dispatchEvent(new Event('scroll')))
        expect(getUnreadSessionCount([head])).toBe(1)
        view.current.scrollTop = 100
        act(() => view.current.dispatchEvent(new Event('scroll')))
        expect(getUnreadSessionCount([head])).toBe(0)
        rerender({ revision: undefined })
        expect(getUnreadSessionCount([head])).toBe(1)
        rerender({ revision: 3 })
        act(() => setVisibility('hidden'))
        expect(getUnreadSessionCount([head])).toBe(1)
        act(() => setVisibility('visible'))
        expect(getUnreadSessionCount([head])).toBe(0)
        unmount()
        expect(getUnreadSessionCount([head])).toBe(1)
        expect(getSessionLastSeenAt('s')).toBe(0)
    })

    it('read-state SSE alone cannot clear a manual unread choice', async () => {
        const view = viewport()
        const { rerender } = renderHook(({ version }) => useSelectedSessionSeen('s', 3, version, view, content), {
            initialProps: { version: 0 },
        })
        await settle()
        observeSessionReadStates([{ id: 's', readState: { readRevision: 3, version: 2, manualUnread: true } }])
        rerender({ version: 2 })
        act(() => view.current.dispatchEvent(new Event('scroll')))
        await settle()
        expect(getSessionManualUnreadAt('s')).toBe(0)
    })
})
