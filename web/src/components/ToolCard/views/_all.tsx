import type { ComponentType } from 'react'
import type { ChatToolCall, ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { CodexDiffCompactView, CodexDiffFullView } from '@/components/ToolCard/views/CodexDiffView'
import { CodexPatchView } from '@/components/ToolCard/views/CodexPatchView'
import { EditView } from '@/components/ToolCard/views/EditView'
import { AskUserQuestionView } from '@/components/ToolCard/views/AskUserQuestionView'
import { RequestUserInputView } from '@/components/ToolCard/views/RequestUserInputView'
import { ExitPlanModeView } from '@/components/ToolCard/views/ExitPlanModeView'
import { CursorCreatePlanView } from '@/components/ToolCard/views/CursorCreatePlanView'
import { MultiEditFullView, MultiEditView } from '@/components/ToolCard/views/MultiEditView'
import { TodoWriteView } from '@/components/ToolCard/views/TodoWriteView'
import { UpdatePlanView } from '@/components/ToolCard/views/UpdatePlanView'
import { WriteView } from '@/components/ToolCard/views/WriteView'
import { GoalView } from '@/components/ToolCard/views/GoalView'
import { canShowGoalPreview, isGoalToolName } from '@/components/ToolCard/goalTools'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { useTranslation } from '@/lib/use-translation'
import { getInputStringAny } from '@/lib/toolInputUtils'
import {
    getCodexAgentFieldRows,
    getCodexAgentPrompt,
    summarizeCodexAgentResult
} from '@/components/ToolCard/codexAgents'

export type ToolViewProps = {
    block: ToolCallBlock
    metadata: SessionMetadataSummary | null
    surface?: 'inline' | 'dialog'
}

export type ToolViewComponent = ComponentType<ToolViewProps>

const SkillFullView: ToolViewComponent = ({ block }: ToolViewProps) => {
    const skillName = getInputStringAny(block.tool.input, ['skill'])
    return (
        <div className="text-sm text-[var(--app-fg)]">
            {skillName ?? 'Unknown skill'}
        </div>
    )
}

// Only direct child messages belong to this agent. Nested tool children can
// contain another agent's reply and must remain inside that agent's trace.
export function getLatestCodexAgentReply(block: ToolCallBlock): { id: string; text: string } | null {
    if (block.tool.name !== 'CodexAgent') return null
    for (let index = block.children.length - 1; index >= 0; index -= 1) {
        const child = block.children[index]
        if (child.kind === 'agent-text' && child.text.trim()) return child
        if (child.kind === 'tool-call' && (child.tool.name === 'ExitPlanMode' || child.tool.name === 'exit_plan_mode')) {
            const plan = getInputStringAny(child.tool.input, ['plan'])
            if (plan?.trim()) return { id: child.id, text: plan }
        }
    }
    return null
}

const CodexAgentView: ToolViewComponent = ({ block, surface }: ToolViewProps) => {
    const { t } = useTranslation()
    const reply = surface === 'inline' ? getLatestCodexAgentReply(block) : null
    const input = block.tool.input
    const rows = getCodexAgentFieldRows(block.tool.name, input)
    const prompt = getCodexAgentPrompt(input)
    const resultSummary = surface === 'inline'
        ? summarizeCodexAgentResult(block.tool.name, block.tool.result)
        : null

    return (
        <div className="flex flex-col gap-2 text-sm">
            {surface === 'dialog' && prompt ? (
                <div className="rounded-xl bg-[var(--app-subtle-bg)] px-3 py-2 text-[var(--app-fg)]">
                    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]">
                        Prompt
                    </div>
                    <div className="whitespace-pre-wrap break-words">{prompt}</div>
                </div>
            ) : null}
            {rows.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                    {rows.map((row) => (
                        <span
                            key={`${row.label}:${row.value}`}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
                        >
                            <span className="font-medium text-[var(--app-fg)]">{row.label}:</span>
                            <span className="truncate font-mono">{row.value}</span>
                        </span>
                    ))}
                </div>
            ) : null}
            {resultSummary ? (
                <div className="text-xs text-[var(--app-hint)]">{resultSummary}</div>
            ) : null}
            {reply ? (
                reply.text.length > 1200 || reply.text.split('\n').length > 16 ? (
                    <details key={reply.id} open className="rounded-xl border border-[var(--app-border)] p-3">
                        <summary className="cursor-pointer text-xs font-medium text-[var(--app-hint)]">
                            {t('tool.result')}
                        </summary>
                        <div className="mt-2 max-h-80 overflow-y-auto pr-1">
                            <MarkdownRenderer content={reply.text} />
                        </div>
                    </details>
                ) : (
                    <div className="rounded-xl border border-[var(--app-border)] px-3 py-2">
                        <MarkdownRenderer content={reply.text} />
                    </div>
                )
            ) : null}
        </div>
    )
}

export const toolViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    MultiEdit: MultiEditView,
    Write: WriteView,
    TodoWrite: TodoWriteView,
    update_plan: UpdatePlanView,
    CodexDiff: CodexDiffCompactView,
    CodexAgent: CodexAgentView,
    spawn_agent: CodexAgentView,
    send_input: CodexAgentView,
    send_message: CodexAgentView,
    resume_agent: CodexAgentView,
    followup_task: CodexAgentView,
    wait_agent: CodexAgentView,
    close_agent: CodexAgentView,
    interrupt_agent: CodexAgentView,
    list_agents: CodexAgentView,
    AskUserQuestion: AskUserQuestionView,
    ExitPlanMode: ExitPlanModeView,
    CursorAskQuestion: AskUserQuestionView,
    CursorCreatePlan: CursorCreatePlanView,
    ask_user_question: AskUserQuestionView,
    exit_plan_mode: ExitPlanModeView,
    request_user_input: RequestUserInputView
}

export const toolFullViewRegistry: Record<string, ToolViewComponent> = {
    Edit: EditView,
    MultiEdit: MultiEditFullView,
    Write: WriteView,
    CodexDiff: CodexDiffFullView,
    CodexPatch: CodexPatchView,
    CodexAgent: CodexAgentView,
    Skill: SkillFullView,
    spawn_agent: CodexAgentView,
    send_input: CodexAgentView,
    send_message: CodexAgentView,
    resume_agent: CodexAgentView,
    followup_task: CodexAgentView,
    wait_agent: CodexAgentView,
    close_agent: CodexAgentView,
    interrupt_agent: CodexAgentView,
    list_agents: CodexAgentView,
    AskUserQuestion: AskUserQuestionView,
    ExitPlanMode: ExitPlanModeView,
    CursorAskQuestion: AskUserQuestionView,
    CursorCreatePlan: CursorCreatePlanView,
    ask_user_question: AskUserQuestionView,
    exit_plan_mode: ExitPlanModeView,
    request_user_input: RequestUserInputView
}

export function getToolViewComponent(toolName: string, tool?: Pick<ChatToolCall, 'input' | 'result' | 'state'>): ToolViewComponent | null {
    if (isGoalToolName(toolName)) return tool && canShowGoalPreview(tool) ? GoalView : null
    return toolViewRegistry[toolName] ?? null
}

export function getToolFullViewComponent(toolName: string): ToolViewComponent | null {
    return toolFullViewRegistry[toolName] ?? null
}
