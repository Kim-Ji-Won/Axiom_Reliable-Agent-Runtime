import { gzipSync } from 'node:zlib';
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPublicReadWithTransport } from '../src/tools/public-repository-read-internal.js';
import { runId, decision, upstream, success, failed, bodyOfSize, withLoopback, deferred, bounded } from './public-repository-read-fixture.js';

const allow = { permitExecution: () => true };
describe('public read native fetch against owned loopback only', () => {
  it('sends fixed GET headers without user data, credentials, query or body', async () => {
    await withLoopback(async f => {
      const result = await createPublicReadWithTransport(allow, f.transport).execute(runId, decision);
      expect(result).toEqual(success); expect(f.attempts()).toBe(1); expect(f.requests).toHaveLength(1);
      const request = f.requests[0]!; expect(request.method).toBe('GET'); expect(request.url).toBe('/repos/nodejs/node'); expect(request.body).toBe('');
      expect(request.headers).toMatchObject({ accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Axiom-Public-Read-Tool' });
      expect(request.headers).not.toHaveProperty('authorization'); expect(request.headers).not.toHaveProperty('cookie');
      expect(JSON.stringify(request)).not.toMatch(/SECRET|12345678/);
    }, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(upstream)); });
  });
  it.each([301,302,307,308])('native redirect:error blocks %i target requests', async status => {
    await withLoopback(async f => {
      expect(await createPublicReadWithTransport(allow, f.transport).execute(runId, decision)).toEqual(failed());
      expect(f.requests.map(r => r.url)).toEqual(['/repos/nodejs/node']); expect(f.attempts()).toBe(1);
    }, (_req, res) => { res.writeHead(status, { location: '/must-not-follow' }); res.end('UPSTREAM_SECRET'); });
  });
  it.each([401,403,404,429,500,503])('native HTTP %i produces one sanitized failure', async status => {
    await withLoopback(async f => {
      expect(await createPublicReadWithTransport(allow, f.transport).execute(runId, decision)).toEqual(failed()); expect(f.attempts()).toBe(1); expect(f.requests).toHaveLength(1);
    }, (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('CREDENTIAL_SECRET'); });
  });
  it.each([65536,65537])('native chunked %i bytes without Content-Length', async size => {
    await withLoopback(async f => {
      expect(await createPublicReadWithTransport(allow, f.transport).execute(runId, decision)).toEqual(size === 65536 ? success : failed('invalid_tool_output'));
      expect(f.attempts()).toBe(1);
    }, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); const body = bodyOfSize(size); res.write(body.slice(0,20000)); res.end(body.slice(20000)); });
  });
  it.each([65536,65537])('bounds gzip decompressed %i bytes, ignoring smaller wire length', async size => {
    const compressed = gzipSync(bodyOfSize(size)); expect(compressed.length).toBeLessThan(1000);
    await withLoopback(async f => {
      expect(await createPublicReadWithTransport(allow, f.transport).execute(runId, decision)).toEqual(size === 65536 ? success : failed('invalid_tool_output'));
    }, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': compressed.length }); res.end(compressed); });
  });
  it('native broken stream is a transfer error, not invalid JSON', async () => {
    const reading = deferred();
    await withLoopback(async f => {
      const transport: typeof f.transport = async (url, init) => { const response = await f.transport(url, init); reading.resolve(); return response; };
      expect(await createPublicReadWithTransport(allow, transport).execute(runId, decision)).toEqual(failed()); expect(f.attempts()).toBe(1);
    }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
      void reading.promise.then(() => res.destroy());
    });
  });
  it.each(['headers','body','slow-chunks'])('one deadline aborts real native %s I/O and closes the socket', async mode => {
    const closed = deferred(); const arrived = deferred(); let chunks = 0; let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await withLoopback(async f => {
        const host = new AbortController(); let signal: AbortSignal | null | undefined;
        const transport: typeof f.transport = (url, init) => { signal = init.signal; return f.transport(url, init); };
        const start = performance.now(); const pending = createPublicReadWithTransport(allow, transport, 250).execute(runId, decision, { signal: host.signal });
        await bounded(arrived.promise);
        expect(await bounded(pending)).toEqual(failed()); await bounded(closed.promise);
        expect(signal!.aborted).toBe(true); expect(performance.now() - start).toBeLessThan(1500);
        expect(getEventListeners(host.signal, 'abort')).toHaveLength(0); expect(f.attempts()).toBe(1);
        if (mode === 'slow-chunks') expect(chunks).toBeGreaterThan(2);
      }, (_req, res) => {
        res.once('close', () => { clearInterval(timer); closed.resolve(); }); arrived.resolve();
        if (mode !== 'headers') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
        if (mode === 'slow-chunks') timer = setInterval(() => { chunks++; res.write(' '); }, 20);
      });
    } finally { clearInterval(timer); }
  });
  it.each(['headers','body'])('host abort during native %s cancels actual I/O without forwarding reason', async mode => {
    const arrived = deferred(); const headers = deferred(); const closed = deferred();
    await withLoopback(async f => {
      const host = new AbortController(); let signal: AbortSignal | null | undefined;
      const transport: typeof f.transport = async (url, init) => { signal = init.signal; const response = await f.transport(url, init); headers.resolve(); return response; };
      const pending = createPublicReadWithTransport(allow, transport).execute(runId, decision, { signal: host.signal });
      try {
        await bounded(mode === 'headers' ? arrived.promise : headers.promise); host.abort('HOST_SECRET');
        expect(await bounded(pending)).toEqual(failed()); await bounded(closed.promise); expect(signal!.aborted).toBe(true); expect(signal!.reason).not.toBe('HOST_SECRET');
        expect(getEventListeners(host.signal, 'abort')).toHaveLength(0); expect(f.attempts()).toBe(1);
      } finally { host.abort(); await pending; }
    }, (_req, res) => {
      res.once('close', closed.resolve); arrived.resolve();
      if (mode === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
    });
  });
  it.each(['http','type','size'])('actively cancels unfinished native response on %s rejection', async mode => {
    const closed = deferred();
    await withLoopback(async f => {
      expect(await createPublicReadWithTransport(allow, f.transport).execute(runId, decision)).toEqual(failed(mode === 'http' ? 'handler_error' : 'invalid_tool_output'));
      await bounded(closed.promise); expect(f.attempts()).toBe(1);
    }, (_req, res) => {
      res.once('close', closed.resolve);
      res.writeHead(mode === 'http' ? 500 : 200, { 'content-type': mode === 'type' ? 'text/html' : 'application/json' });
      res.write(mode === 'size' ? 'x'.repeat(65537) : 'SECRET');
    });
  });
});
