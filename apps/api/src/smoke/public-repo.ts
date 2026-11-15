import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicRepositoryReadExecutor } from '../tools/public-repository-read-executor.js';

// No env-file, credential lookup, database, or model dependency. The UUID stays
// local. This opt-in is not proof of a running Run or user authorization.
export async function runPublicRepoSmoke(args: readonly string[]) {
  if (args.length !== 1 || args[0] !== '--allow-public-network') {
    return { status: 'BLOCKED', attempts: 0 } as const;
  }
  const executor = createPublicRepositoryReadExecutor({ permitExecution: () => true });
  const outcome = await executor.execute(randomUUID(), { kind: 'tool_request', toolName: 'github_public_repo_stats', arguments: {} });
  return { status: outcome.kind === 'tool_succeeded' ? 'PASS' : 'FAIL', attempts: 1, outcome } as const;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runPublicRepoSmoke(process.argv.slice(2));
  console.info(JSON.stringify({ timeKst: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
    node: process.version, target: 'https://api.github.com/repos/nodejs/node', ...result }));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
