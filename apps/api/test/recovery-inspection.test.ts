import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { createRunRecoveryInspectionRepository } from '../src/persistence/run-recovery-inspection-repository.js';

const id = randomUUID();
const row = { id, status: 'running', lease: 'active', schema_version: 1, checkpoint_version: 1,
  max_decisions: 3, decisions_reserved: 1, max_tool_attempts: 1, tool_attempts_reserved: 0,
  last_confirmed_step_no: null, progress_clock_ok: true, step_count: 0, max_step_no: null,
  terminal_count: 0, tool_successes: 0, last_kind: null };
function reader(rows: unknown[], rowCount = rows.length) {
  const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ command: 'SELECT', rows, rowCount }));
  const repo = createRunRecoveryInspectionRepository({ query: query as unknown as Pool['query'] });
  return { query, inspect: repo.inspectRunRecovery };
}

it('only an empty successful SELECT means missing; invalid input never queries', async () => {
  const r = reader([]);
  await expect(r.inspect('not a uuid')).rejects.toThrow('Invalid recovery Run ID');
  expect(r.query).not.toHaveBeenCalled();
  expect(await r.inspect(id.toUpperCase())).toEqual({ category: 'missing_run' });
  expect(r.query).toHaveBeenCalledTimes(1);
  const [sql, params] = r.query.mock.calls[0]!;
  expect(params).toEqual([id]);
  expect(sql.match(/clock_timestamp\(\)/gi)).toHaveLength(1);
  expect(sql).toContain('AS MATERIALIZED');
  expect(sql).not.toMatch(/\b(task|prompt|owner_id|lease_token|arguments|output|credentials|run_tool_results|insert|update|delete|merge|lock)\b|select\s+\*|for\s+(?:key\s+)?share|;/i);
});

it.each([
  ['gap', { step_count: 1, max_step_no: 2, last_kind: 'continued' }],
  ['future progress', { progress_clock_ok: false }],
  ['invalid lease interval', { lease: 'invalid_clock' }],
  ['lease missing', { lease: 'absent' }],
  ['impossible version', { checkpoint_version: 5 }],
  ['watermark beyond steps', { last_confirmed_step_no: 1, checkpoint_version: 2 }],
  ['queued with metadata', { status: 'queued' }],
  ['running with terminal', { step_count: 1, max_step_no: 1, terminal_count: 1, last_kind: 'completed' }],
  ['wrong final kind', { status: 'failed', step_count: 1, max_step_no: 1, terminal_count: 1, last_kind: 'completed' }],
  ['terminal missing', { status: 'completed' }],
  ['terminal watermark', { status: 'completed', step_count: 1, max_step_no: 1, terminal_count: 1, last_kind: 'completed', checkpoint_version: 2, last_confirmed_step_no: 1 }],
  ['multiple terminal steps', { status: 'completed', step_count: 2, max_step_no: 2, terminal_count: 2, last_kind: 'completed' }],
  ['terminal in prefix', { status: 'completed', step_count: 2, max_step_no: 2, terminal_count: 1, last_kind: 'continued' }],
] as const)('prioritizes manual review for %s', async (_, patch) => {
  expect(await reader([{ ...row, ...patch }]).inspect(id)).toMatchObject({ category: 'legacy_or_inconsistent_manual_review' });
});

it('preserves overlapping ambiguity, step evidence and lease expiry', async () => {
  expect(await reader([{ ...row, tool_attempts_reserved: 1, checkpoint_version: 2, lease: 'expired',
    step_count: 1, max_step_no: 1, last_kind: 'continued' }]).inspect(id)).toMatchObject({
    category: 'ambiguous_attempt_manual_review', lease: 'expired', ambiguousToolAttempt: true, unconfirmedNonterminalStep: true });
});

it('never turns corrupt projections into categories or leaks private errors', async () => {
  const trap = vi.fn((): never => { throw new Error('private'); });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const malformed = [reader([], 1), reader([row, row]), ...[
      { ...row, status: 'private' }, { ...row, id: randomUUID() }, { ...row, lease_token: 'private' },
      { ...row, last_kind: 'private' }, { ...row, tool_attempts_reserved: 2 }, { ...row, decisions_reserved: '0' },
      { ...row, step_count: 1, max_step_no: 1, last_kind: 'completed', terminal_count: 0 },
      { ...row, schema_version: null }, { ...row, progress_clock_ok: 'true' }, { ...row, get status() { return trap(); } },
      new Proxy(row, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
    ].map(raw => reader([raw]))];
    for (const r of malformed) await expect(r.inspect(id)).rejects.toThrow(/^Invalid recovery observation$/);
    const failed = reader([]);
    failed.query.mockRejectedValueOnce(new Error('private SQL and credentials'));
    await expect(failed.inspect(id)).rejects.toThrow(/^Recovery inspection query failed$/);
    expect(failed.query).toHaveBeenCalledTimes(1);
    expect(trap).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

it.each([
  ['cancelled', 1, 1, 1, 'cancelled', 'terminal_observed'],
  ['cancelled', 0, null, 0, null, 'legacy_or_inconsistent_manual_review'],
  ['cancelled', 1, 1, 1, 'completed', 'legacy_or_inconsistent_manual_review'],
  ['cancelled', 2, 2, 2, 'cancelled', 'legacy_or_inconsistent_manual_review'],
  ['cancelled', 2, 2, 1, 'continued', 'legacy_or_inconsistent_manual_review'],
  ['cancelled', 1, 2, 1, 'cancelled', 'legacy_or_inconsistent_manual_review'],
  ...['queued', 'running', 'completed', 'failed'].map(status =>
    [status, 1, 1, 1, 'cancelled', 'legacy_or_inconsistent_manual_review'] as const),
] as const)('classifies %s with count %s/max %s/terminal count %s/last %s', async (status, step_count, max_step_no, terminal_count, last_kind, category) => {
  expect(await reader([{ ...row, status, step_count, max_step_no, terminal_count, last_kind }]).inspect(id))
    .toMatchObject({ category, status });
});
