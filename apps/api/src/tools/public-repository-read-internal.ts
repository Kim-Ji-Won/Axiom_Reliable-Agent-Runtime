import { types } from 'node:util';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { createToolRegistry } from './tool-registry.js';
import { prepareToolDispatch, type PendingToolDispatch } from './tool-dispatch-preflight.js';
import { parseToolExecutionOutcome, type ToolExecutionFailureCode } from './tool-execution-outcome.js';

export interface PublicReadOptions { permitExecution?: ((plan: PendingToolDispatch) => boolean) | undefined }
export interface PublicReadCallOptions { signal?: AbortSignal }
export type PublicReadTransport = (url: string, init: RequestInit) => Promise<Response>;
const target = 'https://api.github.com/repos/nodejs/node';
const registry = createToolRegistry([{ name: 'github_public_repo_stats', inputSchema: z.strictObject({}) }]);
const nativeThen = Promise.prototype.then;
const ignore = () => {};
function observe(value: unknown) {
  if (!types.isProxy(value) && types.isPromise(value)) nativeThen.call(value, ignore, ignore);
}
const failed = (code: ToolExecutionFailureCode) => parseToolExecutionOutcome({ kind: 'tool_failed', code });

// Internal trusted transport seam, not an executor URL/proxy/header option. Tests
// MUST supply transport explicitly: missing injection never falls back to fetch.
export function createPublicReadWithTransport(options: PublicReadOptions, transport: PublicReadTransport, deadlineMs = 5000) {
  if (typeof transport !== 'function' || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5000) {
    throw new Error('Invalid public read transport configuration');
  }
  const gate = options.permitExecution;
  return Object.freeze({
    async execute(runId: unknown, rawDecision: unknown, call: PublicReadCallOptions = {}) {
      // Precedence: invalid input > denied gate > pre-aborted host signal.
      const plan = prepareToolDispatch(registry, runId, rawDecision);
      if (plan.kind !== 'pending_authorization') return plan;
      try {
        if (typeof gate !== 'function') return failed('execution_unavailable');
        const permission: unknown = gate(plan);
        if (permission !== true) { observe(permission); return failed('execution_unavailable'); }
      } catch { return failed('execution_unavailable'); }
      const host = call.signal;
      if (host?.aborted) return failed('handler_error');
      return readPublicRepository(transport, host, deadlineMs);
    },
  });
}

// Allow application/json or a syntactically valid application/*+json subtype,
// with no parameters except optional charset=utf-8 (quoted or unquoted).
function jsonMediaType(value: string | null): boolean {
  return value !== null && /^application\/(?:json|[a-z0-9!#$%&'*+.^_`|~-]+\+json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(value.trim());
}
function project(bytes: Uint8Array) {
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
  const data = raw as Record<string, unknown>;
  if (data.full_name !== 'nodejs/node' || data.private !== false || typeof data.archived !== 'boolean' ||
      typeof data.stargazers_count !== 'number' || !Number.isSafeInteger(data.stargazers_count) || data.stargazers_count < 0 ||
      typeof data.forks_count !== 'number' || !Number.isSafeInteger(data.forks_count) || data.forks_count < 0) throw new Error();
  return parseToolExecutionOutcome({ kind: 'tool_succeeded', output: {
    schemaVersion: 1, repository: 'nodejs/node', stars: data.stargazers_count, forks: data.forks_count, archived: data.archived,
  } });
}
async function readPublicRepository(transport: PublicReadTransport, host: AbortSignal | undefined, deadlineMs: number) {
  const controller = new AbortController();
  const expires = performance.now() + deadlineMs;
  let cancelWait!: () => void;
  const aborted = new Promise<never>((_, reject) => { cancelWait = () => reject(new Error('Public read cancelled')); });
  // Also observe if abort happens before the first race is installed.
  observe(aborted);
  const stop = () => { controller.abort(); cancelWait(); }; // Never forward host reason.
  const timer = setTimeout(stop, deadlineMs);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  const check = () => {
    if (host?.aborted || controller.signal.aborted || performance.now() >= expires) { stop(); throw new Error(); }
  };
  try {
    host?.addEventListener('abort', stop, { once: true });
    check(); // Recheck after gate and listener installation, immediately before I/O.
    const pending = transport(target, {
      method: 'GET', redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Axiom-Public-Read-Tool' },
      signal: controller.signal,
    });
    // A late response from a trusted adapter must not leave an unconsumed body.
    const received = pending.then(value => {
      if (controller.signal.aborted) { try { observe(value.body?.cancel()); } catch { /* cleanup only */ } }
      return value;
    });
    response = await Promise.race([received, aborted]);
    check();
    if (response.status !== 200) return failed('handler_error');
    if (!jsonMediaType(response.headers.get('content-type')) || !response.body) return failed('invalid_tool_output');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      check();
      const next = await Promise.race([reader.read(), aborted]);
      check();
      if (next.done) { completed = true; break; }
      // Count decompressed bytes delivered by native fetch, not Content-Length.
      if (next.value.byteLength > 65536 - size) return failed('invalid_tool_output');
      size += next.value.byteLength;
      chunks.push(next.value.slice());
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try {
      const outcome = project(bytes);
      check();
      return outcome;
    } catch {
      if (controller.signal.aborted) return failed('handler_error');
      return failed('invalid_tool_output');
    }
  } catch { return failed('handler_error'); }
  finally {
    clearTimeout(timer);
    host?.removeEventListener('abort', stop);
    if (!completed) {
      controller.abort();
      // Never body.cancel() while our reader holds its lock; cleanup is observed,
      // not awaited, so a stalled cancellation cannot extend the deadline.
      try { observe(reader ? reader.cancel() : response?.body?.cancel()); } catch { /* preserve original outcome */ }
    }
    try { reader?.releaseLock(); } catch { /* preserve original outcome */ }
  }
}
