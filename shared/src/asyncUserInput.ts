import { z } from 'zod'

/** An answer is a user message, never a native tool permission response. */
export const AsyncQuestionAnswerSchema = z.object({
    questionId: z.string().min(1),
    answers: z.record(z.string().min(1), z.object({ answers: z.array(z.string()) }))
})

export type AsyncQuestionAnswer = z.infer<typeof AsyncQuestionAnswerSchema>

export function asyncQuestionAnswerLocalId(questionId: string): string {
    return `codex-async-answer:${questionId}`
}

export type AsyncUserInputQuestion = {
    id: string
    question: string
    isOther: boolean
    options: Array<{ label: string; description: string }>
}

/** Codex async questions have titles and string options, with no native IDs. */
export function normalizeAsyncUserInputQuestions(value: unknown): AsyncUserInputQuestion[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((question: unknown, index) => {
        if (!question || typeof question !== 'object') return []
        const raw = question as Record<string, unknown>
        if (typeof raw.title !== 'string' || !raw.title.trim()) return []
        const options = Array.isArray(raw.options)
            ? raw.options.filter((option): option is string => typeof option === 'string' && Boolean(option.trim()))
            : []
        return [{ id: `q${index}`, question: raw.title, isOther: true,
            options: options.map(label => ({ label, description: '' })) }]
    })
}
