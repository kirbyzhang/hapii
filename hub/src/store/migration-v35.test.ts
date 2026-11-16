import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

describe('Store V34->V35 usage parser migration', () => {
    it('rolls back the parser column when cache clearing fails, then retries once without clearing fresh cache', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-migration-v35-'))
        const path = join(directory, 'test.db')
        let store: Store | undefined
        let db: Database | undefined
        try {
            store = new Store(path)
            const session = store.sessions.getOrCreateSession('session-1', { path: '/tmp', host: 'test', flavor: 'codex' }, null, 'default')
            store.close()
            store = undefined

            db = new Database(path, { readwrite: true, strict: true })
            db.exec('PRAGMA foreign_keys = ON')
            db.exec(`
                ALTER TABLE usage_scan_state DROP COLUMN parser_version;
                DROP TABLE session_redirects;
                PRAGMA user_version = 34;
            `)
            db.prepare('INSERT INTO usage_scan_state (session_id, message_epoch, last_seq) VALUES (?, 1, 42)').run(session.id)
            db.exec(`CREATE TRIGGER block_usage_scan_clear BEFORE DELETE ON usage_scan_state
                BEGIN SELECT RAISE(ABORT, 'injected usage cache clear failure'); END`)
            db.close()
            db = undefined

            expect(() => new Store(path)).toThrow('injected usage cache clear failure')
            db = new Database(path, { readwrite: true, strict: true })
            const columns = () => db!.prepare('PRAGMA table_info(usage_scan_state)').all() as Array<{ name: string; dflt_value: string | null }>
            expect(columns().some(column => column.name === 'parser_version')).toBe(false)
            expect(db.prepare('SELECT session_id, message_epoch, last_seq FROM usage_scan_state').all()).toEqual([
                { session_id: session.id, message_epoch: 1, last_seq: 42 },
            ])
            db.exec('DROP TRIGGER block_usage_scan_clear')
            db.close()
            db = undefined

            store = new Store(path)
            db = new Database(path, { readwrite: true, strict: true })
            expect(columns().find(column => column.name === 'parser_version')?.dflt_value).toBe('2')
            expect(db.prepare('SELECT COUNT(*) AS count FROM usage_scan_state').get()).toEqual({ count: 0 })
            expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 35 })
            expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_redirects'").get())
                .toEqual({ name: 'session_redirects' })
            expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_redirects_namespace_new'").get())
                .toEqual({ name: 'idx_session_redirects_namespace_new' })
            db.prepare('INSERT INTO usage_scan_state (session_id, message_epoch, last_seq) VALUES (?, 2, 99)').run(session.id)
            db.close()
            db = undefined
            store.close()
            store = undefined

            store = new Store(path)
            db = new Database(path, { readonly: true, strict: true })
            expect(db.prepare('SELECT session_id, message_epoch, last_seq, parser_version FROM usage_scan_state').all()).toEqual([
                { session_id: session.id, message_epoch: 2, last_seq: 99, parser_version: 2 },
            ])
        } finally {
            db?.close()
            store?.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
