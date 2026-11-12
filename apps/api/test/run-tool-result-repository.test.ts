import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createRunToolResultRepository } from '../src/persistence/run-tool-result-repository.js';
import { createToolResultPolicy } from '../src/tools/tool-result-policy.js';
const id='12345678-1234-4234-8234-123456789abc'; const now=new Date();
const row=()=>({run_id:id,step_no:1,result_kind:'tool_succeeded',schema_version:1,status:'ok',item_count:3,ttl_valid:true,created_at:now,expires_at:new Date(now.getTime()+60000)});
const outcome={kind:'tool_succeeded',output:{raw:'OUTPUT_SECRET'}};
function setup() {
  const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT status')?{rows:[{status:'running'}],rowCount:1}:sql.startsWith('INSERT')||sql.startsWith('SELECT *')?{rows:[row()],rowCount:1}:{rows:[],rowCount:0});
  const release=vi.fn();const connect=vi.fn(async()=>({query:query as unknown as PoolClient['query'],release}));
  const policy=createToolResultPolicy([{name:'summary',retentionSeconds:60,project:()=>({schemaVersion:1,status:'ok',itemCount:3})}]);
  return {query,release,connect,repo:createRunToolResultRepository({connect},policy)};
}
describe('atomic safe result repository',()=>{
  it('defaults to no-store with no connection and no Step',async()=>{
    const {connect}=setup(); const repo=createRunToolResultRepository({connect});
    expect(await repo.appendToolSucceededStepWithSafeResultIfRunning(id,'summary',outcome)).toEqual({kind:'no_store'});expect(connect).not.toHaveBeenCalled();
  });
  it.each(['',null,{},'ID_SECRET'])('rejects UUID %# before connection',async value=>{
    const {repo,connect}=setup();await expect(repo.appendToolSucceededStepWithSafeResultIfRunning(value as string,'summary',outcome)).rejects.toThrow('Invalid tool result key');await expect(repo.getSavedToolResult(value as string,1)).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
  });
  it.each([0,-1,1.5,2147483648,NaN,Infinity,'1',null,undefined])('rejects step %# before connection',async value=>{
    const {repo,connect}=setup();await expect(repo.getSavedToolResult(id,value as number)).rejects.toThrow('Invalid tool result key');expect(connect).not.toHaveBeenCalled();
  });
  it.each(['missing','queued','completed','failed'])('writes neither record for %s',async status=>{
    const {repo,query,release}=setup();query.mockResolvedValue({rows:status==='missing'?[]:[{status}] as never,rowCount:1});
    expect(await repo.appendToolSucceededStepWithSafeResultIfRunning(id,'summary',outcome)).toBeNull();
    expect(query.mock.calls.map(c=>c[0].split(' ')[0])).toEqual(['BEGIN','SELECT','COMMIT']);expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('orders parent lock, both inserts and COMMIT; stores only safe scalars',async()=>{
    const {repo,query,release}=setup();const saved=await repo.appendToolSucceededStepWithSafeResultIfRunning(id,'summary',outcome);
    expect(saved).toHaveProperty('result.safeResult',{schemaVersion:1,status:'ok',itemCount:3});
    expect(query.mock.calls.map(c=>c[0].split(' ')[0])).toEqual(['BEGIN','SELECT','INSERT','INSERT','COMMIT']);
    expect(JSON.stringify(query.mock.calls)).not.toContain('SECRET');expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it.each(['BEGIN','SELECT status','INSERT INTO run_steps','INSERT INTO run_tool_results','COMMIT'])('rolls back %s failure, releases once, never retries',async stage=>{
    const {repo,query,release}=setup();const original=query.getMockImplementation()!;const error=new Error('DB_SENTINEL');
    query.mockImplementation(async sql=>{if(sql.startsWith(stage))throw error;return original(sql);});
    await expect(repo.appendToolSucceededStepWithSafeResultIfRunning(id,'summary',outcome)).rejects.toBe(error);
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK');expect(query.mock.calls.filter(c=>c[0].startsWith(stage))).toHaveLength(1);expect(release).toHaveBeenCalledExactlyOnceWith(stage==='COMMIT');
  });
  it('discards rollback failure preserving original error',async()=>{
    const {repo,query,release}=setup();const error=new Error('DB_ERROR');query.mockRejectedValueOnce(error).mockRejectedValueOnce(new Error('ROLLBACK_ERROR'));
    await expect(repo.appendToolSucceededStepWithSafeResultIfRunning(id,'summary',outcome)).rejects.toBe(error);expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('propagates acquire failure without query or release',async()=>{
    const {repo,connect,query,release}=setup();const error=new Error('connect');connect.mockRejectedValue(error);
    await expect(repo.appendToolSucceededStepWithSafeResultIfRunning(id,'summary',outcome)).rejects.toBe(error);expect(query).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
  });
  it('returns no success before COMMIT acknowledgement',async()=>{
    const {repo,query,release}=setup();const original=query.getMockImplementation()!;let ack!:()=>void;const gate=new Promise<void>(r=>{ack=r;});let resolved=false;
    query.mockImplementation(async sql=>{if(sql==='COMMIT')await gate;return original(sql);});
    const pending=repo.appendToolSucceededStepWithSafeResultIfRunning(id,'summary',outcome).then(r=>{resolved=true;return r;});
    try {await vi.waitFor(()=>expect(query).toHaveBeenCalledWith('COMMIT'));expect(resolved).toBe(false);expect(release).not.toHaveBeenCalled();}finally{ack();await pending;}
  });
  it('read copies and freezes data and uses DB expiry predicate; empty read returns null',async()=>{
    const {repo,query}=setup();const raw=row();query.mockResolvedValue({rows:[raw],rowCount:1});const result=await repo.getSavedToolResult(id,1);
    raw.item_count=999;expect(result!.safeResult.itemCount).toBe(3);expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result!.safeResult)).toBe(true);
    expect(query.mock.calls[0]![0]).toContain('expires_at > statement_timestamp()');query.mockResolvedValue({rows:[],rowCount:0});expect(await repo.getSavedToolResult(id,1)).toBeNull();
  });
  it.each(['run_id','step_no','result_kind','schema_version','status','item_count','created_at','expires_at'])('rejects malformed persisted %s without exposing row',async key=>{
    const {repo,query,release}=setup();query.mockResolvedValue({rows:[{...row(),[key]:'CREDENTIAL_SECRET'}] as never,rowCount:1});
    await expect(repo.getSavedToolResult(id,1)).rejects.toThrow('Invalid saved tool result');expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('does not execute a DB row getter or Proxy trap',async()=>{
    const effect=vi.fn();for(const raw of [new Proxy({}, {get:effect,ownKeys:effect}),Object.defineProperty(row(),'status',{get:effect})]){
      const {repo,query}=setup();query.mockResolvedValue({rows:[raw] as never,rowCount:1});await expect(repo.getSavedToolResult(id,1)).rejects.toThrow('Invalid saved tool result');
    }expect(effect).not.toHaveBeenCalled();
  });
  it('accepts uppercase UUIDs with canonical returned keys',async()=>{
    const {repo}=setup();const saved=await repo.appendToolSucceededStepWithSafeResultIfRunning(id.toUpperCase(),'summary',outcome);
    expect(saved).toHaveProperty('result.runId',id);expect((await repo.getSavedToolResult(id.toUpperCase(),1))!.runId).toBe(id);
  });
  it('purges only using the DB expiry predicate',async()=>{
    const {repo,query,release}=setup();query.mockResolvedValue({rows:[],rowCount:2});expect(await repo.deleteExpiredToolResults()).toBe(2);
    expect(query).toHaveBeenCalledExactlyOnceWith('DELETE FROM run_tool_results WHERE expires_at <= statement_timestamp()');expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe('persisted result original TTL boundaries', () => {
  it.each([500, 999, 1000, 60000, 86400000, 86400001])('validates original TTL %i ms', async ttl => {
    const { repo, query, release } = setup();
    const raw = { ...row(), expires_at: new Date(now.getTime() + ttl) };
    query.mockResolvedValue({ rows: [raw], rowCount: 1 });
    if (ttl < 1000 || ttl > 86400000) {
      await expect(repo.getSavedToolResult(id, 1)).rejects.toThrow('Invalid saved tool result');
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    } else {
      const saved = await repo.getSavedToolResult(id, 1);
      expect(saved!.expiresAt).toBe(raw.expires_at.toISOString());
      expect(Object.isFrozen(saved)).toBe(true);
      expect(saved).not.toHaveProperty('ttl_valid');
    }
  });
  it.each([false, undefined, 'true', 1])('rejects invalid or missing DB precision evidence %#', async ttl_valid => {
    const { repo, query } = setup();
    // Date truncation can turn PostgreSQL 0.999999 seconds into exactly 1000 ms.
    query.mockResolvedValue({ rows: [{ ...row(), expires_at: new Date(now.getTime() + 1000), ttl_valid }] as never, rowCount: 1 });
    await expect(repo.getSavedToolResult(id, 1)).rejects.toThrow('Invalid saved tool result');
  });
  it('never executes an accessor for the DB TTL validation result', async () => {
    const { repo, query } = setup(); const effect = vi.fn();
    query.mockResolvedValue({ rows: [Object.defineProperty(row(), 'ttl_valid', { get: effect })], rowCount: 1 });
    await expect(repo.getSavedToolResult(id, 1)).rejects.toThrow('Invalid saved tool result');
    expect(effect).not.toHaveBeenCalled();
  });
  it('does not confuse original TTL with less than one second remaining', async () => {
    const { repo, query } = setup(); const clock = new Date('2026-01-01T00:00:00Z');
    vi.useFakeTimers(); vi.setSystemTime(clock);
    try {
      query.mockResolvedValue({ rows: [{ ...row(), created_at: new Date(clock.getTime() - 500), expires_at: new Date(clock.getTime() + 500) }], rowCount: 1 });
      expect(await repo.getSavedToolResult(id, 1)).not.toBeNull();
      expect(query.mock.calls[0]![0]).toContain("INTERVAL '1 second'");
      expect(query.mock.calls[0]![0]).toContain('AS ttl_valid');
    } finally { vi.useRealTimers(); }
  });
});
