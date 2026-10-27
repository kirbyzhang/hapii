import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({ home: '', auth: 'token', processes: new Map<number, string | undefined>(), batches: [] as number[][], afterSnapshot: undefined as (() => void) | undefined }));
vi.mock('@/configuration', () => ({ configuration: { get happyHomeDir() { return state.home; }, apiUrl: 'hub', get cliApiToken() { return state.auth; } } }));
vi.mock('@/utils/process', () => ({ isProcessAlive: (pid: number) => state.processes.has(pid), getProcessStartMarker: (pid: number) => state.processes.get(pid),
    getProcessStartMarkers: (pids: number[]) => {
        state.batches.push(pids);
        const snapshot = new Map(pids.flatMap(pid => { const marker = state.processes.get(pid); return marker ? [[pid, marker] as const] : []; }));
        state.afterSnapshot?.();
        return snapshot;
    }
}));
import { filterRuntimesThatMayBeAlive, findRuntime, readRuntimes, runtimeAlive, runtimeAuthHash, runtimeMayBeAlive, saveRuntime, withThreadOwnership, type CodexRuntimeRecord } from './registry';

const directories: string[] = [];
afterEach(async () => { state.processes.clear(); state.batches.length = 0; state.afterSnapshot = undefined; state.auth = 'token'; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(): Promise<CodexRuntimeRecord> {
    const home = await mkdtemp(join(tmpdir(), 'hapi-owner-')); directories.push(home); state.home = join(home, 'hapi');
    return { id: 'owner', pid: 1111, marker: 'worker-start', serverPid: 2222, serverMarker: 'server-start', command: 'codex', args: [],
        codexHome: join(home, 'codex'), endpoint: 'unix://private', hub: 'hub', authHash: runtimeAuthHash(),
        sessions: { sid: { threadId: 'thread', namespace: 'ns', active: true } } };
}
describe('shared runtime ownership', () => {
    it('excludes a process that exits after its generation snapshot', async () => {
        const owner = await fixture();
        state.processes.set(owner.pid, owner.marker);
        state.afterSnapshot = () => state.processes.delete(owner.pid);
        expect(filterRuntimesThatMayBeAlive([owner])).toEqual([]);
        expect(state.batches).toEqual([[owner.pid]]);
    });
    it('protects a process born after the initial liveness scan with an unknown snapshot generation', async () => {
        const owner = await fixture();
        state.afterSnapshot = () => state.processes.set(owner.pid, 'new-generation');
        expect(filterRuntimesThatMayBeAlive([owner])).toEqual([owner]);
        expect(state.batches).toEqual([[]]);
    });
    it('batch filtering preserves dead, reused, unknown, live and orphan-engine decisions', async () => {
        const base = await fixture();
        const owners = Array.from({ length: 6 }, (_, index) => ({ ...base, id: `owner-${index}`, pid: 100 + index, serverPid: 200 + index }));
        state.processes.set(101, 'reused'); state.processes.set(201, 'reused-engine');
        state.processes.set(102, undefined);
        state.processes.set(103, base.marker);
        state.processes.set(204, base.serverMarker);
        state.processes.set(105, 'reused'); state.processes.set(205, undefined);
        const expected = owners.filter(runtimeMayBeAlive);
        expect(filterRuntimesThatMayBeAlive(owners)).toEqual(expected);
        expect(expected.map(owner => owner.id)).toEqual(['owner-2', 'owner-3', 'owner-4', 'owner-5']);
        expect(state.batches).toHaveLength(1);
        expect(state.batches[0]).not.toContain(100);
        expect(state.batches[0]).toContain(204);
    });
    it('keeps a live engine with an unknown stored generation while its wrapper is dead', async () => {
        const owner = await fixture(); delete owner.serverMarker;
        state.processes.set(owner.serverPid!, 'known-engine-generation');
        expect(filterRuntimesThatMayBeAlive([owner])).toEqual([owner]);
    });
    it('distinguishes PID reuse from an unknown generation and a live orphan engine', async () => {
        const owner = await fixture(); state.processes.set(1111, 'different-start');
        expect(runtimeAlive(owner)).toBe(false); expect(runtimeMayBeAlive(owner)).toBe(false);
        state.processes.set(1111, undefined); expect(runtimeMayBeAlive(owner)).toBe(true);
        state.processes.delete(1111); state.processes.set(2222, 'server-start'); expect(runtimeMayBeAlive(owner)).toBe(true);
        await saveRuntime(owner);
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('orphaned');
    });
    it('protects one native store even across HAPI homes and scopes attach by authentication', async () => {
        const owner = await fixture(); state.processes.set(1111, owner.marker); await saveRuntime(owner);
        expect(await findRuntime('sid')).toMatchObject({ id: owner.id });
        state.auth = 'other'; expect(await findRuntime('sid')).toBeUndefined();
        state.home = join(directories[0], 'different-hapi');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('hapi resume sid');
        state.processes.clear(); expect(await withThreadOwnership(owner.codexHome, 'thread', 'new', async () => 'safe')).toBe('safe');
    });
    it('fails closed on corrupt records and unknown thread IDs after a creation timeout', async () => {
        const owner = await fixture(); owner.pendingCreations = ['unbound']; state.processes.set(1111, owner.marker); await saveRuntime(owner);
        await expect(withThreadOwnership(owner.codexHome, 'unknown-thread', 'new', async () => {})).rejects.toThrow('unconfirmed creation');
        const directory = join(owner.codexHome, 'hapi-runtime-owners'); await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'broken.json'), '{');
        await expect(withThreadOwnership(owner.codexHome, 'thread', 'new', async () => {})).rejects.toThrow('Cannot verify');
    });
    it('readRuntimes({ strict: true }) fails closed on corrupt hub registry files', async () => {
        // Soft [] would let stopSession argv-sweep tree-kill shared wrappers (#1911).
        const owner = await fixture();
        const directory = join(state.home, 'codex-runtimes');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'broken.json'), '{');
        expect(await readRuntimes()).toEqual([]);
        await expect(readRuntimes({ strict: true })).rejects.toThrow('Cannot verify');
    });
});
