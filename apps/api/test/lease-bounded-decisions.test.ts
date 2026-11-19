import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { runLeaseBoundedDecisions as execute, type LeaseDecisionDependencies as Dependencies,
  type LeaseDecisionOptions } from '../src/runtime/run-lease-bounded-decisions.js';

const id = randomUUID();
const ownerId = randomUUID();
const token = randomUUID();
const date = new Date();
const options = { ownerId, leaseSeconds: 30, maxDecisions: 2 };
const run = { id, task: 'private input', status: 'running' as const, createdAt: date };
const handle = { runId: id, ownerId, leaseToken: token, leaseSeconds: 30, acquiredAt: date.toISOString().replace('Z', '000Z'),
  renewedAt: date.toISOString().replace('Z', '000Z'), expiresAt: new Date(+date + 30000).toISOString().replace('Z', '000Z') };

function fixture(max = 2) {
  let progress = { runId: id, schemaVersion: 1 as const, maxDecisions: max, maxToolAttempts: 0,
    checkpointVersion: 0, decisionsReserved: 0, toolAttemptsReserved: 0, lastConfirmedStepNo: null as number | null,
    createdAt: date.toISOString().replace('Z', '000Z'), updatedAt: date.toISOString().replace('Z', '000Z') };
  const deps = {
    tryClaimRunLease: vi.fn<Dependencies['tryClaimRunLease']>().mockResolvedValue(handle),
    initializeProgress: vi.fn<Dependencies['initializeProgress']>().mockImplementation(async () => progress),
    findRunById: vi.fn<Dependencies['findRunById']>().mockResolvedValue(run),
    tryReserveDecision: vi.fn<Dependencies['tryReserveDecision']>().mockImplementation(async (_, credentials, version) => {
      expect(credentials.ownerId === ownerId && credentials.leaseToken === token).toBe(true);
      expect(version).toBe(progress.checkpointVersion);
      return progress = { ...progress, checkpointVersion: version + 1, decisionsReserved: progress.decisionsReserved + 1 };
    }),
    decide: vi.fn<Dependencies['decide']>().mockReturnValue({ kind: 'continue' }),
    appendContinuedStepWithLease: vi.fn<Dependencies['appendContinuedStepWithLease']>().mockImplementation(async () => ({
      runId: id, stepNo: (progress.lastConfirmedStepNo ?? 0) + 1, resultKind: 'continued', createdAt: date,
    })),
    tryConfirmCommittedStep: vi.fn<Dependencies['tryConfirmCommittedStep']>().mockImplementation(async (_, __, input) => {
      expect(input.expectedVersion).toBe(progress.checkpointVersion);
      return progress = { ...progress, checkpointVersion: input.expectedVersion + 1, lastConfirmedStepNo: input.stepNo };
    }),
    tryFinalizeWithStepWithLease: vi.fn<Dependencies['tryFinalizeWithStepWithLease']>().mockImplementation(async (_, kind) => ({
      run: { ...run, status: kind === 'completed' ? 'completed' : 'failed' },
      step: { runId: id, stepNo: (progress.lastConfirmedStepNo ?? 0) + 1, resultKind: kind, createdAt: date },
    })),
  };
  return deps;
}

const trap = vi.fn((): never => { throw new Error('unexpected user code'); });
const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
const badInputs: (readonly [string, string, unknown])[] = [
  ['invalid id', 'bad', options], ['trailing newline', id + '\n', options],
  ['option proxy', id, proxy], ['extra field', id, { ...options, leaseToken: token }],
  ['owner accessor', id, { ...options, get ownerId() { return trap(); } }],
  ['lease setter', id, { ...options, set leaseSeconds(_: number) { trap(); } }],
  ['coercion', id, { ...options, maxDecisions: { valueOf: trap } }],
  ['owner id', id, { ...options, ownerId: 'bad' }], ['hidden symbol', id, { ...options, [Symbol()]: 0 }],
  ...[0, 301, 1.1, Infinity].map(n => ['lease ' + n, id, { ...options, leaseSeconds: n }] as const),
  ...[0, 6, 1.1, NaN].map(n => ['budget ' + n, id, { ...options, maxDecisions: n }] as const),
]
it.each(badInputs)('rejects %s before any dependency call', async (_, input, config) => {
  const deps = fixture();
  await expect(execute(input as string, deps, config as LeaseDecisionOptions)).rejects.toThrow('Invalid lease decision input');
  for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

it.each(['proxy', 'getter', 'missing', 'proxy function'] as const)('rejects %s dependency without executing it', async mode => {
  const deps = fixture();
  const bad = mode === 'proxy' ? proxy : mode === 'getter' ? { ...deps, get decide() { return trap(); } } :
    { ...deps, decide: mode === 'missing' ? undefined : new Proxy(trap, { apply: trap }) };
  await expect(execute(id, bad as Dependencies, options)).rejects.toThrow('Invalid lease decision input');
  expect(deps.tryClaimRunLease).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

const stages = [
  ['tryClaimRunLease', 'not_started', 0], ['initializeProgress', 'initialization_conflict', 0],
  ['findRunById', 'decision_admission_conflict', 0], ['tryReserveDecision', 'decision_admission_conflict', 0],
  ['appendContinuedStepWithLease', 'step_persistence_conflict', 1], ['tryConfirmCommittedStep', 'checkpoint_conflict', 1],
  ['tryFinalizeWithStepWithLease', 'finalize_conflict', 1],
] as const;
for (const [stage, conflict, calls] of stages) {
  it.each(['refusal', 'rejection'])('%s at ' + stage + ' stops immediately', async failure => {
    const deps = fixture();
    if (stage === 'tryFinalizeWithStepWithLease') deps.decide.mockReturnValue({ kind: 'final', content: 'ok' });
    const error = new Error('unconfirmed persistence');
    if (failure === 'refusal') deps[stage].mockResolvedValueOnce(null);
    else deps[stage].mockRejectedValueOnce(error);
    const result = execute(id, deps, options);
    if (failure === 'refusal') await expect(result).resolves.toEqual({ kind: conflict });
    else await expect(result).rejects.toBe(error);
    expect(deps[stage]).toHaveBeenCalledTimes(1);
    expect(deps.decide).toHaveBeenCalledTimes(calls);
    expect(deps.tryClaimRunLease).toHaveBeenCalledTimes(1);
    if (stage !== 'tryFinalizeWithStepWithLease') expect(deps.tryFinalizeWithStepWithLease).not.toHaveBeenCalled();
  });
}

it.each([
  ['final', { kind: 'final', content: 'ok' }, { kind: 'completed', content: 'ok' }],
  ['limit', { kind: 'continue' }, { kind: 'decision_limit_exceeded' }],
  ['unsupported', { kind: 'tool_request', toolName: 'test_tool', arguments: {} }, { kind: 'unsupported_tool_request' }],
  ['invalid', { raw: 'private' }, { kind: 'invalid_decision' }],
  ['hostile then', { get then() { return trap(); } }, { kind: 'invalid_decision' }],
  ['hostile proxy', proxy, { kind: 'invalid_decision' }],
  ['hostile field', { get kind() { return trap(); } }, { kind: 'invalid_decision' }],
] as const)('%s returns only the fixed terminal contract', async (_, raw, expected) => {
  const deps = fixture(1);
  const source = { ...deps, decide: () => raw };
  expect(await execute(id, source, { ...options, maxDecisions: 1 })).toEqual(expected);
  expect(deps.tryFinalizeWithStepWithLease).toHaveBeenCalledTimes(1);
  expect(deps.tryConfirmCommittedStep).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});
it('sanitizes source failure and finalizes once', async () => {
  const deps = fixture();
  deps.decide.mockRejectedValue(new Error('private'));
  expect(await execute(id, deps, options)).toEqual({ kind: 'decision_source_error' });
  expect(deps.tryFinalizeWithStepWithLease).toHaveBeenCalledTimes(1);
});

it.each([
  ['initializeProgress', { checkpointVersion: 1 }, 'initialization_conflict'],
  ['initializeProgress', { lastConfirmedStepNo: 1 }, 'initialization_conflict'],
  ['tryReserveDecision', { decisionsReserved: 0 }, 'decision_admission_conflict'],
  ['tryReserveDecision', { checkpointVersion: 2 }, 'decision_admission_conflict'],
  ['tryReserveDecision', { maxToolAttempts: 1 }, 'decision_admission_conflict'],
  ['tryReserveDecision', { runId: randomUUID() }, 'decision_admission_conflict'],
  ['appendContinuedStepWithLease', { stepNo: 2 }, 'step_persistence_conflict'],
  ['appendContinuedStepWithLease', { resultKind: 'completed' }, 'step_persistence_conflict'],
  ['appendContinuedStepWithLease', { runId: randomUUID() }, 'step_persistence_conflict'],
  ['tryConfirmCommittedStep', { lastConfirmedStepNo: null }, 'checkpoint_conflict'],
  ['tryConfirmCommittedStep', { checkpointVersion: 1 }, 'checkpoint_conflict'],
  ['tryConfirmCommittedStep', { decisionsReserved: 2 }, 'checkpoint_conflict'],
] as const)('%s rejects malformed %j', async (key, change, kind) => {
  const deps = fixture();
  const method = deps[key];
  const original = method.getMockImplementation()!;
  method.mockImplementationOnce(async (...args: unknown[]) => ({ ...await Reflect.apply(original, undefined, args), ...change }) as never);
  expect(await execute(id, deps, options)).toEqual({ kind });
  expect(deps.decide.mock.calls.length).toBe(key === 'tryConfirmCommittedStep' || key === 'appendContinuedStepWithLease' ? 1 : 0);
  expect(deps.tryFinalizeWithStepWithLease).not.toHaveBeenCalled();
});

it('rejects a synchronous persistence thenable without reading then', async () => {
  const deps = fixture();
  deps.tryClaimRunLease.mockReturnValueOnce({ get then() { return trap(); } } as never);
  await expect(execute(id, deps, options)).rejects.toThrow('Invalid persistence response');
  expect(trap).not.toHaveBeenCalled();
  expect(deps.initializeProgress).not.toHaveBeenCalled();
});

it('captures inputs before claim and waits for each acknowledgement', async () => {
  const deps = fixture();
  const mutable = { ...options };
  const entered: string[] = [];
  const barriers = new Map<string, () => void>();
  const wrappers = { ...deps };
  for (const [stage] of stages) {
    Object.defineProperty(wrappers, stage, { value: async (...args: unknown[]) => {
      entered.push(stage);
      const value = await Reflect.apply(deps[stage], undefined, args);
      await new Promise<void>(resolve => barriers.set(stage, resolve));
      return value;
    } });
  }
  wrappers.decide = vi.fn(() => { entered.push('decide'); return { kind: 'continue' }; });
  const pending = execute(id, wrappers, mutable);
  mutable.maxDecisions = 1;
  mutable.ownerId = randomUUID();
  wrappers.decide = vi.fn(trap);
  const order = ['tryClaimRunLease', 'initializeProgress', 'findRunById', 'tryReserveDecision', 'decide',
    'appendContinuedStepWithLease', 'tryConfirmCommittedStep', 'findRunById', 'tryReserveDecision', 'decide', 'tryFinalizeWithStepWithLease'];
  for (const [index, name] of order.entries()) {
    if (name === 'decide') continue;
    await vi.waitFor(() => expect(barriers.has(name)).toBe(true));
    expect(entered).toEqual(order.slice(0, index + 1));
    barriers.get(name)!();
    barriers.delete(name);
  }
  expect(await pending).toEqual({ kind: 'decision_limit_exceeded' });
  expect(trap).not.toHaveBeenCalled();
});


it.each(['other owner', 'wrong run', 'bad token', 'accessor'] as const)('refuses an invalid claim handle (%s)', async mode => {
  const deps = fixture();
  const claim = { ...handle };
  if (mode === 'other owner') claim.ownerId = randomUUID();
  if (mode === 'wrong run') claim.runId = randomUUID();
  if (mode === 'bad token') Object.assign(claim, { leaseToken: 'invalid' });
  if (mode === 'accessor') Object.defineProperty(claim, 'leaseToken', { get: trap });
  deps.tryClaimRunLease.mockResolvedValueOnce(claim);
  await expect(execute(id, deps, options)).rejects.toThrow('Invalid lease claim response');
  expect(deps.initializeProgress).not.toHaveBeenCalled();
  expect(deps.decide).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

it.each(['wrong run', 'not running', 'task accessor'] as const)('rejects unsafe Run context (%s) before reservation', async mode => {
  const deps = fixture();
  const row = { ...run };
  if (mode === 'wrong run') row.id = randomUUID();
  if (mode === 'not running') Object.assign(row, { status: 'completed' });
  if (mode === 'task accessor') Object.defineProperty(row, 'task', { get: trap });
  deps.findRunById.mockResolvedValueOnce(row);
  expect(await execute(id, deps, options)).toEqual({ kind: 'decision_admission_conflict' });
  expect(deps.tryReserveDecision).not.toHaveBeenCalled();
  expect(deps.decide).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

it('an active snapshot cannot replace the reservation acknowledgement', async () => {
  const deps = fixture();
  const original = deps.tryReserveDecision.getMockImplementation()!;
  deps.tryReserveDecision.mockImplementationOnce(async (...args) =>
    ({ ...await original(...args), diagnostic: 'aligned', leaseState: 'active' }) as never);
  expect(await execute(id, deps, options)).toEqual({ kind: 'decision_admission_conflict' });
  expect(deps.decide).not.toHaveBeenCalled();
});

it('refuses a malformed terminal envelope after one finalization', async () => {
  const deps = fixture(1);
  deps.tryFinalizeWithStepWithLease.mockResolvedValueOnce({ get run() { return trap(); }, step: {} } as never);
  expect(await execute(id, deps, { ...options, maxDecisions: 1 })).toEqual({ kind: 'finalize_conflict' });
  expect(deps.tryFinalizeWithStepWithLease).toHaveBeenCalledTimes(1);
  expect(deps.tryConfirmCommittedStep).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

it('consumes five separate reservations and confirms only the four continued Steps', async () => {
  const deps = fixture(5);
  expect(await execute(id, deps, { ...options, maxDecisions: 5 })).toEqual({ kind: 'decision_limit_exceeded' });
  expect(deps.tryReserveDecision.mock.calls.map(call => call[2])).toEqual([0, 2, 4, 6, 8]);
  expect(deps.tryConfirmCommittedStep.mock.calls.map(call => call[2])).toEqual([
    { expectedVersion: 1, stepNo: 1 }, { expectedVersion: 3, stepNo: 2 },
    { expectedVersion: 5, stepNo: 3 }, { expectedVersion: 7, stepNo: 4 },
  ]);
  expect(deps.decide).toHaveBeenCalledTimes(5);
  expect(deps.appendContinuedStepWithLease).toHaveBeenCalledTimes(4);
  expect(deps.tryFinalizeWithStepWithLease).toHaveBeenCalledTimes(1);
});

it('keeps credentials and source errors out of the result and console', async () => {
  const deps = fixture();
  const sinks = (['log', 'info', 'debug', 'warn', 'error'] as const).map(key => vi.spyOn(console, key).mockImplementation(() => {}));
  try {
    const decide = (context: Parameters<Dependencies['decide']>[0]) => {
      expect(Object.keys(context).sort()).toEqual(['createdAt', 'id', 'status', 'task']);
      throw new Error('private source error');
    };
    expect(await execute(id, { ...deps, decide }, options)).toEqual({ kind: 'decision_source_error' });
    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
  } finally { for (const sink of sinks) sink.mockRestore(); }
});

it.each([
  { slot: 1, stepNo: 2, accepted: false },
  { slot: 2, stepNo: 1, accepted: false },
  { slot: 2, stepNo: 3, accepted: false },
  { slot: 2, stepNo: 2, accepted: true },
])('checks terminal Step #$stepNo at slot $slot', async ({ slot, stepNo, accepted }) => {
  const deps = fixture();
  deps.decide.mockReturnValue({ kind: 'final', content: 'ok' });
  if (slot === 2) deps.decide.mockReturnValueOnce({ kind: 'continue' });
  deps.tryFinalizeWithStepWithLease.mockResolvedValueOnce({
    run: { ...run, status: 'completed' },
    step: { runId: id, stepNo, resultKind: 'completed', createdAt: date },
  });

  const result = await execute(id, deps, options);
  expect(result).toEqual(accepted ? { kind: 'completed', content: 'ok' } : { kind: 'finalize_conflict' });
  expect(deps.decide).toHaveBeenCalledTimes(slot);
  expect(deps.tryReserveDecision).toHaveBeenCalledTimes(slot);
  expect(deps.tryFinalizeWithStepWithLease).toHaveBeenCalledTimes(1);
  expect(deps.tryConfirmCommittedStep.mock.calls.map(call => call[2].stepNo)).toEqual(slot === 2 ? [1] : []);
});

it.each([
  { metadata: 'different task', task: 'another valid task', offsetMs: 0, accepted: false },
  { metadata: 'different timestamp', task: run.task, offsetMs: 1, accepted: false },
  { metadata: 'same timestamp in a distinct Date', task: run.task, offsetMs: 0, accepted: true },
])('checks terminal Run metadata: $metadata', async ({ task, offsetMs, accepted }) => {
  const deps = fixture(1);
  deps.decide.mockReturnValue({ kind: 'final', content: 'ok' });
  const createdAt = new Date(date.getTime() + offsetMs);
  deps.tryFinalizeWithStepWithLease.mockResolvedValueOnce({
    run: { ...run, status: 'completed', task, createdAt },
    step: { runId: id, stepNo: 1, resultKind: 'completed', createdAt: date },
  });

  const result = await execute(id, deps, { ...options, maxDecisions: 1 });
  expect(result).toEqual(accepted ? { kind: 'completed', content: 'ok' } : { kind: 'finalize_conflict' });
  expect(deps.decide).toHaveBeenCalledTimes(1);
  expect(deps.tryFinalizeWithStepWithLease).toHaveBeenCalledTimes(1);
  expect(deps.tryConfirmCommittedStep).not.toHaveBeenCalled();
});
