import { describe, it, expect, vi } from 'vitest';
import { createToolResultPolicy, prepareToolResult, parsePersistableToolResult, type ToolResultPolicy } from '../src/tools/tool-result-policy.js';
const safe = () => ({ schemaVersion: 1, status: 'ok', itemCount: 3 });
const outcome = () => ({ kind: 'tool_succeeded', output: { raw: 'OUTPUT_SECRET' } });
const policy = (project: () => unknown = safe) => createToolResultPolicy([{ name: 'summary', retentionSeconds: 60, project }]);
describe('privacy gated safe result policy', () => {
  it.each([0,1000])('copies and freezes valid count %i', itemCount => {
    const source = { ...safe(), itemCount }; const result = parsePersistableToolResult(source);
    expect(result).toEqual(source); expect(result).not.toBe(source); expect(Object.isFrozen(result)).toBe(true);
    source.itemCount = 5; expect(result.itemCount).toBe(itemCount);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
  });
  it('accepts empty status and null prototype objects', () => {
    expect(parsePersistableToolResult(Object.assign(Object.create(null), { ...safe(), status: 'empty' })).status).toBe('empty');
  });
  it.each([-1,1001,1.5,'3',NaN,Infinity,null,undefined,{},1n])('rejects invalid count %#', itemCount => {
    expect(() => parsePersistableToolResult({ ...safe(), itemCount })).toThrow('Invalid persistable tool result');
  });
  it.each([0,2,'1',undefined,null])('rejects version %#', schemaVersion => {
    expect(() => parsePersistableToolResult({ ...safe(), schemaVersion })).toThrow('Invalid persistable');
  });
  it.each(['TASK_SECRET','',0,null,undefined])('rejects status %#', status => {
    expect(() => parsePersistableToolResult({ ...safe(), status })).toThrow('Invalid persistable');
  });
  it.each(['extra','approved','persist','save','persistable','__proto__','constructor','then','toJSON'])('rejects extra field %s', key => {
    expect(() => parsePersistableToolResult({ ...safe(), [key]: 'CREDENTIAL_SECRET'.repeat(1000) })).toThrow('Invalid persistable');
  });
  it('rejects hostile data without executing traps, accessors or toJSON', () => {
    const effect = vi.fn(() => { throw new Error('MODEL_SECRET'); });
    const revoked = Proxy.revocable({}, {}); revoked.revoke(); const cycle: Record<string,unknown> = safe(); cycle.itemCount = cycle;
    const values = [new Proxy({}, { get: effect, ownKeys: effect, getPrototypeOf: effect }), revoked.proxy,
      Object.defineProperty(safe(),'status',{get:effect}), Object.defineProperty(safe(),'status',{set:effect}),
      Object.defineProperty(safe(),'itemCount',{enumerable:false}), { ...safe(), [Symbol()]: 1 },
      { ...safe(), toJSON: effect }, cycle, new Date(), [], null, 'OUTPUT_SECRET', Object.create(safe())];
    for (const value of values) expect(() => parsePersistableToolResult(value)).toThrow('Invalid persistable tool result');
    expect(effect).not.toHaveBeenCalled(); expect(Object.hasOwn(Object.prototype,'polluted')).toBe(false);
  });
  it('defaults to no-store and never invokes a projector for unknown tools or forged policy', () => {
    const project = vi.fn(safe); const p = policy(project);
    for (const candidate of [undefined, createToolResultPolicy(), { kind: 'host_tool_result_policy' } as ToolResultPolicy]) expect(prepareToolResult(candidate,'summary',outcome())).toBeNull();
    expect(prepareToolResult(p,'unknown',outcome())).toBeNull(); expect(project).not.toHaveBeenCalled();
  });
  it('captures host definitions and projects only an independent frozen successful outcome', () => {
    const source = outcome(); const projected = safe();
    const project = vi.fn((input: unknown) => {
      expect(input).not.toBe(source); expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen((input as typeof source).output)).toBe(true); return projected;
    });
    const def = { name: 'summary', retentionSeconds: 60, project }; const defs = [def]; const p = createToolResultPolicy(defs);
    def.name = 'changed'; def.retentionSeconds = 86401; def.project = vi.fn(() => ({ ...safe(), itemCount: 999 })); defs.length = 0;
    const result = prepareToolResult(p,'summary',source)!; projected.itemCount = 999;
    expect(result).toEqual({ safeResult: safe(), retentionSeconds: 60 }); expect(Object.isFrozen(result.safeResult)).toBe(true);
    expect(prepareToolResult(p,'changed',source)).toBeNull();
  });
  it.each([0,-1,86401,1.5,NaN,'60',undefined])('rejects invalid TTL %#', retentionSeconds => {
    expect(() => createToolResultPolicy([{ name: 'summary', retentionSeconds: retentionSeconds as number, project: safe }])).toThrow('Invalid tool result policy');
  });
  it.each(['bad name','', 'a'.repeat(65)])('rejects tool name %s', name => {
    expect(() => createToolResultPolicy([{ name, retentionSeconds: 60, project: safe }])).toThrow('Invalid tool result policy');
  });
  it('rejects duplicate, async, proxy and accessor host definitions', () => {
    const def = { name: 'summary', retentionSeconds: 60, project: safe }; const effect = vi.fn();
    expect(() => createToolResultPolicy([def,def])).toThrow('Invalid tool result policy');
    expect(() => createToolResultPolicy([{ ...def, project: async () => safe() }])).toThrow('Invalid tool result policy');
    expect(() => createToolResultPolicy([Object.defineProperty({...def},'project',{get:effect})])).toThrow('Invalid tool result policy');
    expect(() => createToolResultPolicy(new Proxy([def],{get:effect}))).toThrow('Invalid tool result policy'); expect(effect).not.toHaveBeenCalled();
  });
  it('rejects promise, thenable and hostile projector results without exposing errors or effects', async () => {
    const effect = vi.fn(() => { throw new Error('SECRET'); });
    const values = [Promise.resolve(safe()),Promise.reject(new Error('CREDENTIAL_SECRET')), {then:effect}, Object.defineProperty({},'then',{get:effect}),new Proxy({}, {get:effect,ownKeys:effect}),{...safe(),toJSON:effect}];
    for (const raw of values) expect(prepareToolResult(policy(() => raw),'summary',outcome())).toBeNull();
    expect(prepareToolResult(policy(() => {throw new Error('ARG_SECRET');}),'summary',outcome())).toBeNull();
    await new Promise<void>(r=>setImmediate(r)); expect(effect).not.toHaveBeenCalled();
  });
  it('revalidates original outcomes before any projector invocation', () => {
    const project = vi.fn(safe); const p = policy(project); const effect = vi.fn();
    for (const raw of [{kind:'tool_failed',code:'handler_error'},{...outcome(),approved:true},{...outcome(),persist:true},Object.defineProperty({},'kind',{get:effect}),new Proxy({}, {get:effect,ownKeys:effect}),{kind:'tool_succeeded',output:{persistable:true,then:effect}}]) expect(prepareToolResult(p,'summary',raw)).toBeNull();
    expect(project).not.toHaveBeenCalled();expect(effect).not.toHaveBeenCalled();
  });
  it('never logs sentinels or raw errors', () => {
    const spies = (['log','warn','error','info','debug'] as const).map(k=>vi.spyOn(console,k));
    try { expect(prepareToolResult(policy(()=>{throw new Error('TASK_SECRET ARG_SECRET OUTPUT_SECRET CREDENTIAL_SECRET MODEL_SECRET');}),'summary',outcome())).toBeNull();spies.forEach(s=>expect(s).not.toHaveBeenCalled()); }
    finally {spies.forEach(s=>s.mockRestore());}
  });
});
