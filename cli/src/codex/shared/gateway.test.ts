import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CodexAppServerClient } from '../codexAppServerClient';
import { startCodexGateway, type Envelope } from './gateway';

async function fixture(after: (request: Envelope, response: Envelope, connection: string) => Promise<void>) {
    const engine = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>(resolve => engine.once('listening', resolve));
    const connections = new Map<WebSocket, Envelope[]>();
    engine.on('connection', client => {
        connections.set(client, []);
        client.on('message', raw => {
            const request = JSON.parse(raw.toString()) as Envelope;
            connections.get(client)!.push(request);
            client.send(JSON.stringify({ id: request.id, result: { thread: { id: String(request.params) } } }));
        });
    });
    const port = (engine.address() as { port: number }).port;
    const before = vi.fn(async (value: Envelope) => value);
    const gateway = await startCodexGateway({ upstream: `ws://127.0.0.1:${port}`, token: 'secret', hooks: {
        before, after, control: async () => ({})
    } });
    const clients: WebSocket[] = [];
    const connect = async () => {
        const client = new WebSocket(gateway.endpoint, { headers: { Authorization: 'Bearer secret' } }); clients.push(client);
        await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject); }); return client;
    };
    return { gateway, connect, before, upstream: `ws://127.0.0.1:${port}`, async close() {
        for (const client of clients) client.terminate(); await gateway.close();
        for (const client of engine.clients) client.terminate();
        await new Promise<void>(resolve => engine.close(() => resolve()));
    } };
}
describe('native gateway barriers', () => {
    it.each(process.platform === 'win32' ? ['tcp'] : ['tcp', 'unix'])(
        'closes active %s connections under Bun and stops accepting clients',
        async transport => {
            // Vitest runs in Node. Run the real gateway in Bun to catch its
            // HTTP close callback hanging after an upgraded socket terminates.
            // Keep the mock upstream in this Node process: old Bun has the same
            // shutdown bug when it hosts the mock WebSocket server itself.
            const f = await fixture(async () => {});
            const directory = await mkdtemp(join(tmpdir(), 'gw-'));
            const socketPath = transport === 'unix' ? join(directory, 'g') : undefined;
            const gatewayModule = new URL('./gateway.ts', import.meta.url).href;
            const script = `
                import assert from 'node:assert/strict';
                import { existsSync } from 'node:fs';
                import WebSocket from 'ws';
                const { startCodexGateway, socketUrl } = await import(${JSON.stringify(gatewayModule)});
                const path = ${JSON.stringify(socketPath) ?? 'undefined'};
                const gateway = await startCodexGateway({
                    upstream: ${JSON.stringify(f.upstream)}, token: 'test-only', path,
                    hooks: { before: async value => value, after: async () => {}, control: async () => ({}) }
                });
                const client = new WebSocket(socketUrl(gateway.endpoint), {
                    headers: { Authorization: 'Bearer test-only' }
                });
                client.on('error', () => {});
                const clientClosed = new Promise(resolve => client.once('close', resolve));
                await new Promise((resolve, reject) => {
                    client.once('open', resolve); client.once('error', reject);
                });
                const reply = new Promise(resolve => client.once('message', raw => resolve(JSON.parse(raw.toString()))));
                client.send(JSON.stringify({ id: 1, method: 'thread/read', params: 'round-trip' }));
                assert.deepEqual(await reply, { id: 1, result: { thread: { id: 'round-trip' } } });
                assert.equal(client.readyState, WebSocket.OPEN);
                await gateway.close();
                await clientClosed;
                assert.equal(client.readyState, WebSocket.CLOSED);
                if (path) assert.equal(existsSync(path), false);
                const reconnect = new WebSocket(socketUrl(gateway.endpoint), {
                    headers: { Authorization: 'Bearer test-only' }
                });
                // Bun can emit more than one error for a failed connection.
                reconnect.on('error', () => {});
                await new Promise((resolve, reject) => {
                    reconnect.once('error', resolve);
                    reconnect.once('open', () => {
                        reconnect.terminate(); reject(new Error('Gateway accepted a client after close'));
                    });
                });
                console.log(JSON.stringify({ roundTrip: true, clientClosed: true, reconnectRejected: true }));
            `;
            try {
                expect(process.env.HAPI_BUN_EXEC).toBeTruthy();
                const { stdout } = await promisify(execFile)(process.env.HAPI_BUN_EXEC!, ['--eval', script], {
                    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
                    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HAPI_HOME: directory },
                    // A hung old gateway must fail, rather than leave a child
                    // alive. Success still requires all explicit checks above.
                    timeout: 8_000,
                });
                expect(JSON.parse(stdout.trim())).toEqual({
                    roundTrip: true, clientClosed: true, reconnectRejected: true,
                });
            } finally {
                await f.close();
                await rm(directory, { recursive: true, force: true });
            }
        },
        15_000,
    );

    it('round-trips payloads larger than 64 MiB through the gateway and app-server client', async () => {
        const f = await fixture(async () => {});
        const client = new CodexAppServerClient({ endpoint: f.gateway.endpoint, token: 'secret' });
        try {
            await client.connect();
            await client.initialize({ clientInfo: { name: 'large-history-test', version: '1.0.0' }, capabilities: null });
            // Exercises all three receivers: gateway downstream, gateway upstream,
            // and CodexAppServerClient. A small request afterwards checks usability.
            const payload = 'x'.repeat(65 * 1024 * 1024);
            const response = await client.request<{ thread: { id: string } }>('thread/read', payload);
            expect(response.thread.id.length).toBe(payload.length);
            expect(response.thread.id === payload).toBe(true);
            const next = await client.request<{ thread: { id: string } }>('thread/read', 'small');
            expect(next.thread.id).toBe('small');
        } finally {
            await client.disconnect();
            await f.close();
        }
    }, 30_000);

    it('namespaces colliding native request IDs by connection and withholds replies until binding', async () => {
        let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
        const after = vi.fn(async () => { await barrier; }); const f = await fixture(after);
        try {
            const first = await f.connect(); const second = await f.connect(); const replies: unknown[] = [];
            first.on('message', value => replies.push(value)); second.on('message', value => replies.push(value));
            first.send(JSON.stringify({ id: 1, method: 'thread/start', params: 'a' }));
            second.send(JSON.stringify({ id: 1, method: 'thread/start', params: 'b' }));
            await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2)); expect(replies).toHaveLength(0);
            const calls = after.mock.calls as unknown as Array<[Envelope, Envelope, string]>;
            expect(calls[0][2]).not.toBe(calls[1][2]); release();
            await vi.waitFor(() => expect(replies).toHaveLength(2));
        } finally { release(); await f.close(); }
    });
    it('finishes a dispatched lifecycle even when its terminal detaches before the response', async () => {
        let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
        const bound = vi.fn(); const f = await fixture(async () => { await barrier; bound(); });
        try {
            const client = await f.connect(); client.send(JSON.stringify({ id: 1, method: 'thread/start', params: 'a' }));
            await vi.waitFor(() => expect(f.before).toHaveBeenCalled()); client.close(); release();
            await vi.waitFor(() => expect(bound).toHaveBeenCalledOnce());
        } finally { release(); await f.close(); }
    });
    it('rejects unauthenticated loopback connections', async () => {
        const f = await fixture(async () => {});
        try {
            const client = new WebSocket(f.gateway.endpoint);
            const response = await new Promise<number>(resolve => {
                client.on('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); client.terminate(); });
                client.on('error', () => {});
            });
            expect(response).toBe(401);
        } finally { await f.close(); }
    });
});
