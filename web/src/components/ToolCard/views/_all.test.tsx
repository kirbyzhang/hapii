import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { AgentTextBlock, ChatBlock, ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'
import { getLatestCodexAgentReply, getToolViewComponent } from './_all'

function text(id: string, value: string): AgentTextBlock {
    return { kind: 'agent-text', id, localId: null, createdAt: 1, text: value }
}

function block(children: ChatBlock[] = [], state: ToolCallBlock['tool']['state'] = 'completed'): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'agent-card', localId: null, createdAt: 1, children,
        tool: {
            id: 'agent-call', name: 'CodexAgent', state,
            input: { agentId: 'child-thread', prompt: 'Review the proposed plan' },
            result: null, description: null, createdAt: 1, startedAt: 1,
            completedAt: state === 'completed' ? 2 : null, execStartedAt: null, execCompletedAt: null
        }
    }
}

function card(value: ToolCallBlock) {
    return <I18nProvider><ToolCard api={{} as ApiClient} sessionId="session-1" metadata={null}
        terminalToolDisplayMode="compact" disabled={false} onDone={() => {}} block={value} /></I18nProvider>
}

describe('CodexAgent inline replies', () => {
    it('shows the latest direct reply as Markdown, including a proposed plan', () => {
        render(card(block([text('old', 'Earlier answer'), text('plan', '# Proposed plan\n\n1. Inspect\n2. **Validate**')])))
        expect(screen.getByRole('heading', { name: 'Proposed plan' })).toBeInTheDocument()
        expect(screen.getByText('Validate').tagName).toBe('STRONG')
        expect(screen.queryByText('Earlier answer')).not.toBeInTheDocument()
    })

    it('updates the preview when another turn adds a newer reply', () => {
        const first = text('first', 'First reply')
        const { rerender } = render(card(block([first])))
        expect(screen.getByText('First reply')).toBeInTheDocument()
        rerender(card(block([first, text('second', 'Newer reply')])))
        expect(screen.getByText('Newer reply')).toBeInTheDocument()
        expect(screen.queryByText('First reply')).not.toBeInTheDocument()
    })

    it('shows the running agent’s own latest message without borrowing a nested agent reply', () => {
        const nested = block([text('other', 'Another agent reply')])
        nested.id = 'nested-agent'
        render(card(block([text('own', 'Own progress'), nested], 'running')))
        expect(screen.getByText('Own progress')).toBeInTheDocument()
        expect(screen.queryByText('Another agent reply')).not.toBeInTheDocument()
    })

    it('does not synthesize a reply from tools, reasoning, or nested child messages', () => {
        const nested = block([text('other', 'Another agent reply')])
        nested.id = 'nested-agent'
        const reasoning: ChatBlock = { kind: 'agent-reasoning', id: 'reasoning', localId: null, createdAt: 1, text: 'Internal thoughts' }
        const value = block([nested, reasoning])
        expect(getLatestCodexAgentReply(value)).toBeNull()
        render(card(value))
        expect(screen.queryByText('Another agent reply')).not.toBeInTheDocument()
        expect(screen.queryByText('Internal thoughts')).not.toBeInTheDocument()
    })

    it('ignores empty newer text and does not use replies from a different tool kind', () => {
        const value = block([text('answer', 'Answer'), text('empty', ' \n ')])
        expect(getLatestCodexAgentReply(value)?.id).toBe('answer')
        expect(getLatestCodexAgentReply({ ...value, tool: { ...value.tool, name: 'wait_agent' } })).toBeNull()
    })

    it('starts long replies expanded and allows native disclosure collapse without nested buttons', () => {
        const long = '# Detailed plan\n\n' + 'Step details. '.repeat(200)
        const { container } = render(card(block([text('long', long)])))
        const details = container.querySelector('details')!
        expect(details).toHaveAttribute('open')
        expect(within(details).getByRole('heading', { name: 'Detailed plan' })).toBeInTheDocument()
        const summary = details.querySelector('summary')!
        expect(summary.closest('button, [role="button"]')).toBeNull()
        fireEvent.click(summary)
        expect(details).not.toHaveAttribute('open')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('lets Markdown links keep their own interactions', () => {
        render(card(block([text('link', '[Reference](https://example.com/plan)')])))
        const link = screen.getByRole('link', { name: 'Reference' })
        expect(link).toHaveAttribute('href', 'https://example.com/plan')
        expect(link.closest('button, [role="button"]')).toBeNull()
    })

    it('keeps the full trace available in the detail dialog', () => {
        render(card(block([text('old', 'Earlier answer'), text('latest', 'Latest answer')])))
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByRole('button', { name: /Earlier answer/ })).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: /Earlier answer/ }))
        expect(within(dialog).getAllByText('Earlier answer').length).toBeGreaterThan(1)
        expect(within(dialog).getByRole('button', { name: /Latest answer/ })).toBeInTheDocument()
    })

    it('does not duplicate the inline reply in the dialog input view', () => {
        const View = getToolViewComponent('CodexAgent')!
        render(<I18nProvider><View block={block([text('answer', 'Reply body')])} metadata={null} surface="dialog" /></I18nProvider>)
        expect(screen.getAllByText('Review the proposed plan').length).toBeGreaterThan(0)
        expect(screen.queryByText('Reply body')).not.toBeInTheDocument()
    })
})


it.each(['ExitPlanMode', 'exit_plan_mode'])('shows direct child %s plan Markdown and switches to newer text replies', (name) => {
    const plan = block()
    plan.id = 'child-plan'
    plan.tool = { ...plan.tool, name, input: { plan: '# Agent plan\n\n1. **Check evidence**' } }
    const first = block([text('earlier', 'Earlier response'), plan])
    const { rerender } = render(card(first))
    expect(screen.getByRole('heading', { name: 'Agent plan' })).toBeInTheDocument()
    expect(screen.getByText('Check evidence').tagName).toBe('STRONG')
    expect(screen.queryByText('Earlier response')).not.toBeInTheDocument()
    rerender(card(block([...first.children, text('later', 'Plan execution complete')])))
    expect(screen.getByText('Plan execution complete')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Agent plan' })).not.toBeInTheDocument()
})

it('does not display an unrelated nested agent plan as the parent reply', () => {
    const plan = block()
    plan.id = 'other-plan'
    plan.tool = { ...plan.tool, name: 'ExitPlanMode', input: { plan: '# Other plan' } }
    const nested = block([plan])
    nested.id = 'other-agent'
    const parent = block([text('own', 'Parent reply'), nested])
    render(card(parent))
    expect(screen.getByText('Parent reply')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Other plan' })).not.toBeInTheDocument()
})
