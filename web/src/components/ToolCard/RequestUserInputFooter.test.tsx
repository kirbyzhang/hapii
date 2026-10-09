import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
            selection: vi.fn()
        }
    })
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key === 'tool.requestUserInput.otherLabel' ? '以上都不是' : key })
}))

import { RequestUserInputFooter } from './RequestUserInputFooter'

const choice = { id: 'choice', question: 'Choose', isOther: true, options: [{ label: 'Alpha' }, { label: 'Beta' }] }

function renderFooter(input: unknown = { questions: [choice] }) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const props = {
        api: { approvePermission } as unknown as ApiClient,
        sessionId: 'session-1', tool: makeTool(input), disabled: false, onDone: vi.fn()
    }
    return { ...render(<RequestUserInputFooter {...props} />), props, approvePermission }
}

function makeTool(input: unknown): ChatToolCall {
    return {
        id: 'request-1',
        name: 'request_user_input',
        state: 'pending',
        input,
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        permission: {
            id: 'permission-1',
            status: 'pending'
        }
    }
}

describe('RequestUserInputFooter', () => {
    it.each(['', ' \n ', '  自定义\n说明  '])('focuses notes without submitting and posts canonical values (%j)', async (note) => {
        const { approvePermission } = renderFooter()
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: /以上都不是/ }))
        expect(screen.getByRole('textbox')).toHaveFocus()
        expect(screen.getByRole('button', { name: /Alpha/ })).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByRole('button', { name: /以上都不是/ })).toHaveAttribute('aria-pressed', 'true')
        expect(approvePermission).not.toHaveBeenCalled()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: note } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { choice: { answers: ['None of the above', ...(note.trim() ? [`user_note: ${note.trim()}`] : [])] } }
        }))
    })

    it('retains notes across choices, questions, and SSE rerenders without auto-advancing', async () => {
        const { props, rerender, approvePermission } = renderFooter({ questions: [choice, { ...choice, id: 'second', question: 'Second' }] })
        fireEvent.click(screen.getByRole('button', { name: /以上都不是/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep this note' } })
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        expect(screen.getByRole('button', { name: /以上都不是/ })).toHaveAttribute('aria-pressed', 'false')
        expect(screen.getByRole('textbox')).toHaveValue('keep this note')
        fireEvent.click(screen.getByRole('button', { name: /以上都不是/ }))
        expect(screen.getByText('Choose')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        expect(screen.getByRole('textbox')).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: /Beta/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.prev' }))
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, input: structuredClone(props.tool.input) }} />)
        expect(screen.getByRole('textbox')).toHaveValue('keep this note')
        expect(screen.getByRole('button', { name: /以上都不是/ })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', {
            answers: { choice: { answers: ['None of the above', 'user_note: keep this note'] }, second: { answers: ['Beta'] } }
        }))
    })

    it('does not interpret a note alone as None of the above', () => {
        const { approvePermission } = renderFooter()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'custom' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(approvePermission).not.toHaveBeenCalled()
        expect(screen.getByText('tool.selectOption')).toBeInTheDocument()
    })

    it.each([false, undefined])('does not add other to Pi or MCP choices (%s)', (isOther) => {
        renderFooter({ questions: [{ ...choice, isOther }] })
        expect(screen.queryByRole('button', { name: /以上都不是/ })).not.toBeInTheDocument()
    })

    it('retains the answer on failure and removes controls when resolved elsewhere', async () => {
        const { props, rerender, approvePermission } = renderFooter()
        approvePermission.mockRejectedValueOnce(new Error('try again'))
        fireEvent.click(screen.getByRole('button', { name: /以上都不是/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await screen.findByText('try again')
        expect(screen.getByRole('textbox')).toHaveValue('draft')
        expect(screen.getByRole('button', { name: /以上都不是/ })).toHaveAttribute('aria-pressed', 'true')
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, permission: { id: 'permission-1', status: 'resolved' } }} />)
        expect(screen.queryByRole('button', { name: 'tool.submit' })).not.toBeInTheDocument()
        expect(approvePermission).toHaveBeenCalledTimes(1)
    })

    it('uses a Pi extension pure-text placeholder and prefill when initializing the request', () => {
        render(
            <RequestUserInputFooter
                api={{} as ApiClient}
                sessionId="session-1"
                tool={makeTool({
                    questions: [{
                        id: 'comment',
                        question: 'Comment',
                        options: [],
                        placeholder: 'Describe the change',
                        prefill: 'Initial draft'
                    }]
                })}
                disabled={false}
                onDone={vi.fn()}
            />
        )

        const textarea = screen.getByRole('textbox')
        expect(textarea).toHaveAttribute('placeholder', 'Describe the change')
        expect(textarea).toHaveValue('Initial draft')
    })
})

function asyncFooter(input: unknown = { delivery: 'async', questions: [choice] }) {
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const steerMessage = vi.fn().mockResolvedValue({ status: 'steered', localId: 'codex-async-answer:request-1' })
    const approvePermission = vi.fn()
    const props = {
        api: { sendMessage, steerMessage, approvePermission } as unknown as ApiClient,
        sessionId: 'session-1',
        tool: { ...makeTool(input), state: 'completed' as const, permission: undefined },
        disabled: false,
        onDone: vi.fn()
    }
    return { ...render(<RequestUserInputFooter {...props} />), props, sendMessage, steerMessage, approvePermission }
}

describe('Codex async questions', () => {
    it('sends a readable ordinary message with durable metadata instead of approving a permission', async () => {
        const { sendMessage, steerMessage, approvePermission } = asyncFooter()
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'and a note' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await screen.findByRole('status')
        expect(sendMessage).toHaveBeenCalledWith('session-1', 'Choose\nAlpha\nand a note',
            'codex-async-answer:request-1', undefined, undefined, undefined,
            { questionId: 'request-1', answers: { choice: { answers: ['Alpha', 'user_note: and a note'] } } })
        expect(approvePermission).not.toHaveBeenCalled()
        await waitFor(() => expect(steerMessage).toHaveBeenCalledWith('session-1', 'codex-async-answer:request-1'))
        expect(steerMessage).toHaveBeenCalledTimes(1)
        expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(steerMessage.mock.invocationCallOrder[0])
        expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerQueued')
        expect(screen.queryByRole('button', { name: 'tool.submit' })).not.toBeInTheDocument()
    })

    it('validates each question and sends multiple answers including pure text', async () => {
        const { sendMessage } = asyncFooter({ delivery: 'async', questions: [choice, { id: 'text', question: 'Explain', options: [] }] })
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        expect(screen.getByText('tool.selectOption')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Beta/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.next' }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(sendMessage).not.toHaveBeenCalled()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Custom answer  ' } })
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
        expect(sendMessage.mock.calls[0][1]).toBe('Choose\nBeta\n\nExplain\nCustom answer')
        expect(sendMessage.mock.calls[0][6]).toEqual({ questionId: 'request-1', answers: {
            choice: { answers: ['Beta'] }, text: { answers: ['user_note: Custom answer'] }
        } })
    })

    it('retains drafts on failure and reuses the same dedupe id when retrying', async () => {
        const { sendMessage } = asyncFooter()
        sendMessage.mockRejectedValueOnce(new Error('network failed'))
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await screen.findByText('network failed')
        expect(screen.getByRole('button', { name: /Alpha/ })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
        expect(sendMessage.mock.calls[0][2]).toBe(sendMessage.mock.calls[1][2])
    })

    it('does not send while disabled or while a request is in flight', async () => {
        const { props, rerender, sendMessage } = asyncFooter()
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        rerender(<RequestUserInputFooter {...props} disabled />)
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        expect(sendMessage).not.toHaveBeenCalled()
        rerender(<RequestUserInputFooter {...props} />)
        let finish!: () => void
        sendMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submitting' }))
        expect(sendMessage).toHaveBeenCalledTimes(1)
        finish()
        await screen.findByRole('status')
    })

    it('shows child questions without sending to the root thread', () => {
        const { sendMessage } = asyncFooter({ delivery: 'async', parentThreadId: 'root', questions: [choice] })
        expect(screen.getByText('tool.requestUserInput.childQuestion')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'tool.submit' })).not.toBeInTheDocument()
        expect(sendMessage).not.toHaveBeenCalled()
    })

    it('uses authoritative answer status and restores controls after queued cancellation', async () => {
        const { props, rerender, sendMessage } = asyncFooter()
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        await screen.findByRole('status')
        const asyncAnswer = { answers: { choice: { answers: ['Alpha'] } }, status: 'queued' as const }
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, asyncAnswer }} />)
        expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerQueued')
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, asyncAnswer: { ...asyncAnswer, status: 'indeterminate' } }} />)
        expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerIndeterminate')
        rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, asyncAnswer: { ...asyncAnswer, status: 'answered' } }} />)
        expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerSent')
        rerender(<RequestUserInputFooter {...props} />)
        expect(screen.getByRole('button', { name: 'tool.submit' })).toBeInTheDocument()
        expect(sendMessage).toHaveBeenCalledTimes(1)
    })
})


it('expires the local POST receipt if no durable row arrives', async () => {
    vi.useFakeTimers()
    try {
        const { sendMessage } = asyncFooter()
        fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
        })
        expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerQueued')
        act(() => { vi.advanceTimersByTime(10000) })
        expect(screen.getByRole('button', { name: 'tool.submit' })).toBeInTheDocument()
        expect(sendMessage).toHaveBeenCalledTimes(1)
    } finally {
        vi.useRealTimers()
    }
})

it('does not retain a local receipt if the durable row arrived before POST completed', async () => {
    const { props, rerender, sendMessage } = asyncFooter()
    let finish!: () => void
    sendMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
    const asyncAnswer = { answers: { choice: { answers: ['Alpha'] } }, status: 'queued' as const }
    rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, asyncAnswer }} />)
    await act(async () => finish())
    rerender(<RequestUserInputFooter {...props} />)
    expect(screen.getByRole('button', { name: 'tool.submit' })).toBeInTheDocument()
    expect(sendMessage).toHaveBeenCalledTimes(1)
})


it.each(['failed', 'throw'])('keeps a saved async answer queued after steer %s without resubmitting', async (outcome) => {
    const { props, rerender, sendMessage, steerMessage } = asyncFooter()
    if (outcome === 'throw') steerMessage.mockRejectedValueOnce(new Error('connection lost'))
    else steerMessage.mockResolvedValueOnce({ status: 'failed', error: 'agent idle', localId: 'codex-async-answer:request-1' })
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
    await waitFor(() => expect(props.onDone).toHaveBeenCalledTimes(1))
    rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, asyncAnswer: {
        status: 'queued', answers: { choice: { answers: ['Alpha'] } }
    } }} />)
    expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerQueued')
    expect(screen.queryByRole('button', { name: 'tool.submit' })).not.toBeInTheDocument()
    expect(screen.queryByText('connection lost')).not.toBeInTheDocument()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(steerMessage).toHaveBeenCalledTimes(1)
})

it('uses the durable invoked row after an idle answer was consumed before steering', async () => {
    const { props, rerender, sendMessage, steerMessage } = asyncFooter()
    steerMessage.mockResolvedValueOnce({ status: 'invoked', message: { invokedAt: 3 } })
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
    await waitFor(() => expect(props.onDone).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerQueued')
    rerender(<RequestUserInputFooter {...props} tool={{ ...props.tool, asyncAnswer: {
        status: 'answered', answers: { choice: { answers: ['Alpha'] } }
    } }} />)
    expect(screen.getByRole('status')).toHaveTextContent('tool.requestUserInput.answerSent')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(steerMessage).toHaveBeenCalledTimes(1)
})

it('does not steer when storing the async answer fails', async () => {
    const { sendMessage, steerMessage } = asyncFooter()
    sendMessage.mockRejectedValueOnce(new Error('save failed'))
    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))
    await screen.findByText('save failed')
    expect(steerMessage).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'tool.submit' })).toBeInTheDocument()
})
