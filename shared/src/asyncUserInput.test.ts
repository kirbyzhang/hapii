import { describe, expect, it } from 'bun:test'
import { AsyncQuestionAnswerSchema, normalizeAsyncUserInputQuestions } from './asyncUserInput'

describe('Codex async user input', () => {
    it('normalizes titles and string choices without inventing native request IDs', () => {
        expect(normalizeAsyncUserInputQuestions([{ title: 'Choose', options: ['One', 'Two'] }, { title: 'Explain' }])).toEqual([
            { id: 'q0', question: 'Choose', isOther: true, options: [{ label: 'One', description: '' }, { label: 'Two', description: '' }] },
            { id: 'q1', question: 'Explain', isOther: true, options: [] }
        ])
    })
    it('keeps question indices stable when ignoring malformed entries', () => {
        expect(normalizeAsyncUserInputQuestions([null, { title: ' ' }, { title: 'Valid', options: [' ', 1, 'Yes'] }])).toEqual([
            { id: 'q2', question: 'Valid', isOther: true, options: [{ label: 'Yes', description: '' }] }
        ])
    })
    it('rejects an invalid answer envelope', () => {
        expect(AsyncQuestionAnswerSchema.safeParse({ questionId: '', answers: {} }).success).toBe(false)
        expect(AsyncQuestionAnswerSchema.safeParse({ questionId: 'question', answers: { q0: { answers: [1] } } }).success).toBe(false)
    })
})
