import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection, inputText } from './projection';
import { codexPlanProposalId } from './plan';
import { extractNotifySummary } from '@hapi/protocol/messages';

describe('shared history projection', () => {
    it.each([undefined, 'root'])('preserves async questions as durable non-permission cards (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const item = { id: 'question', type: 'agentMessage', text: 'Choose a value', delivery: 'async',
            questions: [{ title: 'Choose a value', options: ['One', 'Two'] }] };
        const params = { threadId: 'thread', turnId: 'turn', item };
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', params);
        const bodies = send.mock.calls.map(([body]) => parentThreadId ? body.message : body);
        expect(bodies).toHaveLength(3);
        expect(bodies.every(body => body.turn_id === 'turn')).toBe(true);
        expect(bodies[0]).toMatchObject({ type: 'message', message: 'Choose a value' });
        expect(bodies[1]).toMatchObject({ type: 'tool-call', name: 'request_user_input',
            callId: 'codex-async-question:thread:turn:question', input: { delivery: 'async', threadId: 'thread',
                questions: [{ id: 'q0', question: 'Choose a value', isOther: true,
                    options: [{ label: 'One', description: '' }, { label: 'Two', description: '' }] }] } });
        expect(bodies[1].input.parentThreadId).toBe(parentThreadId);
        expect(bodies[2]).toMatchObject({ type: 'tool-call-result', output: null });
        const original = [...send.mock.calls];
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        expect(send.mock.calls).toEqual(original);
    });
    it('retains ordinary text when async question data is malformed', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn',
            item: { id: 'question', type: 'agentMessage', text: 'Still readable', delivery: 'async', questions: [{ title: '' }] } });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toMatchObject({ type: 'message', message: 'Still readable' });
    });
    it('renders a question-only async item without an empty chat message', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn',
            item: { id: 'question', type: 'agentMessage', text: '', delivery: 'async', questions: [{ title: 'Your preference?' }] } });
        expect(send.mock.calls.map(([body]) => body.type)).toEqual(['tool-call', 'tool-call-result']);
        expect(send.mock.calls[0][0].input.questions[0].question).toBe('Your preference?');
    });
    it('restores a published async question during an active turn without settling streaming text', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const question = { id: 'question', type: 'agentMessage', text: 'Choose', delivery: 'async',
            questions: [{ title: 'Which option?', options: ['One', 'Two'] }] };
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [question,
            { id: 'stream', type: 'agentMessage', text: 'Partial' }] }] });
        expect(send.mock.calls.map(([body]) => body.type)).toEqual(['message', 'tool-call', 'tool-call-result']);
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: question });
        expect(send).toHaveBeenCalledTimes(3);
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn',
            item: { id: 'stream', type: 'agentMessage', text: 'Final' } });
        expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'message', message: 'Final' });
    });
    it.each([undefined, 'root'])('restores footer-only async questions without replaying compaction status (parent: %s)', async parentThreadId => {
        for (const phase of ['commentary', 'partial_answer']) {
            const send = vi.fn(); const sendEvent = vi.fn();
            const session = { getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
            const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
            const question = { id: 'question', type: 'agentMessage', phase, delivery: 'async',
                text: 'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"Finished"}',
                questions: [{ title: 'Which option?', options: ['One', 'Two'] }] };
            const params = { threadId: 'thread', turnId: 'turn', item: question };
            await projection.notification('item/completed', params);
            const live = send.mock.calls.slice();
            const bodies = live.map(([body]) => parentThreadId ? body.message : body);
            expect(bodies.map(body => body.type)).toEqual(['tool-call', 'tool-call-result']);
            expect(bodies.every(body => body.turn_id === 'turn')).toBe(true);
            expect(bodies[0]).toMatchObject({ name: 'request_user_input', input: { delivery: 'async',
                questions: [expect.objectContaining({ question: 'Which option?' })] } });
            projection.reset(); send.mockClear();
            await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [question,
                { id: 'compaction', type: 'contextCompaction', status: 'completed' },
                { id: 'stream', type: 'agentMessage', text: 'Partial' }] }] });
            expect(send.mock.calls.slice(0, live.length)).toEqual(live);
            expect(sendEvent).not.toHaveBeenCalled();
            const historyBodies = send.mock.calls.map(([body]) => parentThreadId ? body.message : body);
            expect(historyBodies.map(body => body.type)).toEqual(['tool-call', 'tool-call-result', 'context_compacted']);
            await projection.notification('item/completed', params);
            expect(send).toHaveBeenCalledTimes(3);
            await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn',
                item: { id: 'stream', type: 'agentMessage', text: 'Final' } });
            const last = send.mock.lastCall?.[0];
            expect(parentThreadId ? last.message : last).toMatchObject({ type: 'message', message: 'Final', turn_id: 'turn' });
        }
    });

    it.each([undefined, 'root'])('publishes only final summaries in live output and history replay (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const footer = 'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"Finished"}';
        const items = [
            { id: 'progress', type: 'agentMessage', phase: 'commentary', text: `Still working.\n${footer}` },
            { id: 'partial', type: 'agentMessage', phase: 'partial_answer', text: `More work.\n${footer}` },
            { id: 'footer-only', type: 'agentMessage', phase: 'commentary', text: footer },
            { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `Finished.\n${footer}` }
        ];
        for (const item of items) {
            await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
        }
        const live = send.mock.calls.slice();
        const bodies = live.map(([body]) => parentThreadId ? body.message : body);
        expect(bodies.map(body => body.message)).toEqual(['Still working.', 'More work.', `Finished.\n${footer}`]);
        expect(bodies.filter(body => extractNotifySummary(body.message))).toHaveLength(1);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items }] });
        expect(send.mock.calls).toEqual(live);
    });

    it('keeps plan cards distinct across native turns and stable within each turn', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        for (const turnId of ['first', 'second']) {
            for (const status of ['pending', 'completed']) {
                await projection.notification('turn/plan/updated', { threadId: 'thread', turnId,
                    plan: [{ step: 'work', status }] });
            }
        }
        for (const type of ['tool-call', 'tool-call-result']) {
            expect(send.mock.calls.map(([body]) => body).filter(body => body.type === type).map(body => body.callId)).toEqual([
                'codex-plan-state:first', 'codex-plan-state:first',
                'codex-plan-state:second', 'codex-plan-state:second'
            ]);
        }
    });

    it.each([undefined, 'root'])('persists proposals without approval and replays the same IDs (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const item = { id: 'plan', type: 'plan', text: '# Final plan' };
        const params = { threadId: 'thread', turnId: 'turn', item };
        await projection.notification('item/completed', { ...params, item: { id: 'before', type: 'agentMessage', text: 'Preface' } });
        await projection.notification('item/started', params);
        await projection.notification('item/plan/delta', { ...params, itemId: 'plan', delta: '# Provisional' });
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', { ...params, item: { id: 'after', type: 'agentMessage', text: 'Postscript' } });
        expect(send).toHaveBeenCalledTimes(4);
        const bodies = send.mock.calls.map(([body]) => parentThreadId ? body.message : body);
        const callId = codexPlanProposalId('thread', 'turn', 'plan');
        expect(bodies).toEqual([
            expect.objectContaining({ type: 'message', message: 'Preface' }),
            expect.objectContaining({ type: 'tool-call', name: 'ExitPlanMode', callId, input: { plan: '# Final plan' } }),
            expect.objectContaining({ type: 'tool-call-result', callId, output: null }),
            expect.objectContaining({ type: 'message', message: 'Postscript' })
        ]);
        const original = send.mock.calls.slice(1, 3);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        expect(send.mock.calls).toEqual(original);
    });

    it('waits for final proposal content after an active snapshot', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'plan', type: 'plan', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'plan', type: 'plan', text: 'final' } });
        expect(send.mock.calls[0][0]).toMatchObject({ input: { plan: 'final' } });
        expect(send.mock.calls[1][0]).toMatchObject({ output: null });
    });

    it.each([undefined, 'root'])('emits canonical error flags for tools (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        for (const failed of [true, false]) {
            for (const type of ['mcpToolCall', 'collabAgentToolCall']) {
                const item = { id: `${type}-${failed}`, type, server: 'test', tool: 'spawnAgent',
                    status: failed ? 'failed' : 'completed', error: failed ? { message: 'failed' } : null,
                    result: { Ok: 'done' } };
                await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
                const body = send.mock.lastCall?.[0];
                const result = parentThreadId ? body.message : body;
                expect(result).toMatchObject({ type: 'tool-call-result', is_error: failed });
                expect(result).not.toHaveProperty('isError');
            }
        }
    });
    it('persists a live duration once and never times history snapshots', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'old', status: 'completed', items: [{ id: 'old-answer', type: 'agentMessage', text: 'history' }] }] });
        await projection.notification('turn/completed', { threadId: 'thread', turn: { id: 'old', status: 'completed' } }, undefined, 5000);
        await projection.history({ turns: [{ id: 'already-running', status: 'inProgress', items: [] }] });
        await projection.notification('turn/completed', { threadId: 'thread', turn: { id: 'already-running', status: 'completed' } }, undefined, 6000);
        expect(send.mock.calls.map(([body]) => body).filter(body => body.type === 'turn_duration')).toEqual([]);
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'live' } }, undefined, 10_000);
        projection.reset();
        await projection.history({ turns: [{ id: 'live', status: 'inProgress', items: [] }] });
        await projection.notification('turn/completed', { threadId: 'thread', turn: { id: 'old', status: 'completed' } }, undefined, 15_000);
        await projection.notification('turn/completed', { threadId: 'thread', turn: { id: 'live', status: 'completed' } }, undefined, 49_426);
        await projection.notification('turn/completed', { threadId: 'thread', turn: { id: 'live', status: 'completed' } }, undefined, 50_000);
        expect(send.mock.calls.map(([body]) => body).filter(body => body.type === 'turn_duration')).toEqual([
            expect.objectContaining({ durationMs: 39_426, turn_id: 'live' })
        ]);
    });

    it('keeps each turn model through settings changes, reconnect replay and rerouting', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-a');
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'new' } }, 'model-b');
        projection.reset();
        // A replayed start must not rewrite the executing model either.
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-b');
        const usage = async (turnId: string) => projection.notification('thread/tokenUsage/updated', {
            threadId: 'thread', turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3 } }
        }, 'model-b');
        await usage('old');
        await projection.notification('model/rerouted', { threadId: 'thread', turnId: 'new', fromModel: 'model-b', toModel: 'model-c', reason: 'test' });
        await usage('new');
        const events = send.mock.calls.map(([body]) => body).filter(body => body.type === 'token_count');
        expect(events.map(body => body.model)).toEqual(['model-a', 'model-c']);
    });
    it('keeps image-only native inputs visible without embedding data URLs', () => {
        expect(inputText([{ type: 'image', url: 'data:image/png;base64,large' }])).toBe('[Image]');
        expect(inputText([{ type: 'localImage', path: '/tmp/image.png' }])).toBe('[Image: /tmp/image.png]');
    });
    it('replays after hub reconnect using the same durable local id', async () => {
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const snapshot = { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'complete' }] }] };
        await projection.history(snapshot); projection.reset(); await projection.history(snapshot);
        expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    });
    it('does not settle an active snapshot under the final message id', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'complete' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'complete' }), expect.any(String));
    });
    it('routes descendant answers into a scoped agent trace, not a root message', async () => {
        const send = vi.fn(); const user = vi.fn(); const committed = vi.fn(async () => {});
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendUserMessage: user } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', committed, 'root');
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'child answer' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-run-trace', agentId: 'child', message: expect.objectContaining({ message: 'child answer' }) }), expect.any(String));
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'child prompt' }], clientId: 'cid' } });
        expect(user).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    });

    it('announces parent compaction start via session event, deduping repeats', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const params = { threadId: 'thread', turnId: 'turn', item: { id: 'c1', type: 'contextCompaction' } };
        await projection.notification('item/started', params);
        await projection.notification('item/started', params);
        await projection.notification('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'c2', type: 'contextCompaction' } });
        expect(send).not.toHaveBeenCalled();
        expect(sendEvent.mock.calls).toEqual([
            [{ type: 'message', message: '📦 Compaction started' }],
            [{ type: 'message', message: '📦 Compaction started' }]
        ]);
    });
    it('keeps child compaction start as trace with statusText, never a parent status', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', async () => {}, 'root');
        await projection.notification('item/started', { threadId: 'child', turnId: 'turn', item: { id: 'c1', type: 'contextCompaction' } });
        expect(sendEvent).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
        const [body] = send.mock.calls[0];
        expect(body.type).toBe('agent-run-trace');
        expect(body.message.type).toBe('compaction_started');
        expect(body.message.statusText).toBe('📦 Compaction started');
    });
    it('emits live compaction start but not for completed history replay', async () => {
        const send = vi.fn(); const sendEvent = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendSessionEvent: sendEvent } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'completed',
            items: [{ id: 'c1', type: 'contextCompaction' }] }] });
        expect(sendEvent).not.toHaveBeenCalled();
        expect(send.mock.calls.map(([b]) => b).some((b) => b.message === '📦 Compaction started')).toBe(false);
        expect(send.mock.calls.map(([b]) => b)).toContainEqual(expect.objectContaining({ type: 'context_compacted' }));
        send.mockClear();
        await projection.notification('item/started', { threadId: 'thread', turnId: 'live', item: { id: 'c9', type: 'contextCompaction' } });
        expect(send).not.toHaveBeenCalled();
        expect(sendEvent).toHaveBeenCalledWith({ type: 'message', message: '📦 Compaction started' });
    });
});
