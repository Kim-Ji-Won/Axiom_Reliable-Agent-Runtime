import { createServer, type RequestListener } from 'node:http';
import { expect } from 'vitest';
import type { PublicReadTransport } from '../src/tools/public-repository-read-internal.js';

export const runId = '12345678-1234-4234-8234-123456789abc';
export const decision = { kind: 'tool_request', toolName: 'github_public_repo_stats', arguments: {} };
export const upstream = { full_name: 'nodejs/node', private: false, stargazers_count: 123, forks_count: 45, archived: false };
export const success = { kind: 'tool_succeeded', output: { schemaVersion: 1, repository: 'nodejs/node', stars: 123, forks: 45, archived: false } };
export const failed = (code = 'handler_error') => ({ kind: 'tool_failed', code });
export function assertRequest(url: string, init: RequestInit) {
  expect(url).toBe('https://api.github.com/repos/nodejs/node');
  expect(Object.keys(init).sort()).toEqual(['credentials','headers','method','redirect','signal']);
  expect({ ...init, signal: undefined }).toEqual({ method: 'GET', redirect: 'error', credentials: 'omit', signal: undefined,
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Axiom-Public-Read-Tool' } });
  expect(init.signal).toBeInstanceOf(AbortSignal);
}
export function jsonResponse(body: unknown = upstream) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
export function bodyOfSize(size: number) {
  const text = JSON.stringify({ ...upstream, ignored: '' });
  return text.replace('"ignored":""', '"ignored":"' + 'a'.repeat(size - Buffer.byteLength(text)) + '"');
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { resolve, promise };
}
export async function bounded<T>(work: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Test barrier timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
// Only this fixture rewrites the URL, after checking the production request.
// No caller-supplied address and no fallback to the public internet.
export async function withLoopback(work: (f: { transport: PublicReadTransport; requests: { url: string; headers: object; method: string | undefined; body: string }[]; attempts(): number }) => Promise<void>, handler: RequestListener) {
  const requests: { url: string; headers: object; method: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    const record = { url: req.url ?? '', headers: req.headers, method: req.method, body: '' };
    requests.push(record); req.on('data', chunk => { record.body += chunk.toString(); });
    handler(req, res);
  });
  let attempts = 0;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    const transport: PublicReadTransport = (url, init) => {
      assertRequest(url, init); attempts++;
      return fetch(`http://127.0.0.1:${address.port}/repos/nodejs/node`, init);
    };
    await work({ transport, requests, attempts: () => attempts });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
