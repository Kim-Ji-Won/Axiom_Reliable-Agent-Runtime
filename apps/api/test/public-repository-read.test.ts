import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicReadWithTransport, type PublicReadOptions, type PublicReadTransport } from '../src/tools/public-repository-read-internal.js';
import { createPublicRepositoryReadExecutor } from '../src/tools/public-repository-read-executor.js';
import { runPublicRepoSmoke } from '../src/smoke/public-repo.js';
import { buildApp } from '../src/app.js';
import { runId, decision, upstream, success, failed, assertRequest, jsonResponse, bodyOfSize, bounded, deferred } from './public-repository-read-fixture.js';

const denied = failed('execution_unavailable');
const invalid = failed('invalid_tool_output');
const permit = (fn: () => unknown) => fn as PublicReadOptions['permitExecution'];
function setup(transport: PublicReadTransport = async () => jsonResponse(), options: PublicReadOptions = { permitExecution: () => true }, deadline = 5000) {
  const request = vi.fn((url: string, init: RequestInit) => { assertRequest(url, init); return transport(url, init); });
  return { request, executor: createPublicReadWithTransport(options, request, deadline) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('public read validation, permission and production boundary', () => {
  it('import, factory, app startup and smoke without exact opt-in perform no requests', async () => {
    const fetch = vi.fn(() => { throw new Error('Unexpected network'); }); vi.stubGlobal('fetch', fetch);
    const executor = createPublicRepositoryReadExecutor(); expect(Object.isFrozen(executor)).toBe(true);
    expect(Object.keys(executor)).toEqual(['execute']); expect(await executor.execute(runId, decision)).toEqual(denied);
    for (const args of [[], ['--allow-public-network=false'], ['--allow-public-network','extra']]) expect(await runPublicRepoSmoke(args)).toEqual({ status: 'BLOCKED', attempts: 0 });
    const app = buildApp({ logger: false }); try { await app.ready(); expect((await app.inject('/health')).statusCode).toBe(200); } finally { await app.close(); }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('production wrapper uses the bounded native path only after approval', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => { assertRequest(url, init); return jsonResponse(); }); vi.stubGlobal('fetch', fetch);
    expect(await createPublicRepositoryReadExecutor({ permitExecution: () => true }).execute(runId, decision)).toEqual(success);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null, '', 'TASK_SECRET', {}, 1])('invalid UUID %# never reaches gate or transport', async id => {
    const gate = vi.fn(() => true); const s = setup(undefined, { permitExecution: gate });
    expect(await s.executor.execute(id, decision)).toEqual({ kind: 'invalid_run_id' }); expect(gate).not.toHaveBeenCalled(); expect(s.request).not.toHaveBeenCalled();
  });
  it.each([
    ['unknown', { ...decision, toolName: 'other' }, 'unknown_tool'],
    ['not-tool', { kind: 'final', content: 'done' }, 'not_tool_request'],
    ['null', null, 'invalid_model_decision'],
    ['pending', { kind: 'pending_authorization', runId, toolName: decision.toolName, arguments: {} }, 'invalid_model_decision'],
    ['validated', { kind: 'validated_tool_request', name: decision.toolName, arguments: {} }, 'invalid_model_decision'],
    ...['approved','authorized','persist'].map(key => [key, { ...decision, [key]: true }, 'invalid_model_decision']),
    ...['url','host','method','headers','token','timeout','signal','owner','repository','query','persist'].map(key => [key, { ...decision, arguments: { [key]: 'ARG_SECRET' } }, 'invalid_tool_arguments']),
  ] as [string, unknown, string][])('rejects %s before gate', async (_label, input, kind) => {
    const gate = vi.fn(() => true); const s = setup(undefined, { permitExecution: gate });
    expect(await s.executor.execute(runId, input)).toEqual({ kind }); expect(gate).not.toHaveBeenCalled(); expect(s.request).not.toHaveBeenCalled();
  });
  it.each(['absent','false','undefined','object','throw','promise','rejected','thenable','proxy'])('default deny %s without then/getter/trap execution', async mode => {
    let touched = 0;
    const callback = () => {
      if (mode === 'throw') throw new Error('CREDENTIAL_SECRET');
      if (mode === 'promise') return Promise.resolve(true);
      if (mode === 'rejected') return Promise.reject(new Error('CREDENTIAL_SECRET'));
      if (mode === 'thenable') return { get then() { touched++; throw new Error(); } };
      if (mode === 'proxy') return new Proxy({}, { get() { touched++; throw new Error(); } });
      return mode === 'object' ? new Boolean(true) : mode === 'false' ? false : undefined;
    };
    const s = setup(undefined, mode === 'absent' ? {} : { permitExecution: permit(callback) });
    expect(await s.executor.execute(runId, decision)).toEqual(denied); expect(s.request).not.toHaveBeenCalled(); expect(touched).toBe(0);
  });
  it('captures gate, reevaluates each call and passes only an independent frozen plan', async () => {
    let allow = true; const input = { ...decision, arguments: {} };
    const options: PublicReadOptions = { permitExecution: plan => {
      expect(plan).toEqual({ kind: 'pending_authorization', runId, toolName: decision.toolName, arguments: {} });
      expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.arguments)).toBe(true); expect(plan.arguments).not.toBe(input.arguments); return allow;
    } };
    const s = setup(undefined, options); options.permitExecution = () => false;
    expect(await s.executor.execute(runId, input)).toEqual(success); allow = false;
    expect(await s.executor.execute(runId, input)).toEqual(denied); expect(s.request).toHaveBeenCalledTimes(1);
  });
  it('fixes input > gate > pre-abort precedence and rechecks after gate', async () => {
    const controller = new AbortController(); controller.abort('ABORT_SECRET'); const s = setup();
    expect(await s.executor.execute('bad', null, { signal: controller.signal })).toEqual({ kind: 'invalid_run_id' });
    expect(await setup(undefined, {}).executor.execute(runId, decision, { signal: controller.signal })).toEqual(denied);
    expect(await s.executor.execute(runId, decision, { signal: controller.signal })).toEqual(failed()); expect(s.request).not.toHaveBeenCalled();
    const during = new AbortController(); const t = setup(undefined, { permitExecution: () => { during.abort(); return true; } });
    expect(await t.executor.execute(runId, decision, { signal: during.signal })).toEqual(failed()); expect(t.request).not.toHaveBeenCalled();
  });
  it('never invokes hostile model getters or Proxy traps, and performs no HTTP', async () => {
    let touched = 0; const s = setup();
    const hostile = [new Proxy({}, { get() { touched++; throw new Error(); }, ownKeys() { touched++; throw new Error(); } }),
      { ...decision, arguments: { get token() { touched++; throw new Error(); } } },
      { ...decision, get approved() { touched++; throw new Error(); } }];
    for (const raw of hostile) expect(await s.executor.execute(runId, raw)).toEqual({ kind: 'invalid_model_decision' });
    expect(touched).toBe(0); expect(s.request).not.toHaveBeenCalled();
  });
  it('opt-in smoke uses production executor once with a local-only UUID', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => { assertRequest(url, init); return jsonResponse(); }); vi.stubGlobal('fetch', fetch);
    expect(await runPublicRepoSmoke(['--allow-public-network'])).toEqual({ status: 'PASS', attempts: 1, outcome: success }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requires test transport, rejects wider deadlines, and does not fallback', () => {
    expect(() => createPublicReadWithTransport({}, undefined as unknown as PublicReadTransport)).toThrow('configuration');
    for (const ms of [0, -1, 5001, Infinity, NaN, 1.5]) expect(() => createPublicReadWithTransport({}, async () => jsonResponse(), ms)).toThrow('configuration');
  });
});

describe('public read bounded response and safe projection', () => {
  it('drops all untrusted extra fields and freezes a minimal independent outcome', async () => {
    const raw = JSON.parse(JSON.stringify({ ...upstream, description: 'TASK_SECRET', url: 'CREDENTIAL_SECRET', prompt: 'MODEL_SECRET', approved: true, ignored: 'a'.repeat(10000) }).replace('{', '{"__proto__":{"polluted":true},'));
    const response = jsonResponse(raw); const s = setup(async () => response);
    const result = await s.executor.execute(runId, decision); expect(result).toEqual(success); expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== 'tool_succeeded') throw new Error(); expect(Object.isFrozen(result.output)).toBe(true);
    raw.stargazers_count = 0; expect(result).toEqual(success); expect({}).not.toHaveProperty('polluted'); expect(response.body!.locked).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it.each(['application/json','application/json; charset=utf-8','application/vnd.github+json; charset="UTF-8"','Application/JSON'])('accepts explicit media type %s', async type => {
    expect(await setup(async () => new Response(JSON.stringify(upstream), { headers: { 'content-type': type } })).executor.execute(runId, decision)).toEqual(success);
  });
  it.each(['text/html','text/json','application/notjson','application/jsonp','application/json; charset=latin1','application/json; bad=x','application/+json','application/json, text/html',''])('rejects media type %s', async type => {
    expect(await setup(async () => new Response('{}', { headers: { 'content-type': type } })).executor.execute(runId, decision)).toEqual(invalid);
  });
  it.each(['', '{', 'null', 'true', '1', '"x"', '[]', '{}'])('rejects JSON body %#', async text => {
    expect(await setup(async () => new Response(text, { headers: { 'content-type': 'application/json' } })).executor.execute(runId, decision)).toEqual(invalid);
  });
  it('rejects invalid UTF-8 without replacement', async () => {
    expect(await setup(async () => new Response(new Uint8Array([0xc0, 0xaf]), { headers: { 'content-type': 'application/json' } })).executor.execute(runId, decision)).toEqual(invalid);
  });
  it.each([
    ['full_name','other/repo'],['full_name',null],['private',true],['private','false'],['archived','false'],['archived',null],
    ...['stargazers_count','forks_count'].flatMap(key => [-1,1.5,Number.MAX_SAFE_INTEGER + 1,'5',null].map(value => [key,value])),
    ...Object.keys(upstream).map(key => [key,undefined]),
  ] as [string, unknown][])('rejects bad/missing upstream %s %#', async (key, value) => {
    const raw = { ...upstream, [key as string]: value };
    expect(await setup(async () => jsonResponse(raw)).executor.execute(runId, decision)).toEqual(invalid);
  });
  it('counts UTF-8 bytes rather than characters and decodes split code points only after bounded consumption', async () => {
    const text = JSON.stringify({ ...upstream, ignored: '😀'.repeat(17000) }); expect(text.length).toBeLessThan(65536); expect(Buffer.byteLength(text)).toBeGreaterThan(65536);
    expect(await setup(async () => new Response(text, { headers: { 'content-type': 'application/json' } })).executor.execute(runId, decision)).toEqual(invalid);
    const bytes = Buffer.from(JSON.stringify({ ...upstream, ignored: '😀' })); let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.subarray(offset, ++offset)); } });
    expect(await setup(async () => new Response(body, { headers: { 'content-type': 'application/json' } })).executor.execute(runId, decision)).toEqual(success);
  });
  it.each([65536,65537])('counts %i actual bytes with misleading length and chunk boundaries', async size => {
    for (const chunkSize of [size, 1024]) {
      const bytes = Buffer.from(bodyOfSize(size)); let offset = 0;
      const body = new ReadableStream<Uint8Array>({ pull(c) { if (offset === bytes.length) c.close(); else { const end = Math.min(bytes.length, offset + chunkSize); c.enqueue(bytes.subarray(offset,end)); offset = end; } } });
      const response = new Response(body, { headers: { 'content-type': 'application/json', 'content-length': '1' } });
      expect(await setup(async () => response).executor.execute(runId, decision)).toEqual(size === 65536 ? success : invalid); expect(body.locked).toBe(false);
    }
  });
  it.each([301,302,307,308,401,403,404,429,500,503])('maps HTTP %i to fixed failure, cancels body and never retries', async status => {
    const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel });
    const s = setup(async () => new Response(body, { status }));
    expect(await s.executor.execute(runId, decision)).toEqual(failed()); expect(s.request).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['network','tls','stream'])('sanitizes %s failure and never logs or retries', async mode => {
    const logs = ['error','warn','info','log'].map(name => vi.spyOn(console, name as 'error').mockImplementation(() => {}));
    const s = setup(async () => {
      if (mode !== 'stream') throw new Error('CREDENTIAL_SECRET', { cause: 'TASK_SECRET' });
      return new Response(new ReadableStream({ start(c) { c.error(new Error('MODEL_SECRET')); } }), { headers: { 'content-type': 'application/json' } });
    });
    expect(await s.executor.execute(runId, decision)).toEqual(failed()); expect(s.request).toHaveBeenCalledTimes(1); logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });
});

describe('public read deadline and cleanup', () => {
  it('production deadline is exactly 5000ms and late host abort cannot change a finished result', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => { signal = init.signal; return new Promise<Response>(() => {}); });
    const host = new AbortController(); let finished = false;
    const pending = createPublicRepositoryReadExecutor({ permitExecution: () => true }).execute(runId, decision, { signal: host.signal }).then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(4999); expect(finished).toBe(false); expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const result = await pending; expect(result).toEqual(failed()); expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(host.signal,'abort')).toHaveLength(0); host.abort('LATE_SECRET'); expect(result).toEqual(failed());
  });
  it.each(['success','http','type','size','stream','abort'])('cleans timers, listeners and reader on %s', async mode => {
    vi.useFakeTimers(); const host = new AbortController(); let cancelCount = 0; let response: Response | undefined;
    const s = setup(async () => {
      if (mode === 'abort') { host.abort('SECRET'); return jsonResponse(); }
      if (mode === 'success') return response = jsonResponse();
      const body = new ReadableStream<Uint8Array>({ start(c) { if (mode === 'size') c.enqueue(new Uint8Array(65537)); if (mode === 'stream') c.error(new Error()); }, cancel() { cancelCount++; return Promise.reject(new Error('CLEANUP_SECRET')); } });
      return response = new Response(body, { status: mode === 'http' ? 500 : 200, headers: { 'content-type': mode === 'type' ? 'text/html' : 'application/json' } });
    });
    const result = await s.executor.execute(runId, decision, { signal: host.signal });
    expect(result).toEqual(mode === 'success' ? success : mode === 'size' || mode === 'type' ? invalid : failed());
    expect(vi.getTimerCount()).toBe(0); expect(getEventListeners(host.signal,'abort')).toHaveLength(0);
    if (response?.body) expect(response.body.locked).toBe(false);
    if (['http','type','size'].includes(mode)) expect(cancelCount).toBe(1);
  });
  it('cancels a stalled reader without waiting for its cancellation promise', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {})); const body = new ReadableStream<Uint8Array>({ cancel }); const host = new AbortController();
    const s = setup(async () => new Response(body, { headers: { 'content-type': 'application/json' } }), undefined, 20);
    expect(await bounded(s.executor.execute(runId, decision, { signal: host.signal }))).toEqual(failed());
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false); expect(getEventListeners(host.signal,'abort')).toHaveLength(0);
  });
  it('cancels a late response after deadline, never returns late success or unhandled rejection', async () => {
    const release = deferred(); const cancel = vi.fn(); const body = new ReadableStream<Uint8Array>({ cancel });
    const s = setup(async () => { await release.promise; return new Response(body); }, undefined, 10);
    try { expect(await bounded(s.executor.execute(runId, decision))).toEqual(failed()); }
    finally { release.resolve(); }
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });
});
