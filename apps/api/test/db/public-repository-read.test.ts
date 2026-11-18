import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { createDatabase } from '../../src/persistence/database.js';
import { createRunRepository, type Run } from '../../src/persistence/run-repository.js';
import { createRunStepRepository } from '../../src/persistence/run-step-repository.js';
import { createAtomicRunFinalizer } from '../../src/persistence/atomic-run-finalizer.js';
import { createRunContinueRecorder } from '../../src/persistence/run-continue-recorder.js';
import { createRunToolStepRecorder } from '../../src/persistence/run-tool-step-recorder.js';
import { runBoundedToolDecisions, type BoundedToolRuntimeDependencies } from '../../src/runtime/run-bounded-tool-decisions.js';
import { createPublicReadWithTransport, type PublicReadTransport } from '../../src/tools/public-repository-read-internal.js';
import { decision, upstream, success, deferred, bounded, withLoopback } from '../public-repository-read-fixture.js';
import { assertDatabaseIdentity, readDatabaseUrl } from '../../../../db/connection.js';
import { migrate } from '../../../../db/migrate.js';

interface Fixture {
  schema: string;
  pool: Pool;
  client: PoolClient;
  db: { connect(): Promise<PoolClient> };
}
async function withSchema(work: (fixture: Fixture) => Promise<void>) {
  const pool = createDatabase(readDatabaseUrl('test'));
  const schema = `axiom_test_${randomUUID().replaceAll('-', '')}`;
  let client: PoolClient | undefined;
  let created = false;
  try {
    client = await pool.connect();
    await assertDatabaseIdentity(client, 'test');
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("SET statement_timeout TO '5s'");
    await migrate('test', 'up', schema);
    const db = { async connect() {
      const connection = await pool.connect();
      try {
        await assertDatabaseIdentity(connection, 'test');
        await connection.query(`SET search_path TO "${schema}"`);
        await connection.query("SET statement_timeout TO '5s'");
        return connection;
      } catch (error) { connection.release(true); throw error; }
    } };
    await work({ schema, pool, client, db });
    expect((await client.query('SELECT * FROM run_tool_results')).rowCount).toBe(0);
    expect((await client.query('SELECT * FROM pgmigrations')).rowCount).toBe(9);
    expect(pool.totalCount - pool.idleCount).toBe(1);
  } finally {
    try { if (created) await client!.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { client?.release(); await pool.end(); }
  }
}
async function checkGet(client: PoolClient, created: Run, status: string) {
  const app = buildApp({ repository: createRunRepository(client), logger: false });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/runs/${created.id}`, { signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...created, status, createdAt: created.createdAt.toISOString() });
  } finally { await app.close(); }
}

const budgets = { maxDecisions: 3, maxToolExecutions: 1 };
const final = { kind: 'final', content: 'done' };
function runtime(client: PoolClient, db: Fixture['db'], transport: PublicReadTransport, permitExecution = () => true) {
  const decide = vi.fn<BoundedToolRuntimeDependencies['decide']>().mockReturnValueOnce(decision).mockReturnValue(final);
  const deps = {
    repository: createRunRepository(client), finalizer: createAtomicRunFinalizer(db),
    continueRecorder: createRunContinueRecorder(db), toolRecorder: createRunToolStepRecorder(db),
    executor: createPublicReadWithTransport({ permitExecution }, transport), decide,
  };
  return { deps, decide };
}
const respond: Parameters<typeof withLoopback>[1] = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...upstream, description: 'UPSTREAM_SECRET' })); };
async function kinds(db: Fixture['db'], id: string) { return (await createRunStepRepository(db).listRunSteps(id))!.map(s => s.resultKind); }

describe('offline PostgreSQL public read Runtime integration', () => {
  it.each(['tool-final','tool-continue-final'])('%s commits metadata and delivers projection once, never stores output', async mode => withSchema(async ({ client, db }) => {
    await withLoopback(async f => {
      const created = await createRunRepository(client).createRun('TASK_SECRET'); const w = runtime(client, db, f.transport);
      w.decide.mockReset().mockImplementation(async (_run, context) => {
        const call = w.decide.mock.calls.length;
        if (call === 1) { expect(context).toEqual({ kind: 'none' }); return decision; }
        if (call === 2) {
          expect(context).toEqual({ kind: 'tool_result', outcome: success }); expect(Object.isFrozen(context)).toBe(true);
          expect(await kinds(db, created.id)).toEqual(['tool_succeeded']);
          if (mode === 'tool-continue-final') return { kind: 'continue' };
        } else expect(context).toEqual({ kind: 'none' });
        return final;
      });
      expect(await runBoundedToolDecisions(created.id, w.deps, budgets)).toEqual({ kind: 'completed', content: 'done' });
      expect(await kinds(db, created.id)).toEqual(mode === 'tool-final' ? ['tool_succeeded','completed'] : ['tool_succeeded','continued','completed']);
      expect(f.attempts()).toBe(1); expect(f.requests).toHaveLength(1); expect(JSON.stringify(f.requests)).not.toContain('SECRET');
      await checkGet(client, created, 'completed');
      expect(JSON.stringify((await client.query('SELECT * FROM run_steps')).rows)).not.toMatch(/SECRET|nodejs|stars|forks/);
    }, respond);
  }));
  it('two distinct backend PIDs race to claim the same Run, only one sends HTTP', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('TASK_SECRET'); const clients: PoolClient[] = [];
    try {
      clients.push(await db.connect()); clients.push(await db.connect());
      const pids = await Promise.all(clients.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)); expect(pids[0]).not.toBe(pids[1]);
      await withLoopback(async f => {
        const workers = clients.map(c => runtime(c, db, f.transport));
        const results = await Promise.all(workers.map(w => runBoundedToolDecisions(created.id, w.deps, budgets)));
        expect(results.map(r => r.kind).sort()).toEqual(['completed','not_started']); expect(f.attempts()).toBe(1); expect(f.requests).toHaveLength(1);
        expect(workers.reduce((n,w) => n + w.decide.mock.calls.length, 0)).toBe(2); await checkGet(client, created, 'completed');
        console.info(JSON.stringify({ publicReadClaimPids: pids, results: results.map(r => r.kind), requests: f.attempts() }));
      }, respond);
    } finally { clients.forEach(c => c.release()); }
  }));
  it.each(['deny','network','body'])('%s produces one atomic failed terminal Step', async mode => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('TASK_SECRET');
    await withLoopback(async f => {
      const w = runtime(client, db, f.transport, () => mode !== 'deny');
      expect(await runBoundedToolDecisions(created.id, w.deps, budgets)).toEqual({ kind: 'tool_failed', code: mode === 'deny' ? 'execution_unavailable' : mode === 'body' ? 'invalid_tool_output' : 'handler_error' });
      expect(await kinds(db, created.id)).toEqual(['tool_failed']); expect(w.decide).toHaveBeenCalledTimes(1); expect(f.attempts()).toBe(mode === 'deny' ? 0 : 1);
      await checkGet(client, created, 'failed');
    }, (req, res) => { if (mode === 'network') req.socket.destroy(); else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"secret":"UPSTREAM_SECRET"}'); } });
  }));
  it('observes external terminal state before execute and sends zero HTTP', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('TASK_SECRET');
    await withLoopback(async f => {
      const w = runtime(client, db, f.transport); w.decide.mockReset().mockImplementation(async () => {
        expect(await createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id, 'completed')).not.toBeNull(); return decision;
      });
      expect(await runBoundedToolDecisions(created.id, w.deps, budgets)).toEqual({ kind: 'finalize_conflict' });
      expect(f.attempts()).toBe(0); expect(await kinds(db, created.id)).toEqual(['completed']); expect(w.decide).toHaveBeenCalledTimes(1);
    }, respond);
  }));
  it.each(['success','failure'])('external finish during HTTP %s preserves terminal state without implicit abort or next decide', async mode => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('TASK_SECRET'); const arrived = deferred(); const release = deferred();
    await withLoopback(async f => {
      let signal: AbortSignal | null | undefined;
      const transport: PublicReadTransport = (url, init) => { signal = init.signal; return f.transport(url, init); };
      const w = runtime(client, db, transport); const pending = runBoundedToolDecisions(created.id, w.deps, budgets);
      try {
        await bounded(arrived.promise);
        // Completes on another connection while HTTP is blocked: no parent lock
        // or transaction spans the network, and DB finish does not abort HTTP.
        expect(await bounded(createAtomicRunFinalizer(db).tryFinalizeWithStep(created.id,'completed'))).not.toBeNull();
        expect(signal!.aborted).toBe(false); release.resolve();
        expect(await bounded(pending)).toEqual({ kind: 'finalize_conflict' });
        expect(await kinds(db, created.id)).toEqual(['completed']); expect(w.decide).toHaveBeenCalledTimes(1); expect(f.attempts()).toBe(1); await checkGet(client, created, 'completed');
      } finally { release.resolve(); await Promise.allSettled([pending]); }
    }, (_req, res) => {
      arrived.resolve(); void release.promise.then(() => { res.writeHead(mode === 'failure' ? 503 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(upstream)); });
    });
  }));
  it('blocks the next decide until the real Tool Step COMMIT acknowledgement', async () => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('commit barrier'); const reached = deferred(); const release = deferred();
    await withLoopback(async f => {
      const w = runtime(client, db, f.transport);
      w.deps.toolRecorder = createRunToolStepRecorder({ connect: async () => { const c = await db.connect(); return {
        query: (async (sql: string, values?: unknown[]) => { if (sql === 'COMMIT') { reached.resolve(); await bounded(release.promise); } return c.query(sql, values); }) as PoolClient['query'], release: c.release.bind(c),
      }; } });
      const pending = runBoundedToolDecisions(created.id, w.deps, budgets);
      try {
        await bounded(reached.promise); expect(w.decide).toHaveBeenCalledTimes(1); expect(await kinds(db, created.id)).toEqual([]); release.resolve();
        expect(await bounded(pending)).toEqual({ kind: 'completed', content: 'done' }); expect(w.decide).toHaveBeenCalledTimes(2); expect(f.attempts()).toBe(1);
      } finally { release.resolve(); await Promise.allSettled([pending]); }
    }, respond);
  }));
  it.each(['insert','commit','ack-loss'])('Tool Step %s failure never reissues HTTP or advances decide', async stage => withSchema(async ({ client, db }) => {
    const created = await createRunRepository(client).createRun('persistence failure');
    if (stage !== 'ack-loss') {
      await client.query("CREATE FUNCTION reject_tool_step() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.result_kind='tool_succeeded' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$");
      await client.query(stage === 'commit' ? 'CREATE CONSTRAINT TRIGGER reject_tool AFTER INSERT ON run_steps DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_tool_step()' : 'CREATE TRIGGER reject_tool AFTER INSERT ON run_steps FOR EACH ROW EXECUTE FUNCTION reject_tool_step()');
    }
    await withLoopback(async f => {
      const w = runtime(client, db, f.transport); let discard = false; let releases = 0;
      w.deps.toolRecorder = createRunToolStepRecorder({ connect: async () => { const c = await db.connect(); return {
        query: (async (sql: string, values?: unknown[]) => { const result = await c.query(sql, values); if (stage === 'ack-loss' && sql === 'COMMIT') throw new Error('Commit acknowledgement lost'); return result; }) as PoolClient['query'],
        release: (error?: Error | boolean) => { releases++; discard = Boolean(error); c.release(error); },
      }; } });
      await expect(runBoundedToolDecisions(created.id, w.deps, budgets)).rejects.toThrow();
      expect(f.attempts()).toBe(1); expect(f.requests).toHaveLength(1); expect(w.decide).toHaveBeenCalledTimes(1); expect(releases).toBe(1); expect(discard).toBe(stage !== 'insert');
      expect(await kinds(db, created.id)).toEqual(stage === 'ack-loss' ? ['tool_succeeded'] : []); await checkGet(client, created, 'running');
    }, respond);
  }));
});
