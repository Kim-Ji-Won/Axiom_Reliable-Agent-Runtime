# Axiom — Reliable Agent Runtime

Axiom is backend infrastructure for controlled, stateful AI-agent execution.
The model requests actions; the runtime determines whether they may execute.

## Current scope: P0-A1

This foundation provides an npm workspace, strict TypeScript, a Fastify API,
and injection-based tests. `GET /health` returns `200` with `{"status":"ok"}`.
It indicates API liveness only, not database readiness or dependency health.
Persistence, Run APIs, models, tools, workers, and durable execution are not implemented.

## Prerequisites

- Node.js 22.21.0 (recorded in `.nvmrc`; supported project line: Node 22)
- npm 10.9.4 was used for validation

If using nvm, run `nvm install` and `nvm use` from this directory.
Direct dependency versions are exact; `package-lock.json` records the resolved tree.
Engine compatibility is enforced through `.npmrc`.

## Commands

Run from the repository root:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm start
```

For development with automatic restarts:

```sh
npm run dev
```

The API binds to `127.0.0.1:3000`. No environment variables or `.env` file are required.
The port must be free. `npm start` runs compiled output and requires a prior build.
From another terminal:

```sh
curl --fail --include http://127.0.0.1:3000/health
```

Stop with Ctrl-C (SIGINT); SIGTERM also closes the Fastify server gracefully.
Tests use `app.inject()` without binding a TCP port and close their app instances.

## Boundaries

- `apps/api/src/app.ts`: constructs the application and registers health; does not listen.
- `apps/api/src/server.ts`: owns the listener and process shutdown.
- `apps/api/test/`: tests the same application constructor used by the server.
- `tsconfig.base.json`: shared strict compiler settings.

Build output is generated under `apps/api/dist/`; it excludes tests.
No unused packages are scaffolded. The local Git repository is initialized. P0-A1 establishes the initial main baseline; subsequent development uses feature branches, validation, review, and explicitly approved commits, pushes, and merges.
