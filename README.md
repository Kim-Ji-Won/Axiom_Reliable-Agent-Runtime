# Axiom — Reliable Agent Runtime

> Backend infrastructure for reliable, controlled execution of AI-agent workflows.

Axiom은 여러 단계로 이루어진 AI 에이전트 작업의 실행 상태와 제어를 관리하기 위한 백엔드 런타임 프로젝트입니다. 모델의 판단과 실제 행동의 실행 권한을 분리하고, 단계적인 개발을 통해 영속적 실행, 도구 검증, 승인 정책, 실행 이력을 갖추는 것을 목표로 합니다.

**현재 단계: P4-A — Trusted Host Authorization Policy 로컬 구현·검토 중. P3-A~F 병합·main 검증 완료. P0-A1~A4, P1-A~G 및 P2-A~F 병합·검증 완료.** PostgreSQL repository를 사용하는 Run 생성·조회 HTTP API와 공유 Zod 계약을 추가했습니다. 내부 `tryStartRun(id)`와 `tryFinishRun(id, outcome)`으로 `queued → running → completed | failed` 전이를 지원합니다. 내부 one-shot 실행과 최대 5회 결정의 bounded loop를 제공하며 자동 실행·실제 모델 호출은 연결하지 않았으며, 외부 읽기는 아래 P2-F의 명시적 내부 구성에서만 허용합니다.

## Overview · 프로젝트 개요

AI 에이전트가 외부 도구를 사용하며 장시간 작업하려면, 모델의 응답뿐 아니라 실행 과정 자체를 관리해야 합니다. 프로세스가 중단되었을 때의 복구 지점, 재시도 가능한 실패, 중복 실행의 영향, 사용자 승인이 필요한 행동을 명확하게 정의해야 합니다.

Axiom은 이러한 실행 제어를 담당하는 공통 Runtime을 지향합니다. GitHub 작업, 장애 대응, 리서치 등 서로 다른 에이전트가 동일한 실행 기반을 사용할 수 있도록 특정 업무와 실행 인프라의 책임을 분리합니다.

## Design Principles · 설계 원칙

**A model request is not execution authorization.** 모델은 행동을 요청하고, Runtime은 그 행동의 실행 가능 여부를 결정합니다.

다음은 단계적으로 구현할 책임 경계입니다. 현재 구현은 Run HTTP API, PostgreSQL persistence, 모델 결정 계약, 내부 one-shot/bounded orchestration, Step metadata 저장소와 종료·기록의 원자적 결합, 실행 없는 Tool Registry·입력 snapshot 검증, Dispatch Preflight·실행 결과 데이터 계약과 신뢰된 순수 Handler를 위한 내부 In-Memory Executor와 선택적으로 호출하는 Run-Aware Tool Loop 및 별도 내부 API의 제한된 Safe Result 저장, 고정 공개 저장소 조회 Executor까지입니다.

| 영역 | 책임 |
| --- | --- |
| API | 외부 요청 검증, HTTP 응답과 오류 변환 |
| Runtime | 실행 상태 전이, 실행 허용 여부, 재시도·승인·예산 제어 |
| Model Provider | 모델 호출과 응답을 공급자 독립적인 계약으로 변환 |
| Tool System | 명시적으로 등록된 도구의 입력 검증과 실행 |
| Persistence | 실행 데이터 저장, 조회, 트랜잭션 |
| Contracts | 입력·응답 스키마와 공유 타입 |

- **Explicit boundaries:** 모델 호출, 도구 실행, 저장, 실행 제어의 책임을 분리합니다.
- **Untrusted model output:** 모델 출력을 검증하며, 도구 호출 요청 자체를 권한으로 취급하지 않습니다.
- **Defined durability:** 상태 필드를 저장하는 것만으로 durable execution을 보장한다고 주장하지 않습니다. 복구·재시도·중복 실행의 의미와 테스트를 함께 정의합니다.
- **Incremental delivery:** 현재 단계에 필요한 기능과 의존성만 추가하고, 작은 변경 단위로 검증합니다.

## Current Status · 구현 현황

현재 구현하고 검증한 범위는 다음과 같습니다.

| 항목 | 현재 상태 |
| --- | --- |
| Workspace | npm workspaces 기반 TypeScript 구성 |
| Type safety | strict 타입 검사와 테스트 코드 타입 검사 |
| Application | 포트를 열지 않는 `buildApp()` 구성 함수 |
| Process lifecycle | 별도 서버 진입점, SIGINT·SIGTERM 종료 처리 |
| Health endpoint | `GET /health` → `200 {"status":"ok"}` |
| Automated tests | HTTP 계약·오류·DB 안전장치 및 실제 PostgreSQL 통합 테스트 |
| Baseline validation | 타입 검사, 빌드, 테스트, 실제 HTTP 요청 및 두 종료 신호 검증 완료 |

`/health`는 **API liveness**만 나타냅니다. 데이터베이스 readiness나 외부 의존성의 정상 동작을 확인하지 않습니다.

P0-A2에서는 PostgreSQL 개발·테스트 환경, 마이그레이션, Run repository와 DB 통합 테스트를 추가했습니다. P0-A3에서는 Run 생성·조회 API를 추가했습니다. 모델 호출, 외부 쓰기 도구 실행, 워커, 사용자 승인 정책과 durable execution은 향후 구현 범위입니다. 현재 단계는 로컬 개발 기반이며 production readiness를 보장하지 않습니다.

## Architecture · 프로젝트 구조

현재 존재하는 주요 파일과 역할입니다.

```text
Axiom/
├── apps/api/
│   ├── src/
│   │   ├── app.ts              # Fastify 앱 구성, health 및 Run routes
│   │   ├── server.ts           # 서버 기동과 프로세스 종료
│   │   ├── persistence/        # DB pool, Run/Step, finalizer, continue/tool recorder, safe result/Lease/Progress repository 및 내부 Lease write guard
│   │   ├── runtime/            # one-shot / bounded / bounded-tool decisions
│   │   ├── smoke/public-repo.ts # 명시적 opt-in 공개 읽기 smoke (자동 실행 없음)
│   │   └── tools/              # Registry / Snapshot / Preflight / Outcome / Executors / Result Policy
│   ├── test/
│   │   ├── health.test.ts      # liveness 및 미등록 경로 테스트
│   │   ├── persistence.test.ts # 입력 및 테스트 DB 안전장치
│   │   ├── run-step-repository.test.ts # Step 입력·반환·연결 정리 경계
│   │   ├── atomic-run-finalizer.test.ts # 종료·Step 트랜잭션 및 실패 경계
│   │   ├── bounded-runtime.test.ts # 기존 실행 예산·순서·중단 경계
│   │   ├── bounded-tool-runtime.test.ts # Tool 예산·context·외부 종료·보안 경계
│   │   ├── tool-result-policy.test.ts # Strict Safe Result·허용 목록·hostile input
│   │   ├── run-tool-result-repository.test.ts # 원자적 저장·조회·만료·실패
│   │   ├── run-tool-step-recorder.test.ts # Tool Step COMMIT·연결 정리
│   │   ├── run-continue-recorder.test.ts # continued 트랜잭션·연결 정리
│   │   ├── runtime.test.ts     # claim·결정·종료 및 오류 경계
│   │   ├── model-decision.test.ts # 모델 결정·JSON 안전성 및 경계 검증
│   │   ├── tool-request-resolver.test.ts # Registry·strict schema·TOCTOU·비실행 경계
│   │   ├── tool-arguments-snapshot.test.ts # JSON 경계·독립 복사·deep freeze
│   │   ├── tool-dispatch-preflight.test.ts # UUID·재검증·불변 Plan·비실행 경계
│   │   ├── tool-execution-outcome.test.ts # strict 결과 계약·output snapshot·오류 비노출
│   │   ├── in-memory-tool-executor.test.ts # Default Deny·Gate·Handler·출력 및 I/O 경계
│   │   ├── public-repository-read*.ts # mock/native loopback 테스트 및 공용 fixture
│   │   ├── execution-lease.test.ts # Lease 입력·잠금 순서·COMMIT·비노출
│   │   ├── lease-aware-persistence.test.ts # Credential snapshot·쓰기 Guard·실패 경계
│   │   ├── runs-http.test.ts   # Run 계약·오류·라우터 회귀 테스트
│   │   └── db/                # runs/run-steps/atomic-finalization/bounded-runtime/bounded-tool-runtime/tool-results/public-repository-read/execution-leases/lease-aware-persistence.test.ts, process-fixture.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── tsconfig.build.json
├── packages/contracts/        # 공유 Zod 스키마·타입, src/index.ts 및 model-decision.ts
├── db/                        # 마이그레이션 실행기와 migrations/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── .npmrc
├── .nvmrc
├── package.json
├── package-lock.json
├── tsconfig.base.json
└── README.md
```

`app.ts`는 네트워크 포트를 열지 않으며, `server.ts`가 실제 listener를 시작합니다. 자동 테스트도 같은 앱 구성 함수를 사용합니다. 빌드 결과는 `apps/api/dist/`와 `packages/contracts/dist/`에 생성되며 테스트 파일과 생성 산출물은 각각 빌드 대상과 Git 추적 대상에서 제외됩니다.

Runtime, Model, Tool 패키지는 해당 단계에서 실제 역할이 필요할 때 추가합니다.

## Getting Started · 실행 방법

### Requirements

- **Node.js 22.21.0:** `.nvmrc`에 기록된 검증 버전입니다. 프로젝트의 허용 범위는 `>=22.21.0 <23`입니다.
- **npm 10.9.4:** baseline 검증에 사용한 버전입니다.
- **macOS의 Docker Desktop:** 앱을 시작하고 Docker Engine이 실행 중인지 확인합니다 (`docker info`).

직접 의존성은 정확한 버전으로 지정하고, 전체 의존성 트리는 `package-lock.json`으로 기록합니다. `.npmrc`에서 engine 호환성을 검사합니다.

아래 명령은 모두 프로젝트 루트에서 실행합니다. nvm을 사용한다면 먼저 버전을 선택합니다.

```sh
nvm install
nvm use
```

### Install, Test & Run · macOS 루트 실행 순서

저장소 루트(예: `cd /Users/jiwon/Axiom`)에서 실행합니다. 다른 경로에 clone했다면 실제 저장소 경로로 이동하세요.

```sh
npm ci
# .env가 없는 경우에만 예시를 복사합니다.
if [ ! -f .env ]; then cp .env.example .env; fi
# 편집기로 .env의 두 비밀번호와 각 URL 비밀번호를 일치시켜 설정합니다.
# 기존 .env와 기존 볼륨의 비밀번호는 그대로 유지합니다.
npm run db:up
npm run db:migrate:test
npm run typecheck
npm run build
npm test
npm run test:db
```

`test:db`는 `axiom_test`의 실행별 임시 schema에서 실제 HTTP 서버 A의 POST → 정상 종료 → 새 서버 B의 GET 일치를 검증합니다. 자동 테스트는 개발 DB에 쓰지 않으며 성공·실패 모두 자신의 schema와 연결을 정리합니다.

수동 API 확인은 개발 DB를 사용합니다. 아래 migration은 기존 적용 이력을 유지합니다. POST로 만든 Run은 개발 DB에 남습니다.

```sh
npm run db:migrate
npm start
```

서버는 `http://127.0.0.1:3000`에서 실행하므로 포트가 비어 있어야 합니다. `npm start`는 빌드된 서버를 실행하고 **루트 `.env`를 읽습니다**. 셸에서 이미 전달한 환경 변수가 우선합니다. DB가 없어도 `/health`는 `200 {"status":"ok"}`이며 Run API는 `503`을 반환합니다.

별도 터미널에서 다음 순서로 생성·조회합니다. 첫 응답의 네 필드를 보관하고 ID를 그대로 사용하세요.

```sh
curl --fail --include http://127.0.0.1:3000/health
curl --fail --include http://127.0.0.1:3000/runs \
  -H 'Content-Type: application/json' -d '{"task":"회의록 정리"}'
# POST 201 응답의 실제 UUID로 교체
RUN_ID='여기에-응답의-UUID'
curl --fail --include "http://127.0.0.1:3000/runs/$RUN_ID"
```

서버 터미널에서 **Ctrl-C(SIGINT)**로 종료하고 `Server closed`를 확인한 뒤, 같은 루트에서 다시 `npm start`를 실행합니다. 요청 터미널에서 위 GET을 다시 실행해 `200`과 최초 응답의 `id`, `task`, `status`, `createdAt` 네 값이 모두 같은지 확인합니다. SIGTERM으로도 정상 종료할 수 있습니다.

확인을 마치면 서버를 Ctrl-C로 종료하고 루트에서 DB를 정지합니다. 볼륨과 Run은 보존합니다.

```sh
npm run db:stop
```

### Development

현재 `npm run dev`는 `.env`를 자동으로 읽지 않습니다. Run API를 사용하려면 **실행 셸에 `DATABASE_URL`을 전달**해야 합니다. 비밀번호를 명령 이력에 직접 입력하지 않으려면 macOS zsh에서 다음과 같이 입력할 수 있습니다.

```sh
read -rs 'DATABASE_URL?DATABASE_URL: '; echo
export DATABASE_URL
npm run dev
# 종료 후 필요하다면 unset DATABASE_URL
```

`tsx watch`가 API 소스 변경을 감시합니다. contracts 소스를 수정했다면 `npm run build:contracts` 후 dev 서버를 다시 시작하세요. watch mode의 자동 재시작은 HTTP 프로세스 재시작 영속성 테스트와 별개이며 이번 검증 범위에 포함하지 않습니다.

## PostgreSQL · 로컬 저장 환경

Docker Desktop과 Docker Compose가 필요합니다. API는 컨테이너화하지 않으며 Compose는 PostgreSQL만 실행합니다.

위 실행 순서에서 환경 파일 준비·DB 시작·migration·테스트를 수행합니다. `.env`는 Git에서 제외됩니다. URL 비밀번호에 특수문자가 포함되면 URL encoding이 필요합니다. Node의 `--env-file-if-exists`를 사용하는 start/migration/test:db 명령과, 셸 환경만 받는 dev 명령을 구분하세요.

| 환경 | DB / 사용자 | 호스트 접속 | Compose 볼륨 |
| --- | --- | --- | --- |
| 개발 | `axiom` | `127.0.0.1:56432` | `postgres_dev` |
| 테스트 | `axiom_test` | `127.0.0.1:56433` | `postgres_test` |

두 환경은 별도 컨테이너·클러스터·볼륨·비밀번호를 사용합니다. 이미지 태그는 `postgres:17-alpine`으로 major를 고정하고 patch 갱신을 허용합니다. 비밀번호 환경 변수는 빈 볼륨의 최초 초기화에 적용되므로 기존 볼륨의 비밀번호는 `.env` 수정만으로 바뀌지 않습니다.

- `AXIOM_DB_PASSWORD`, `AXIOM_TEST_DB_PASSWORD`: Compose 초기화용 비밀번호.
- `DATABASE_URL`, `TEST_DATABASE_URL`: Node DB 연결 및 migration/test 대상. 코드에 연결 문자열을 하드코딩하지 않습니다.
- migration/test 도구는 로컬 호스트·정확한 DB명과 사용자·URL 옵션 부재를 검증하고, 연결 후 실제 DB와 사용자도 확인합니다. 테스트는 개발 URL로 fallback하지 않습니다.
- `npm run db:stop`은 컨테이너를 정지하고 데이터를 유지합니다. 볼륨 삭제는 데이터를 제거하므로 일반 실행·테스트 절차에 포함하지 않습니다.

### Schema & Repository

| 컬럼 | 정의 |
| --- | --- |
| `id` | UUID primary key; Node `crypto.randomUUID()`로 생성 |
| `task` | top-level user task; 원문 유지, 1~4000 Unicode code points, trim 결과가 비어 있으면 거부 |
| `status` | TEXT, 기본값 `queued`, CHECK로 `queued`, `running`, `completed`, `failed` 허용 |
| `created_at` | TIMESTAMPTZ, DB의 `NOW()` 기본값 |

애플리케이션은 잘못된 타입·빈 값·공백 전용 값·길이 초과·NUL·잘못된 Unicode 문자열을 거부합니다. DB는 NOT NULL, 길이, JavaScript trim 공백 집합에 해당하는 nonblank CHECK, status CHECK 및 UUID/PK 제약을 독립적으로 강제합니다. emoji도 PostgreSQL `char_length`와 동일하게 code point 단위로 셉니다. 사용자 입력의 양끝 공백은 저장 전에 제거하지 않습니다.

`createRunRepository(db)`는 `createRun(task): Promise<Run>`, `findRunById(id): Promise<Run | null>`, 내부 연산 `tryStartRun(id): Promise<Run | null>`과 `tryFinishRun(id, outcome): Promise<Run | null>`을 제공합니다. 반환값은 `{ id, task, status: 'queued' | 'running' | 'completed' | 'failed', createdAt: Date }`입니다. 생성은 항상 `queued`이고 호출자가 status를 지정할 수 없습니다. 조회는 네 상태를 모두 지원합니다. 오류는 숨기지 않고 호출자에게 전달하며 DB 오류나 task 내용을 그대로 로그에 남기지 않습니다.

각 생성은 parameterized INSERT 한 문장이므로 DB의 단일 문장 원자성을 사용합니다. `createDatabase(url)`로 만든 pool의 종료 책임은 호출자에게 있습니다. `withDatabase(url, work)`는 성공·실패 모두 `finally`에서 pool을 종료합니다. HTTP 앱은 DB 설정이 있으면 pool 하나를 소유하고 요청 간 재사용하며 `app.close()`에서 종료합니다. 연결은 요청 시 시작하므로 DB가 꺼져도 `/health`는 정상 동작합니다.

### Internal Start · 내부 시작 연산

`tryStartRun(id)`는 `UPDATE runs SET status = 'running' WHERE id = $1 AND status = 'queued' RETURNING …` 한 문장으로 상태를 바꿉니다. 성공 시 갱신된 Run을 반환하며 `id`, `task`, `createdAt`은 유지합니다. 유효한 UUID가 없거나 이미 시작됐다면 `null`, 잘못된 UUID라면 기존 입력 오류를 반환합니다. 두 독립 연결의 동시 요청에서도 한쪽만 성공하도록 DB가 조건을 재확인합니다.

시작 HTTP 엔드포인트는 없습니다. POST는 계속 `queued`로 생성하며 `status` 추가 필드를 거부합니다. 내부에서 시작한 Run은 기존 GET에서 `running`으로 확인할 수 있습니다. 모델 호출·worker·자동 실행은 아직 구현하지 않았습니다.

### Internal Finish · 내부 종료 연산

`tryFinishRun(id, outcome)`은 `completed` 또는 `failed`만 허용합니다. UUID와 outcome을 SQL 전에 검증하고 `UPDATE runs SET status = $2 WHERE id = $1 AND status = 'running' RETURNING …` 한 문장으로 종료합니다. 성공하면 갱신된 Run, 미존재·queued·이미 종료된 Run이면 `null`을 반환합니다. 완료와 실패가 경합해도 한쪽만 성공하며 종료된 Run은 재시작하거나 재종료할 수 없습니다. 기존 GET은 종료 상태도 같은 네 필드로 반환하고 `id`, `task`, `createdAt`은 유지됩니다. 종료 HTTP 엔드포인트와 결과 본문·실패 사유 저장은 포함하지 않습니다.

### Model Decision Contract · 모델 결정 제안

`@axiom/contracts`는 `modelDecisionSchema`, `parseModelDecision(raw: unknown)`, 공유 타입 `ModelDecision`·`JsonObject`를 제공합니다. 두 진입점 모두 동일한 안전성 검증을 수행합니다.

```ts
{ kind: 'continue' }
{ kind: 'final', content: '분석 결과입니다.' }
{ kind: 'tool_request', toolName: 'search_documents', arguments: { query: 'PostgreSQL' } }
```

`continue`는 다음 결정을 요청하는 내부 제어 신호이며 `kind` 외 속성을 허용하지 않습니다. 외부 행동의 권한이나 사용자 승인을 부여하지 않습니다.

`final.content`는 원문을 보존하며 1~4000 Unicode code points, 비공백 텍스트만 허용합니다. NUL과 짝이 맞지 않는 surrogate를 거부합니다. `toolName`은 소문자로 시작하는 1~64자의 소문자·숫자·`_`·`-`입니다. 세 variant 모두 추가 필드와 암묵적 타입 변환을 거부합니다.

`arguments`는 JSON 객체이며 루트 객체를 깊이 1로 세고 중첩 객체·배열은 최대 깊이 8까지 허용합니다. 공백 없는 `JSON.stringify(arguments)` 형식의 UTF-8 크기는 최대 8192 bytes입니다. 키·구분자·escape·반복 참조의 직렬화 크기도 포함합니다. 검증은 객체의 getter나 `toJSON`을 실행하지 않고 data property를 검사하며 문자열·유한 숫자·boolean·null·배열·객체를 보존합니다.

Node.js의 `util.types.isProxy`로 Proxy를 탐지해 trap 실행 전에 거부합니다. 같은 realm의 plain object(Object.prototype 또는 null prototype)와 밀집 배열만 받으며 accessor·symbol key·숨겨진 속성·사용자 지정 prototype·비 JSON 객체·순환 참조를 거부합니다. 방문 깊이와 값/문자열 처리량은 제한하지만 `Reflect.ownKeys` 자체는 전달된 객체의 전체 키 목록을 생성합니다. 입력 객체의 생성 및 전송 크기 제한은 호출 경계에서도 적용해야 합니다. 현재 구현은 Node.js용이며 브라우저 지원은 검증하지 않았습니다.

`parseModelDecision`은 실패 시 Run 입력 오류와 별개의 `InvalidModelDecisionError`를 던집니다. 스키마는 Zod 오류를 반환하며, 실패 입력은 오류 생성 전에 제거해 `reportInput` 옵션에서도 원문·인자·비밀정보가 담기지 않도록 합니다. 이 parser 자체는 인자를 복사·freeze하지 않으며 중첩 참조를 유지합니다. P2-A Resolver는 이 결과도 다시 검증하고 독립적인 불변 snapshot으로 전환합니다.

**A model request is not execution authorization.** `tool_request`는 모델의 도구 요청 제안이며 실행 승인은 별도 Runtime 정책의 책임입니다. `final`도 최종 텍스트 제안입니다. P1-C는 결정 계약과 입력 검증을 담당합니다. 내부 실행 제어는 아래 Runtime에 있으며 모델 호출·provider adapter·권한 정책·실제 도구 실행은 후속 단계입니다.

### One-Shot Runtime · 단일 결정 실행 (P1-D 완료)

`apps/api/src/runtime/run-one-decision.ts`의 `runOneDecision(runId, { repository, finalizer, decide })`는 기존 `tryStartRun`, 필수 atomic finalizer와 주입된 테스트용 `decide(run): Promise<unknown>`를 연결합니다. 실제 모델 호출이나 HTTP 호출 경로는 연결하지 않았습니다.

```text
queued → 원자적 claim → running → decide 1회 → parseModelDecision → 종료 시도
```

| 상황 | 종료 시도 | 반환 결과 |
| --- | --- | --- |
| 미존재·이미 running·종료 Run | 없음, decide 호출 없음 | `not_started` |
| 유효한 final | completed | 종료 성공 시에만 `completed`와 원문 `content` |
| 유효한 tool_request | failed | `unsupported_tool_request` |
| 유효한 continue (one-shot) | failed | `decision_limit_exceeded`, decide는 여전히 1회 |
| 계약 위반 | failed | `invalid_decision` |
| 결정 함수 throw/reject | failed | `decision_source_error` |
| 어떤 종료 시도든 null 반환 | 추가 조회·재시도 없음 | `finalize_conflict` |

**A model request is not execution authorization.** 도구 요청은 현재 초기 정책에 따라 failed로 종료하며 Tool Registry 조회·승인·실행은 수행하지 않습니다. `completed` 이외의 결과에는 모델 원문·도구 이름·인자·task·결정 함수 오류를 담지 않으며 Runtime은 이를 로그에 남기지 않습니다. 최종 텍스트는 호출자에게만 일시적으로 반환하고 DB나 HTTP 응답에 저장·추가하지 않습니다.

잘못된 UUID와 시작·종료 DB 오류는 호출자에게 reject되며 정상 결과로 위장하지 않습니다. 호출자는 persistence 예외의 상세 내용을 그대로 로그나 외부 응답에 노출하지 않아야 합니다. Runtime은 pool을 만들거나 닫지 않으며 의존성을 제공한 호출자가 연결 수명을 관리합니다.

이 기능은 in-process 한 번의 결정 시도입니다. 프로세스 중단이나 DB 오류로 Run이 running에 남을 수 있고 자동 복구하지 않습니다. exactly-once 실행, retry, timeout, cancellation, durable recovery, 여러 단계의 실행 루프를 보장하지 않습니다. `decide`는 신뢰하는 주입 코드이며 Runtime이 해당 함수의 부작용을 격리하지는 않습니다. P1-D는 병합 완료됐으며 P1-F 구현에서 종료와 Step 기록을 연결했습니다.

### Run Step History · 단계 결과 메타데이터 (P1-E 완료)

`createRunStepRepository(pool)`는 API 내부의 독립 저장소입니다. `appendRunStep(runId, resultKind)`는 `{ runId, stepNo, resultKind, createdAt: Date }`를 반환하며 미존재 Run이면 null입니다. `listRunSteps(runId)`는 한 SQL의 LEFT JOIN으로 Run 존재 여부와 이력을 함께 읽고 `stepNo ASC` 순서로 반환합니다. 존재하는 Run의 빈 이력은 `[]`, 미존재 Run은 null입니다. Update/Delete 메서드는 제공하지 않습니다.

네 번째 migration `1794448800000-create-run-steps.cjs`는 아래 컬럼만 저장합니다.

| 컬럼 | 정의 |
| --- | --- |
| `run_id` | UUID, NOT NULL, runs(id) FK; 자동 CASCADE 삭제 없음 |
| `step_no` | INTEGER, 양수, run_id와 복합 PK |
| `result_kind` | TEXT, NOT NULL, 현재 열한 값의 CHECK (여섯 번째 migration 포함) |
| `created_at` | TIMESTAMPTZ, NOT NULL, DB의 NOW() 기본값 |

조회 가능한 결과는 `completed`, `unsupported_tool_request`, `invalid_decision`, `decision_source_error`, `finalize_conflict`, `continued`, `decision_limit_exceeded`, `tool_succeeded`, `tool_failed`, `tool_request_rejected`, `tool_execution_limit_exceeded`입니다. 기존 일반 `appendRunStep()`은 앞의 다섯 종류만 받습니다. `continued`는 아래 Continue Recorder에서만, `decision_limit_exceeded`는 Atomic Finalizer에서 failed 종료와 함께 기록합니다. `not_started`는 기록하지 않습니다. 사용자 task, final content, 모델 원문, 도구 이름·인자, 예외 상세와 자격증명을 저장할 컬럼은 없습니다. UUID와 결과 종류는 연결을 얻기 전에 검증하고 입력 오류에는 원문을 담지 않습니다. DB 오류는 호출자에게 전달하며 저장소 자체에서 로그를 남기지 않습니다.

Append마다 pool에서 전용 연결을 빌려 `BEGIN ISOLATION LEVEL READ COMMITTED → runs 부모 행 SELECT FOR UPDATE → MAX(step_no)+1 INSERT → COMMIT`을 수행합니다. 부모 잠금을 얻은 뒤 별도 SQL에서 새 snapshot으로 다음 순번을 계산하므로 지원되는 append 경로에서는 같은 Run의 동시 요청이 1, 2로 기록됩니다. 다른 Run의 번호는 독립적입니다. 실패하면 같은 연결에서 ROLLBACK하고 연결을 반환하며 rollback도 실패하면 연결을 폐기합니다. Pool 자체의 종료 책임은 호출자에게 있습니다. 이미 트랜잭션 중인 공유 client를 연결 제공자로 전달하는 방식은 지원하지 않습니다.

이력 순서는 timestamp가 아닌 `step_no`로 판단합니다. 순번 보장은 이 repository의 append 경로에 한정하며 외부 SQL 수정·삭제까지 통제하지 않습니다. INTEGER 범위를 넘으면 DB 오류가 발생하고 재시도하지 않습니다. COMMIT 중 연결 장애는 결과가 불확실할 수 있으므로 자동 retry나 exactly-once를 보장하지 않습니다.

네 번째 migration의 down은 runner의 단일 트랜잭션 안에서 `run_steps`를 ACCESS EXCLUSIVE로 잠근 뒤 행 존재를 검사합니다. 빈 테이블만 제거하고 세 migration 상태로 복귀합니다. 이력이 있으면 오류로 중단하여 Step·Run 데이터, 제약과 migration 이력을 보존합니다. 기존 임시 테스트 schema 전용 rollback 제한을 유지합니다.

독립 `appendRunStep()`은 Run 상태를 변경하지 않습니다. 이 저장소는 외부 SQL 변경을 통제하는 감사 원장이 아닙니다. Runtime의 종료와 기록 결합은 아래 P1-F의 별도 finalizer를 사용합니다.

### Atomic Runtime Finalization · 종료와 Step 기록 (P1-F 완료)

`createAtomicRunFinalizer(pool).tryFinalizeWithStep(runId, resultKind)`는 성공 시 `{ run, step }`, 미존재·queued·종료된 Run이면 `null`을 반환합니다. UUID와 아래 다섯 종료 resultKind 및 P2-D의 세 Tool 실패 kind를 연결 획득 전에 검증하며 상태는 내부에서 결정합니다.

| Runtime 결과 | Run 상태 | 저장 Step |
| --- | --- | --- |
| completed | completed | completed |
| unsupported_tool_request | failed | unsupported_tool_request |
| invalid_decision | failed | invalid_decision |
| decision_source_error | failed | decision_source_error |
| decision_limit_exceeded | failed | decision_limit_exceeded |
| not_started | 변경 없음 | 기록 없음 |
| finalize_conflict | 외부 승자 유지 | 추가 기록 없음 |

전용 idle connection 한 개에서 `BEGIN ISOLATION LEVEL READ COMMITTED → UPDATE runs WHERE id=$1 AND status='running' RETURNING → 별도 INSERT … MAX(step_no)+1 → COMMIT`을 수행합니다. UPDATE가 부모 Run 잠금을 잡으며, 그 뒤 새 statement snapshot에서 순번을 계산하므로 기존 append 경로와도 번호 할당이 직렬화됩니다. 같은 Run의 두 finalizer 중 승자만 종료와 Step 한 건을 기록하고 패자는 null입니다.

`runOneDecision()`은 `{ repository, finalizer, decide }`를 필수로 받습니다. finalizer 없이 기존 `tryFinishRun()`으로 fallback하지 않습니다. 결정 종류를 finalizer에 한 번 전달하고 COMMIT 성공 후에만 결과를 반환합니다. Tool Request는 승인이나 실행 권한이 아니며 도구를 실행하지 않습니다. Final content는 반환 시에만 사용하고 영속 저장하지 않습니다. 모델 원문·tool 이름/인자·예외 상세도 추가 저장하거나 로그에 남기지 않습니다.

INSERT 및 확정적인 COMMIT 실패에서는 Run UPDATE와 Step INSERT를 함께 rollback하고 DB 오류를 호출자에게 전달합니다. rollback 실패 연결은 폐기하며 모든 COMMIT 오류 연결도 보수적으로 폐기합니다. COMMIT 중 연결 단절은 실제 반영 여부가 불확실할 수 있고 자동 재시도하지 않습니다. 호출자는 전달된 DB 오류의 상세를 외부에 노출하지 않아야 하며 pool 수명도 관리합니다.

원자적 범위는 **종료 상태 + 결과 Step 한 건**입니다. 시작·decide·종료 전체가 하나의 트랜잭션은 아니며 프로세스 장애나 DB 오류 뒤 running이 남을 수 있습니다. 기존 direct `tryFinishRun()`은 Step을 자동 기록하지 않고 별도 `appendRunStep()`도 종료를 의미하지 않습니다. 순번은 지원되는 부모 잠금 경로에서만 보장합니다. Durable/Exactly-Once, retry, recovery, 실제 모델·도구 실행은 보장하거나 구현하지 않습니다. P1-F는 병합 완료됐습니다. `continued`는 종료 입력으로 거부합니다.

### Bounded Decision Loop · 제한된 내부 반복 (P1-G 완료)

`runBoundedDecisions(runId, { repository, finalizer, continueRecorder, decide }, { maxDecisions })`는 `run-one-decision.ts`와 별도의 내부 API입니다. `maxDecisions`는 필수 정수 **1~5**이며 잘못된 값이나 필수 의존성 누락은 claim·DB 접근·decide 전에 고정 오류로 거부합니다. claim은 한 번만 시도하고, 실패하면 `not_started`로 반환하며 Step을 쓰지 않습니다.

```text
claim → running → decide → 검증
  continue + 예산 남음 → continued COMMIT → 상태 재확인 → 다음 decide
  continue + 예산 소진 → failed + decision_limit_exceeded 원자적 COMMIT
  final → completed + completed Step 원자적 COMMIT → content 반환
  tool_request / invalid / source error → failed + 해당 Step 원자적 COMMIT
```

각 결정은 순차 처리하며 Step은 최대 한 건만 추가합니다. 예산 3에서 세 번 `continue`하면 이력은 `continued → continued → decision_limit_exceeded`이고 decide는 정확히 3회입니다. 마지막 결정에 continued를 중복 기록하지 않습니다. 기존 `runOneDecision()`도 계속 제공하며 continue이면 추가 decide 없이 limit 실패 Step 한 건을 기록합니다.

`createRunContinueRecorder(pool).appendContinuedStepIfRunning(runId)`는 UUID 검증 후 전용 idle connection에서 `BEGIN READ COMMITTED → SELECT runs FOR UPDATE → running 확인 → 별도 INSERT MAX(step_no)+1 → COMMIT`을 수행합니다. Run 상태를 바꾸지 않고 Step metadata만 기록합니다. Atomic Finalizer는 종료 상태와 종료 Step 한 건을 함께 확정합니다. 두 연산은 일반 append 및 direct finish와 같은 부모 잠금을 사용합니다. 미존재·비running이면 recorder는 null, Runtime은 `finalize_conflict`로 중단합니다. 기존 COMMIT 이력과 외부 종료 승자 상태를 유지하며 재시도하지 않습니다.

다음 decide 전에는 `findRunById()`로 상태를 다시 읽고 종료를 관찰했다면 호출하지 않습니다. 이 조회는 실행 lease가 아니므로 조회 직후 다른 연결이 종료할 가능성까지 제거하지는 않습니다. 그 경우에도 recorder/finalizer가 잠금 아래 상태를 다시 검사하여 종료 후 continued나 추가 종료 Step을 기록하지 않습니다. decide 동안 장시간 DB 잠금을 유지하지 않습니다.

모델·도구 provider, registry, 네트워크 및 새 HTTP 경로는 연결하지 않았습니다. continue와 tool_request는 실행 권한이 아닙니다. final content는 종료 COMMIT 후 호출자에게만 반환하고 모델 원문·tool 이름/인자·예외·자격증명은 Step이나 Runtime 실패 결과에 넣지 않습니다. DB 오류는 원래 오류로 reject되므로 호출자는 상세를 외부에 노출하지 않아야 합니다.

Continue INSERT 실패는 rollback하며 COMMIT 오류와 rollback 실패 연결은 폐기합니다. 이미 확정된 continued 이력은 유지합니다. COMMIT 응답 손실은 반영 여부가 불확실할 수 있으며 자동 retry하지 않습니다. 이 루프는 **한 프로세스 호출 내 결정 횟수**만 제한합니다. 프로세스 재시작 후 예산 복구, running 잔류 복구, timeout/cancellation, Durable/Exactly-Once를 보장하지 않습니다. 주입된 decide는 신뢰 코드이며 함수 자체의 부작용이나 응답 대기 시간을 격리하지 않습니다.

다섯 번째 migration `1794480000000-allow-loop-step-results.cjs`는 result-kind CHECK만 확장합니다. 기존 Run/Step, PK·FK·시각·순번은 보존합니다. down은 단일 트랜잭션에서 `ACCESS EXCLUSIVE` 잠금을 먼저 얻고 신규 두 kind가 없는 경우에만 이전 다섯 종류 CHECK를 복원합니다. 신규 kind 행이 하나라도 있으면 데이터·제약·migration 이력을 유지하며 거부합니다. 기존 임시 테스트 schema 전용 rollback 보호도 유지합니다.

### Migrations & Test Isolation

`db/migrations/1793883600000-create-runs.cjs`는 timestamp-prefix 이름의 첫 migration입니다. `node-pg-migrate`가 `pgmigrations`에 이력을 기록하며, 재실행 시 이미 적용한 migration을 건너뜁니다. 실행기는 advisory lock과 단일 transaction을 사용합니다.

기존 migration은 보존하고 `1793962800000-allow-running-runs.cjs`를 추가했습니다. 새 migration은 상태 CHECK만 확장하며 기존 행과 `queued` 기본값을 유지합니다. 기존 DB에서는 `npm run db:migrate`로 새 migration을 적용한 뒤 내부 시작 연산을 사용하세요. 이 migration의 down은 `running` 행이 하나라도 있으면 제약 검증에서 안전하게 실패하고 행·기존 제약·migration 이력을 유지합니다. 행을 `queued`로 되돌리거나 삭제하지 않습니다.

새 `1793966400000-allow-finished-runs.cjs`는 네 상태를 허용하며 기존 queued/running 행을 보존합니다. 이 migration의 down은 종료 행이 없을 때 queued/running 제약으로 돌아갑니다. completed 또는 failed 행이 있으면 데이터·현재 제약·migration 이력을 바꾸지 않고 실패합니다. 개발 DB에 자동 적용하지 않습니다.

`npm run test:db`는 여섯 DB 테스트 파일을 순차 실행합니다(migration 전역 잠금의 경합 방지). DB 이름이 정확히 `axiom_test`인지 확인한 뒤 실행별 임시 스키마를 만듭니다. migration up → 재실행 → down → up, repository 저장·조회, 별도 Node 프로세스 간 영속성, API 프로세스 재시작 전후 실제 HTTP 응답 일치, 독립 연결의 동시 시작·동시 종료·최종 상태 GET·rollback 성공 및 거부, DB 제약을 검증하고 자신의 스키마만 삭제합니다. 테스트용 URL에 개발 DB를 지정하면 schema 생성 전에 실패합니다. 테스트 실패 시 DB 테스트를 자동 skip하지 않습니다.

첫 migration의 rollback은 테이블 데이터를 삭제하므로 제공된 실행기에서는 임시 테스트 스키마에만 허용합니다. 개발 DB 초기화나 자동 rollback 명령은 제공하지 않습니다. 첫 SQL migration 자체의 `down`은 파괴적이므로 별도 도구로 직접 실행할 때 주의해야 합니다.

DB 저장·조회는 durable execution이나 crash recovery를 의미하지 않습니다. 해당 실행 의미와 검증은 P3 범위입니다.

## Tool Registry & Input Snapshot · 실행 없는 검증 (P2-A 완료)

`apps/api/src/tools/`의 P2-A 모듈은 명시적으로 호출하는 내부 검증 계층입니다. `createToolRegistry(definitions)`는 신뢰된 애플리케이션 코드가 제공한 `{ name, inputSchema }` 목록만 사용합니다. 실제 도구 정의나 handler는 기본 등록하지 않습니다. 이름은 기존 Model Decision의 1~64자 규칙을 재사용하고 중복·잘못된 이름은 고정된 설정 오류로 거부합니다. 비공개 Map을 사용하므로 prototype chain을 조회하지 않으며 빈 Registry에는 기본 허용 도구가 없습니다. `constructor` 같은 유효한 이름도 명시적으로 등록해야 조회됩니다.

`lookup(name)`은 동결된 canonical name 정보만 반환합니다. 원래 정의 배열·객체 및 schema shape 교체는 등록 내용에 영향을 주지 않습니다. schema는 외부에 노출하지 않고 `accepts(name, snapshot)`으로 동기 검증합니다. 이 API도 전달된 인자를 다시 snapshot으로 만들어 검증합니다.

```ts
// 신뢰된 애플리케이션 코드의 검증용 예시. 실제 검색·네트워크 요청은 없습니다.
const registry = createToolRegistry([
  { name: 'search_documents', inputSchema: z.strictObject({ query: z.string().min(1).max(200) }) },
]);
const result = resolveToolRequest(registry, {
  kind: 'tool_request', toolName: 'search_documents', arguments: { query: 'PostgreSQL' },
});
// { kind: 'validated_tool_request', toolName: 'search_documents', arguments: frozenSnapshot }
```

Resolver 순서는 **Model Decision 재검증 → tool_request 구분 → Registry 조회 → 인자 재검증·독립 snapshot → 도구별 strict schema → snapshot 반환**입니다. 성공 결과는 `validated_tool_request`, 실패·비대상 결과는 `not_tool_request`, `unknown_tool`, `invalid_tool_arguments`, `invalid_model_decision`입니다. JSON 계약 자체가 깨졌으면 `invalid_model_decision`, 유효한 JSON이 도구별 스키마에 맞지 않으면 `invalid_tool_arguments`입니다. 실패 결과는 kind만 포함하고 Zod issues·원본 인자·모델 원문·자격증명·예외 원인을 반환하거나 로그에 남기지 않습니다.

Snapshot은 기존 `parseModelDecision()`의 descriptor 기반 JSON 검증을 재사용합니다. 같은 동기 호출 안에서 await·외부 callback 없이 다시 descriptor를 읽어 복사하고 각 중첩 객체·배열까지 freeze합니다. JSON 객체는 null prototype으로 생성하고 키는 `defineProperty`로 기록하므로 `__proto__`도 setter로 실행되지 않습니다. 원본과 중첩 참조를 공유하지 않으며 shared reference는 위치별로 복사합니다. TypeScript도 재귀 readonly 타입을 제공합니다. 원본에 `JSON.stringify`나 `structuredClone`을 적용하지 않습니다.

기존 8192 UTF-8 bytes·container depth 8, Proxy·accessor·symbol·hidden property·순환·sparse array·비 JSON 객체 거부 조건을 유지합니다. parse 이후 원본을 바꾼 경우 최신 값을 재검증하며, snapshot 이후 원본 변경이나 snapshot 수정 시도는 검증 결과를 바꾸지 못합니다. Zod 출력은 다시 JSON 검증해 snapshot과 값이 같은지 확인하지만 **최종 반환에는 사용하지 않습니다**. 이로써 스키마가 별도로 보관한 출력 객체와도 참조가 분리됩니다.

도구 스키마는 루트 및 모든 중첩 객체에 `z.strictObject`를 사용해야 합니다. 지원 범위는 object, array, string, number, boolean, null, literal, enum, optional, nullable, union과 동기 검증 check입니다. coercion·default·prefault·catch·transform·overwrite, permissive object, any/unknown, lazy 등은 등록 단계에서 거부합니다. 스키마 컨테이너는 복사하지만 refinement/check 함수와 Zod 정의 자체는 신뢰된 코드 영역입니다. 이들은 순수하고 동기적으로 작성해야 하며, 임의의 애플리케이션 코드나 스키마 내부 구현 변조를 격리하는 sandbox는 아닙니다. 입력 전체 키 목록 생성 비용 및 입력 생성·전송 크기는 호출 경계에서도 제한해야 합니다.

**A model request is not execution authorization.** 조회·검증 성공은 실행 승인·사용자 동의가 아닙니다. P2-A 검증 계층 자체는 Handler/Executor, 외부 모델 API, 실제 Tool·network·filesystem·shell을 호출하지 않습니다. 기존 one-shot/bounded Runtime은 계속 tool_request를 `failed + unsupported_tool_request`로 종료합니다. HTTP endpoint와 Run 상태는 그대로이며 기존 migration 1~5를 보존합니다. P2-D는 아래의 migration #6만 추가하며 Tool arguments를 DB에 저장하지 않습니다.

후속 P2 단계에서 실행·Runtime 통합·결과 처리 책임을 별도 설계하고 승인받습니다. 사용자 승인, 권한 및 정책 집행은 P4 Safety & Governance의 별도 책임입니다. P2-A는 병합과 main 회귀 검증을 완료했습니다.

## Tool Dispatch & Outcome · 실행 전 계약 (P2-B 완료)

`prepareToolDispatch(registry, runId, rawDecision)`는 기존 `runIdSchema`로 UUID를 먼저 검증한 뒤 **실제 `resolveToolRequest()`를 호출**합니다. Raw Decision과 도구별 입력을 재검증하며, 위조한 `validated_tool_request`나 `approved`·`authorized`·`allow`·`permission` 추가 필드는 거부합니다. 이미 파싱한 Decision도 최신 상태로 다시 검사합니다.

```ts
// 검증된 UUID, Registry의 canonical name, P2-A의 독립적인 deep-frozen arguments
{ kind: 'pending_authorization', runId, toolName, arguments }
```

Plan 최상위도 동결하며 원본 변경은 중첩 snapshot에 영향을 주지 않습니다. 실패는 `invalid_run_id`, `not_tool_request`, `unknown_tool`, `invalid_tool_arguments`, `invalid_model_decision` 중 하나의 **kind만** 반환합니다. 원본 입력·Zod issues·예외 원인은 반환하거나 기록하지 않습니다.

`pending_authorization`은 아직 실행 승인을 받지 않은 데이터입니다. UUID 검증은 DB의 Run 존재·running 상태·사용자 승인·실행 권한·lease를 확인하지 않습니다. Plan은 위조 불가능한 capability나 authorization token이 아닙니다.

`parseToolExecutionOutcome(raw: unknown): ToolExecutionOutcome`은 아래 두 형태만 허용하는 strict union입니다. Envelope의 Proxy·prototype·own property descriptor를 먼저 검사하므로 비신뢰 getter나 Proxy trap으로 속성을 읽지 않습니다.

```ts
{ kind: 'tool_succeeded', output: { message: 'synthetic example' } }
{ kind: 'tool_failed', code: 'handler_error' }
```

실패 code allowlist는 `handler_error`, `invalid_tool_output`, `execution_unavailable`입니다. 추가 필드, 임의 message·cause·stack, 성공 output과 실패 code의 혼합을 거부합니다. 잘못된 입력은 원본 데이터나 cause 없이 고정된 `InvalidToolExecutionOutcomeError('Invalid tool execution outcome')`로 거부합니다.

성공 output은 `snapshotToolArguments()`를 재사용해 JSON Object Root로 검증·복사·deep freeze합니다. **Output 자체 기준 UTF-8 8192 bytes, container depth 8**을 유지하고 envelope도 동결합니다. null-prototype·안전한 특수 키는 보존하며 Proxy·accessor·비 JSON 값·숨겨진 속성·symbol·sparse array·순환 참조는 거부합니다. `toJSON`을 실행하지 않고 원본 참조를 반환하지 않습니다.

Outcome은 합성 테스트 데이터도 파싱할 수 있는 데이터 계약이며 실제 도구 실행 사실이나 정책 승인을 증명하지 않습니다. 모델의 성공 주장만으로 실행 완료를 인정하지 않습니다. **P2-B 계약 자체는 Handler를 호출하지 않으며 실제 외부 호출, Runtime 자동 연동, DB 저장·migration 및 HTTP 추가도 없습니다.** 기존 Runtime은 계속 `tool_request`를 `failed + unsupported_tool_request`로 종료합니다.

P2-B는 병합과 main 회귀 검증을 완료했습니다. 아래 P2-C는 이 계약을 재사용하는 내부 실행 경계입니다. P2-A처럼 신뢰된 스키마 refinement/check는 순수한 동기 코드라는 전제가 있으며 임의의 애플리케이션 코드 부작용을 격리하지 않습니다.

## In-Memory Tool Executor · 신뢰된 순수 Handler 실행 (P2-C 완료)

`createInMemoryToolExecutor({ registry, handlers, permitExecution? })`는 동결된 내부 API `execute(runId, rawDecision): Promise<InMemoryToolExecutionResult>`를 제공합니다. 매 요청마다 **P2-B Preflight 재검증 → Trusted Host Gate → 등록된 Handler 조회 → 한 번 호출 → P2-B Outcome 검증** 순서를 따릅니다. 공개 API는 기존 Plan을 실행 명령으로 받지 않습니다.

Handler는 신뢰된 호스트가 생성 시 전달하는 `{ name, handle }` 목록입니다. Registry에 등록된 유효 이름과 함수만 허용하며 중복·잘못된 구성은 고정 오류로 거부합니다. 비공개 Map에 이름과 함수 참조를 복사하므로 원래 배열·정의 객체·options를 나중에 바꿔도 실행 대상이나 Gate가 교체되지 않습니다. 기본 Handler나 실제 외부 도구를 자동 등록하지 않습니다.

**Default Deny:** Gate가 없으면 `tool_failed + execution_unavailable`입니다. 생성 시 설치한 동기 `permitExecution(plan)`을 매번 다시 호출해 정확히 boolean `true`인 경우만 실행합니다. `false`·비Boolean·Promise·thenable·throw는 거부하며 Handler 호출은 0회입니다. 잘못 반환한 native Promise의 rejection도 관찰해 처리합니다. Gate에는 raw decision이 아닌 불변 Plan만 전달합니다. Gate는 사용자 인증·동의나 P4 정책 엔진을 대신하지 않습니다.

```ts
// 테스트용 순수 인메모리 예시. 앱이나 HTTP에 자동 등록하지 않습니다.
const registry = createToolRegistry([
  { name: 'echo', inputSchema: z.strictObject({ message: z.string().min(1) }) },
]);
const executor = createInMemoryToolExecutor({
  registry,
  handlers: [{ name: 'echo', handle: args => ({ message: args.message }) }],
  permitExecution: plan => plan.toolName === 'echo',
});
const outcome = await executor.execute('12345678-1234-4234-8234-123456789abc', {
  kind: 'tool_request', toolName: 'echo', arguments: { message: 'hello' },
});
// { kind: 'tool_succeeded', output: { message: 'hello' } } — 독립 deep-frozen snapshot
```

허용된 단일 호출은 Handler를 정확히 한 번 invoke하고 P2-A의 불변 arguments snapshot만 전달합니다. 동기 JSON object 또는 native Promise의 결과를 처리합니다. 일반 객체를 무조건 `await`하지 않으므로 악성 `then` getter나 thenable 함수를 실행하지 않습니다. custom thenable은 지원하지 않으며, native Promise를 사용하는 호스트 코드와 Promise constructor/species·런타임 내장 함수의 무결성은 신뢰 전제입니다. Handler가 Promise를 생성하는 과정에서 수행하는 코드도 격리하지 않습니다.

| 상황 | 결과 |
| --- | --- |
| Preflight 실패 | 기존 다섯 실패 kind 그대로; Gate·Handler 호출 없음 |
| Gate 누락·거부·오류 또는 Handler 없음 | `tool_failed + execution_unavailable` |
| Handler throw / Promise reject | `tool_failed + handler_error` |
| 잘못된 JSON output | `tool_failed + invalid_tool_output` |
| 안전한 JSON object output | `tool_succeeded + output` |

성공 출력은 기존 `parseToolExecutionOutcome()`으로 복사·동결하며 UTF-8 8192 bytes·깊이 8, Proxy·accessor·순환·sparse array·비 JSON 값 거부를 유지합니다. 실패 결과에는 raw error·message·cause·stack·원본 인자·credential을 넣지 않으며 자동 로깅·저장도 하지 않습니다. 자동 재시도는 없고, 서로 다른 execute 호출은 각각 실행하므로 중복 방지·Exactly-Once를 보장하지 않습니다.

**A model request is not execution authorization.** `pending_authorization`은 실행 허가증이 아니고 Outcome 객체도 실행 사실의 위조 불가능한 증명이 아닙니다. 신뢰된 순수 테스트 Handler만 등록한다는 계약이며 임의 함수·closure·refinement의 부작용을 막는 sandbox가 아닙니다. 실제 Run 존재·running 상태·lease·사용자 권한을 확인하지 않습니다. 무한 실행 Handler 중지, timeout·cancellation·retry·durable execution도 지원하지 않습니다.

P2-C Executor 자체는 HTTP·기존 One-Shot/Bounded Runtime·DB·worker·Model Provider와 자동 연결되지 않습니다. 기존 Runtime은 계속 Tool Request를 `failed + unsupported_tool_request`로 종료합니다. 프로덕션 파일·네트워크·DB·shell·Browser·Plugin 도구, 결과 persistence 및 새 HTTP/migration은 없습니다. P2-C는 병합과 main 검증을 완료했습니다. 아래 P2-D는 선택적인 내부 실행 통합이며 실제 사용자 인증·승인·정책은 P4 범위입니다.

## Run-Aware Tool Loop · 선택적 내부 실행 (P2-D 완료)

`runBoundedToolDecisions(runId, dependencies, { maxDecisions, maxToolExecutions })`는 별도 내부 API입니다. 기존 `runOneDecision()`과 `runBoundedDecisions()`는 여전히 Tool Request를 `failed + unsupported_tool_request`로 종료합니다. 새 Runtime도 HTTP·worker에서 자동 호출하지 않으며 실제 모델이나 외부 도구는 연결하지 않습니다.

- `maxDecisions`: 필수 정수 1~5. `maxToolExecutions`: 필수 정수 0 또는 1이며 기본 허용은 없습니다. 잘못된 예산·ID·의존성은 claim 전에 거부합니다.
- 기존 `tryStartRun()`으로 `queued → running`을 원자적으로 선점한 실행 주체만 진행합니다. 다른 호출은 `not_started`로 끝나며 결정·Gate·Handler를 호출하지 않습니다.
- 매 결정 전 running을 재조회합니다. Tool Request에서는 **후속 결정 슬롯 → 남은 Tool 시도 예산 → running 재조회 → 실제 P2-C execute** 순서로 확인합니다. 두 예산이 동시에 부족하면 `decision_limit_exceeded`를 우선합니다. 슬롯은 남았지만 Tool 예산이 없으면 `tool_execution_limit_exceeded`입니다.
- P2-C의 Default Deny·Preflight 재검증·Trusted Host Gate를 유지합니다. Gate의 정확한 `true`만 허용하며 순수 인메모리 Handler는 한 Run에서 최대 1회 시도합니다. 자동 재시도는 없습니다.
- 결정 context는 동결된 `{ kind: 'none' }` 또는 `{ kind: 'tool_result', outcome }`입니다. Outcome은 P2-B parser로 다시 검증·독립 복사·deep freeze하며 **Tool Step COMMIT 후 바로 다음 결정에 한 번만** 전달하고 이후 `none`으로 돌아갑니다. 원본 arguments/output을 전달하거나 DB에 저장하지 않습니다.
- Tool 성공은 Run 완료가 아닙니다. Step만 기록하고 계속 running이며, 최종 `final`을 받은 경우에만 기존 Atomic Finalizer로 completed와 종료 Step을 함께 확정합니다.

| 상황 | Step / 결과 |
| --- | --- |
| Tool 성공 | `tool_succeeded` Step COMMIT → 다음 결정 |
| Gate 거부·Handler throw/reject·invalid output | `tool_failed`, 고정 code만 반환 |
| Unknown Tool·invalid arguments 등 Preflight 거부 | `tool_request_rejected` |
| Tool 시도 예산 소진 | `tool_execution_limit_exceeded` |
| 마지막 결정 슬롯에서 Tool 요청 | `decision_limit_exceeded`, Handler 0회 |
| 외부 종료를 관찰하거나 저장 조건 충돌 | `finalize_conflict`, 후속 실행 중단 |

`createRunToolStepRecorder(db).appendToolSucceededStepIfRunning(runId)`는 기존 부모 Run의 `FOR UPDATE` 잠금을 먼저 잡고 running을 확인한 뒤 다음 Step 번호를 계산합니다. 기존 Continue Recorder·Atomic Finalizer와 같은 부모 잠금 순서를 사용하며 COMMIT이 확인돼야 성공을 반환합니다. Handler 실행 중에는 DB 트랜잭션이나 row lock을 유지하지 않습니다. 실패 종료 세 종류는 기존 Atomic Finalizer의 허용 목록에만 추가해 Run failed와 Terminal Step을 한 트랜잭션에 기록합니다.

**Migration #6**은 `run_steps.result_kind` CHECK에 `tool_succeeded`, `tool_failed`, `tool_request_rejected`, `tool_execution_limit_exceeded`만 추가합니다. 기존 migration 1~5 및 Run 상태·HTTP 네 필드는 보존합니다. Down은 테이블 잠금 후 신규 kind 존재를 검사하고, 존재하면 데이터·제약·migration 이력을 보존하며 실패합니다. 새 migration 검증은 격리 테스트 스키마에서 수행합니다.

Step은 계속 `run_id`, `step_no`, `result_kind`, `created_at` **metadata만** 저장합니다. 모델 원문·final content·Tool arguments/output·task 복사본·handler error는 기록하지 않습니다. DB 오류는 source 오류로 바꾸지 않고 전파하며 연결을 정리합니다. COMMIT 응답 실패는 실제 반영 여부가 불확실할 수 있어 연결을 discard하고 후속 결정·자동 retry를 막습니다. 기록이 이미 반영됐을 가능성을 성공으로 단정하거나 되돌리지 않습니다.

**외부 종료 경합의 한계:** running 조회와 Handler 호출 사이에는 race window가 남습니다. Handler 시작 전에 종료를 관찰하면 호출 0회입니다. 실행 중 종료되면 이미 시작한 Handler는 취소할 수 없지만, guarded recorder/finalizer가 terminal 상태를 보존하고 허위 Tool Step·다음 결정을 차단합니다. 완료된 외부 Step을 덮어쓰지 않습니다. 순수 Handler만 사용하며 실제 side effect를 원자적으로 제어한다고 주장하지 않습니다.

**A model request is not execution authorization.** 내부 Executor와 Decision Source는 신뢰된 호스트 의존성입니다. 정상 native Promise 및 런타임 내장 함수의 무결성을 전제로 하며, parser 성공은 실행 출처의 증명이 아닙니다. 사용자 인증·승인·Lease·임의 Handler Sandbox는 없고 Timeout·Cancellation·Recovery·Exactly-Once를 제공하지 않습니다. P2-D는 병합과 main 검증을 완료했습니다. 아래 P2-E는 별도 내부 저장 API이며 이 Runtime에 자동 연결하지 않습니다. Durable/crash recovery는 **P3**, 사용자 승인·권한 정책은 **P4** 범위입니다.

## Privacy-Gated Tool Results · 제한된 내부 저장 (P2-E 완료)

**Validation is not permission to persist.** 기본은 **Default No-Store**입니다. 기존 `runBoundedToolDecisions()`와 `appendToolSucceededStepIfRunning()`은 계속 Step metadata만 기록하며 Tool Output을 저장하지 않습니다. 새 저장소는 신뢰된 호스트 코드가 별도로 호출해야 합니다. 모델의 `approved`, `persist`, `save`, Handler 성공 및 Outcome 파싱 성공은 저장 권한이 아닙니다.

`createToolResultPolicy()`의 기본 허용 목록은 비어 있습니다. 호스트가 Tool 이름, 순수·동기 `project(outcome)` 함수, 정수 `retentionSeconds`(1~86,400)를 명시적으로 등록합니다. 정책은 생성 시 복사·캡처하고 비공개 WeakMap의 객체 identity로 확인합니다. 구조가 같은 가짜 정책이나 정의 배열 변경으로 우회할 수 없습니다. 입력 Outcome은 기존 parser로 독립 복사·deep freeze한 뒤 Projector에 전달하고, Projector 결과도 재검증합니다. Promise/thenable·비정상 Projection은 저장하지 않습니다.

저장 계약은 오직 다음 세 필드입니다. Coercion·default·transform·추가 필드·자유 문자열·임의 JSON을 허용하지 않습니다.

| 필드 | 허용값 |
| --- | --- |
| `schemaVersion` | 정확히 `1` |
| `status` | `ok` 또는 `empty` |
| `itemCount` | 정수 0~1000 |

Payload 상한은 UTF-8 **1,024 bytes**입니다. 이 고정 계약의 정상 값은 훨씬 작으며 경계값을 채우려고 padding을 허용하지 않습니다. Proxy·getter/setter·`toJSON`·순환·숨겨진 필드·Symbol·비JSON 값은 실행 없이 거부하고 독립 동결 snapshot을 반환합니다. 임의 문자열, 사용자 Task, Tool arguments/raw output, Model/Final Content, Error/Cause/Stack, URL, Credential, Query Hash를 보존하지 않습니다. 민감정보 자동 탐지·Redaction 기능은 없으며 synthetic summary의 의미 검토는 신뢰된 호스트의 책임입니다.

```ts
const policy = createToolResultPolicy([{
  name: 'synthetic_summary',
  retentionSeconds: 3600,
  project: () => ({ schemaVersion: 1, status: 'ok', itemCount: 3 }),
}]);
const results = createRunToolResultRepository(pool, policy);
// Trusted internal host call; no Handler runs inside this transaction.
await results.appendToolSucceededStepWithSafeResultIfRunning(runId, 'synthetic_summary', outcome);
await results.getSavedToolResult(runId, stepNo);
await results.deleteExpiredToolResults(); // Explicit maintenance; no background worker.
```

정책 미설정·미등록 Tool·유효하지 않은 Outcome/Projection은 고정 `{ kind: 'no_store' }`를 반환하며 연결·Step·Result를 만들지 않습니다. 잘못된 UUID/Step 번호는 연결 전에 거부합니다. 저장 가능한 입력이어도 Run이 없거나 queued/terminal이면 `null`이고 두 행 모두 추가하지 않습니다.

새 Recorder는 전용 연결에서 `BEGIN READ COMMITTED → runs FOR UPDATE → running 확인 → 다음 번호의 tool_succeeded Step INSERT → Safe Result INSERT → COMMIT` 순서로 실행하고, 확인된 COMMIT 뒤에만 `{ step, result }`를 반환합니다. 기존 Recorder·Finalizer와 같은 부모 잠금 순서입니다. Handler를 호출하거나 실행 중 DB 잠금을 유지하지 않습니다. INSERT·제약 실패는 두 행 모두 rollback하며 COMMIT/rollback 오류 연결은 discard합니다. COMMIT 응답 유실 시 두 행이 이미 반영됐을 수 있어 자동 재시도·성공 추정·Handler 재호출을 하지 않습니다. DB 오류는 신뢰된 호출자에게 전파하며 자동 로깅하거나 모델 오류로 바꾸지 않습니다.

**Migration #7:** `1794529800000-create-run-tool-results.cjs`는 기존 migration 1~6을 보존합니다. `run_tool_results`는 `run_id`, `step_no`, 고정 `result_kind`, `schema_version`, `status`, `item_count`, `created_at`, `expires_at`만 저장합니다. JSONB 대신 전용 typed columns를 사용하므로 자유 JSON을 담을 컬럼 자체가 없습니다. 확장은 새 migration·계약 리뷰가 필요합니다.

- `(run_id, step_no)` PK로 Step당 결과 최대 1개입니다.
- 기존 Step에 additive UNIQUE `(run_id, step_no, result_kind)`를 만들고 복합 FK와 고정 `tool_succeeded` CHECK로 정확한 Run/Step/종류 연결을 보장합니다. 기존 행을 재작성하거나 삭제하지 않습니다.
- DB CHECK가 버전·enum·개수·직렬화 크기·유한 timestamp·양수/최대 24시간 만료 범위를 제한합니다. `created_at`과 TTL 기반 `expires_at`은 INSERT의 DB 시계를 사용합니다.
- Down은 Step→Result 테이블 순서로 잠근 뒤 결과가 한 건이라도 있으면 거부합니다. 데이터·제약·migration 이력을 보존하며 빈 경우에만 새 테이블과 additive UNIQUE를 제거합니다.

내부 조회는 정확한 키와 `expires_at > statement_timestamp()`만 읽고, DB 행의 버전·구조를 다시 검증해 독립 동결 snapshot을 반환합니다. 날짜는 변경 불가능한 ISO 문자열입니다. 만료·미존재·다른 Run/Step은 `null`, 이상한 행은 원문 없는 고정 오류입니다. `deleteExpiredToolResults()`는 DB 시각 기준 만료된 결과만 삭제하며 Run/Step·비만료 결과를 보존합니다. 자동 정리 worker가 없으므로 정확한 만료 순간의 물리 삭제, backup·복제본 삭제 또는 production retention compliance를 보장하지 않습니다.

**A model request is not execution authorization.** 정책 객체와 Projector는 신뢰된 호스트 영역이며 임의 코드 부작용을 막는 sandbox가 아닙니다. 정상 native Promise 및 런타임 내장 함수의 무결성을 전제합니다. 키를 아는 것은 조회 권한이 아니며 사용자·테넌트 인증, 새 HTTP API, 실제 외부 Tool, 모델 연결은 없습니다. 여러 명시적 저장 호출이 여러 Step을 만들 수 있으며 Exactly-Once Tool Execution을 의미하지 않습니다. 기존 read→Handler race와 Lease·Timeout·Cancellation 부재는 그대로입니다. **P3**의 durable/recovery, **P4**의 사용자 승인·정책, **P6**의 production security·retention governance는 후속 범위입니다.

## Bounded Public Read · 고정 공개 저장소 조회 (P2-F 완료)

`createPublicRepositoryReadExecutor({ permitExecution? })`는 기존 순수 `createInMemoryToolExecutor()`와 별개인 내부 API입니다. 기존 P2-D 기본 구성과 Runtime 본체는 보존하며, 새 Executor를 `runBoundedToolDecisions()`의 dependency로 명시적으로 주입할 때만 사용합니다. 기본 HTTP routes·서버·worker에서 자동 등록하거나 실행하지 않습니다.

- Tool은 `github_public_repo_stats` 하나, 모델 arguments는 strict `{}`만 허용합니다. URL·headers·token·timeout·승인·저장 플래그는 입력할 수 없습니다.
- 기존 Preflight → 생성 시 캡처한 동기 Host Gate → HTTP 순서입니다. Gate가 없거나 정확한 원시 `true`가 아니면 **Default Deny**입니다. 입력 실패 → Gate 거부 → pre-aborted host signal 순으로 판정하고, 허용되지 않은 호출은 요청 0회입니다. Gate에는 동결된 검증 Plan만 전달합니다.
- 대상은 **GET `https://api.github.com/repos/nodejs/node`** 하나입니다. 명시적 헤더는 `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10`, `User-Agent: Axiom-Public-Read-Tool`입니다. 정상 TLS 검증을 유지하며 인증·Cookie·body·query, Run ID·task·모델 원문·환경 변수·로컬 경로를 전송하지 않습니다. GitHub CLI 인증이나 token을 읽지 않습니다. [GitHub API 버전 문서](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- `redirect: 'error'`, retry·pagination·fallback·사전 HEAD 없음. execute당 애플리케이션 HTTP 시도는 최대 1회입니다. 프로덕션 Factory에 URL·transport·proxy·deadline 변경 옵션은 없습니다. 내부 테스트 seam은 transport를 반드시 주입해야 하며 누락 시 native fetch로 fallback하지 않습니다.
- 요청 시작부터 body 소비 완료까지 **단일 5,000ms deadline**입니다. optional third argument `{ signal }`은 신뢰된 호스트의 per-call 신호이며 모델 입력과 분리합니다. 실제 fetch에 AbortSignal을 연결하고 timeout/host abort 시 미완료 body를 취소합니다. 소유 reader의 cancel·lock 해제, timer·listener 정리 및 cleanup rejection 관찰을 수행합니다. 정리를 무기한 기다리지 않습니다.
- 실제 소비하는 body(압축된 경우 **압축 해제 후**)는 최대 **65,536 bytes**입니다. Content-Length를 신뢰하지 않고 chunk를 저장하기 전에 누적 크기를 확인합니다. 65,536 허용, 65,537 거부이며 Node/TLS 내부 버퍼를 포함한 전체 메모리 상한이라는 뜻은 아닙니다.
- `application/json` 또는 유효한 `application/*+json`만 허용하며 parameter는 선택적인 `charset=utf-8`만 허용합니다. UTF-8을 엄격히 decode하고 JSON object를 한 번 파싱합니다. `full_name === 'nodejs/node'`, `private === false`, 비음수 safe integer 통계와 boolean `archived`를 확인합니다. 다른 필드는 무시하고 자유 텍스트·URL·명령을 실행하거나 전달하지 않습니다.

성공 결과는 기존 Outcome parser를 거쳐 독립 복사·deep freeze한 아래 최소 Projection입니다. 기존 8,192-byte/depth-8 제한은 이 Projection에 적용합니다.

```ts
{ kind: 'tool_succeeded', output: {
  schemaVersion: 1, repository: 'nodejs/node', stars: 123, forks: 45, archived: false,
} }
```

Preflight 실패는 기존 kind를 유지합니다. Gate 거부는 `execution_unavailable`, 네트워크·TLS·비200·전송 오류·timeout·host abort는 `handler_error`, HTTP 200의 type·크기·UTF-8·JSON·필드 오류는 `invalid_tool_output`입니다. 모두 `tool_failed`의 기존 고정 code만 반환하며 원문 오류·body·headers·stack·cause·abort reason을 자동 로그하거나 반환하지 않습니다.

**No-Store:** body와 최소 결과 모두 P2-E 저장 정책에 등록하지 않습니다. Runtime은 Tool 성공 Step COMMIT을 확인한 뒤 다음 결정에 outcome을 한 번 전달하고, synthetic final에서 Run과 종료 Step을 원자적으로 확정합니다. DB에는 기존 metadata만 남으며 `run_tool_results`는 0행입니다. 외부 데이터를 다음 모델 입력에 사용하는 미래 구성에서도 데이터는 지시문이 아닙니다.

HTTP 중 DB transaction·부모 row lock은 유지하지 않습니다. HTTP 전에 terminal 상태를 관찰하면 요청 0회, 진행 중 외부 종료되면 기존 terminal 상태·Step을 보존하고 추가 Tool Step·다음 결정을 차단합니다. **DB 종료가 HTTP를 자동 취소하지는 않습니다.** 이미 시작한 요청은 deadline 안에서 끝날 수 있으며 read→call race와 이 Runtime의 lease 보호 부재는 남아 있습니다. 불확실 COMMIT/DB 오류 이후 HTTP 자동 재시도는 없습니다.

### Offline validation / Opt-in live smoke

`npm test` 및 `npm run test:db -- --reporter=verbose`의 새 테스트는 mock 또는 자체 loopback만 사용합니다. loopback adapter는 먼저 정확한 production URL·GET·옵션을 확인한 뒤 자신의 로컬 서버로 전송합니다. native fetch의 redirect 거부, 압축·크기 경계, 단일 deadline, 실제 연결 종료와 격리 DB의 claim 경쟁·COMMIT 순서·외부 종료·실패·No-Store를 검증합니다. 기존 7개 migration과 P2-E TTL 회귀는 그대로 실행합니다.

아래 명령은 **공개 인터넷 GET을 실제 1회 시도**하므로 승인된 경우에만 별도로 실행합니다. 일반 테스트·build·import·서버 시작에서 실행되지 않습니다. `.env`를 로드하지 않으며 DB·LLM·자격증명 조회·파일 업로드를 하지 않습니다. 플래그 누락/추가 인자는 요청 0회로 거부합니다.

```sh
npm run build
npm run smoke:public-repo -- --allow-public-network
```

Smoke의 임시 UUID는 로컬 연결용이며 실제 Run 상태나 사용자 인증의 증거가 아닙니다. 출력에는 고정 대상·KST 시각·Node 버전·시도 수·고정 실패 또는 최소 성공 결과만 포함합니다. 검증 보고에는 별도로 기준 HEAD와 미커밋 소스 SHA-256 지문을 함께 기록해야 합니다. **실제 live 결과: 2026-11-13 20:15:01 KST, Node v22.21.0에서 고정 GET 1회 PASS.** 검증된 Projection은 `{ schemaVersion: 1, repository: 'nodejs/node', stars: 123689, forks: 38061, archived: false }`입니다. 당시 기준 HEAD는 `f065815ff348a8239915dae7951e13e8d981e7fe`이며, 실행 보고에 미커밋 변경 파일 9개의 SHA-256을 함께 남겼습니다. 이 문서의 결과 기록만 smoke 후 갱신했고 구현·테스트·실행 설정은 동일합니다. 실패해도 자동 재실행하거나 다른 대상·인증으로 우회하지 않습니다.

읽기 요청도 원격 서버에 IP·고정 헤더·시각과 사용량을 남길 수 있고 DB rollback으로 되돌릴 수 없습니다. 정상 Node 이벤트 루프·OS/DNS/TLS·신뢰된 host/transport를 전제합니다. 5초는 I/O deadline이며 임의 동기 무한루프를 선점하는 hard real-time 보장은 아닙니다. 사용자 auth·Runtime lease 보호·전역 cancellation·durable/recovery·Exactly-Once·범용 SSRF sandbox·egress 방화벽을 제공하지 않습니다.

## Execution Lease Foundation · 실행 소유권 메타데이터 (P3-A 완료)

P2-A~F는 병합·main 검증을 완료했습니다. P3-A는 PR #32로 병합됐으며 main 전체 검증을 완료했습니다. `apps/api/src/persistence/run-execution-lease-repository.ts`의 `createRunExecutionLeaseRepository(db)`는 전용 client를 제공하는 신뢰된 DB 의존성을 받습니다. HTTP나 기존 Runtime에 자동 연결하지 않습니다.

| 내부 API | 계약 |
| --- | --- |
| `tryClaimRunLease(runId, { ownerId, leaseSeconds })` | queued이며 Lease가 없는 Run만 running으로 바꾸고 최초 Lease를 같은 트랜잭션에서 생성. 성공은 LeaseHandle, 조건 불충족은 null. |
| `tryRenewRunLease(runId, { ownerId, leaseToken })` | running·동일 Owner/Token·미만료 조건을 만족할 때만 갱신. 저장된 TTL·Token·Owner·acquiredAt은 보존. |
| `getRunLeaseSnapshot(runId)` | 없으면 null, 있으면 Token 없는 메타데이터와 active / expired / run_not_running 반환. Run 종료 상태가 만료 상태보다 우선. |

Migration #8은 `run_execution_leases`에 run_id PK/FK, owner_id, UNIQUE lease_token, lease_seconds, acquired_at, renewed_at, expires_at만 저장합니다. FK 자동 CASCADE는 없으며 NOT NULL·유한 시각·renewed_at ≥ acquired_at·expires_at = renewed_at + lease_seconds를 강제합니다. 기간은 명시적인 정수 **1~300초**로, P2-E 결과 보존 TTL **1~86,400초**와 별개입니다. #1~7은 변경하지 않습니다. Down은 runs → Lease 테이블 순서로 잠그고, 같은 migration 트랜잭션에서 비어 있는 경우만 DROP합니다. 만료/terminal 행도 하나라도 남으면 데이터·제약·이력을 보존하며 거부합니다.

Claim과 Renewal은 READ COMMITTED 전용 연결에서 **runs → run_execution_leases** 순서로 잠급니다. 두 잠금 statement가 끝난 뒤 후속 SQL의 materialized CTE가 `clock_timestamp()`를 한 번 샘플링합니다. Renewal은 같은 t로 `expires_at > t`와 `renewed_at <= t`를 검사하고 renewed_at=t, expires_at=t+저장된 기간으로 갱신합니다. 만료 등호와 명백한 clock 역행은 거부합니다. 트랜잭션 시작 시각인 `now()`를 사용하지 않고, JS Date로 시각을 SQL에 왕복 전달하지 않습니다. [PostgreSQL 시각 함수](https://www.postgresql.org/docs/16/functions-datetime.html), [잠금 규칙](https://www.postgresql.org/docs/16/explicit-locking.html), [node-postgres 트랜잭션](https://node-postgres.com/features/transactions)

입력은 연결 전에 UUID 문자열·정수 범위·정확한 옵션 키를 검사합니다. UUID 대소문자는 정규화하고 getter/coercion으로 정책을 받지 않습니다. Token은 실제 Claim 경로에서 `crypto.randomUUID()`로 생성합니다. Claim에 Token/now/expiresAt, Renewal에 새 TTL/시각을 전달할 수 없습니다. 반환 객체는 readonly·동결된 독립 객체이며 시각은 PostgreSQL 마이크로초를 보존한 UTC 문자열입니다. Handle의 Token은 신뢰된 내부 갱신용이며 Snapshot SQL·반환·HTTP·자동 로그에는 포함하지 않습니다.

Handle은 **COMMIT 응답 확인 뒤에만** 반환합니다. 조건 불충족(null)과 DB 오류(reject)를 구분하며, 부분 쓰기는 rollback합니다. COMMIT 오류 또는 rollback 실패는 연결을 폐기하고 자동 재시도하지 않습니다. 실제 COMMIT 후 응답 유실이면 Run/Lease 변경이 남았어도 호출자는 성공 Handle을 받지 못할 수 있습니다. Snapshot으로 Token을 복구하거나 자동 재개하지 않습니다. COMMIT/응답 지연 때문에 Handle 수신 시 이미 만료됐을 수 있으며, 반환 이후 일정 시간 실행 권한을 보장하지 않습니다.

**A lease record is not execution authorization, complete fencing, or permission to replay.** Snapshot active는 관찰값으로 사용자 실행 허가나 후속 쓰기의 권한 증명이 아닙니다. UUID Token은 단조 증가 fencing epoch도 아닙니다. P3-B의 지원 Tokenless Writer는 Lease가 있는 Run의 변경을 거부합니다. 유효 credential의 Lease-aware Finalizer로 종료하면 Lease 행은 남고 Snapshot은 run_not_running, Renewal은 null입니다. 직접 SQL·구버전 Writer·외부 서비스에 대한 전체 fencing은 제공하지 않습니다.

**No Reclaim / No Replay / No Automatic Execution:** 만료가 프로세스 사망이나 외부 요청 미발생의 증거는 아닙니다. 재할당·Token 교체·자동 삭제·heartbeat·Worker·모델/Tool 호출·running→queued·retry·recovery를 수행하지 않습니다. Claim으로 running이 된 Run을 기존 Runtime에 넘겨 tryStartRun 검사를 우회하지 않습니다. 기존 P2-E Safe Result와 P2-F No-Store 결과는 자동 복구용 checkpoint가 아닙니다. 지원 API 밖의 fencing·checkpoint·recovery는 후속 설계와 별도 승인이 필요하며, P3 전체 완성이나 Exactly-Once를 의미하지 않습니다.

Unit 테스트는 입력·행 검증·잠금 순서·COMMIT 전 비반환·연결 폐기·Token 비노출을 확인합니다. `test:db`는 실행별 `axiom_test` schema에서 독립 backend Claim/Legacy/종료 경합, 실제 잠금 대기 중 만료, 제약·실패 원자성·down 보호를 검증합니다. 마이크로초 경계는 **실제 repository SQL의 clock_timestamp() 표현식만** 테스트 DB 시계로 치환해 검사하며 production now override는 없습니다. COMMIT 후 응답 유실은 모사이며 실제 네트워크 단절 실험이 아닙니다. P2-F 회귀는 mock·소유 loopback만 사용하고 추가 Live 요청은 없습니다.

## Lease-Aware Persistence · 쓰기 경계 보호 (P3-B 완료)

Issue #33은 PR #34로 병합됐으며 main 전체 검증을 완료했습니다. **Lease existence selects the write protocol. Expiry never falls back to legacy writes.** Lease의 존재 자체가 쓰기 경로를 선택합니다. expired·terminal·방어용 queued+Lease도 Legacy 쓰기를 열지 않습니다.

| 지원 API | Lease 없음 | Lease 있음 |
| --- | --- | --- |
| `tryStartRun` / `tryFinishRun` | 기존 queued/running 조건부 전이 | null |
| `appendRunStep` | 기존 상태별 의미 유지 (running 전용으로 축소하지 않음) | null |
| `tryFinalizeWithStep` | running에서 Run+terminal Step | null |
| `appendContinuedStepIfRunning` / `appendToolSucceededStepIfRunning` | running에서 Step 추가 | null |
| `appendToolSucceededStepWithSafeResultIfRunning` | 기존 정책 통과 후 running에서 Step+Result | 정책 거부는 no_store, 준비 성공 후에는 null |
| `tryFinalizeWithStepWithLease` | null | 유효 credential·running·시간 Guard에서 Run+terminal Step |
| `appendContinuedStepWithLease` / `appendToolSucceededStepWithLease` | null | 같은 Guard에서 Step 추가 |
| `appendToolSucceededStepWithSafeResultWithLease` | 정책 허용 시 null | Trusted Policy AND 같은 Lease Guard에서 Step+Result |

Lease-aware credential은 정확히 `{ ownerId, leaseToken }`인 UUID 문자열이며 대소문자를 정규화합니다. 전체 Handle·Snapshot·now·TTL·skipLease·force·authorized 등은 받지 않습니다. Getter/Setter/Proxy를 실행하지 않으며 첫 await 전에 원시 값을 캡처합니다. 잘못된 credential은 정책 미설정 여부와 무관하게 연결 전 고정 입력 오류입니다. 정상 형식에서 정책 준비가 실패하면 no_store·DB 연결 0회, 정책 준비 성공 후 Lease 조건이 틀리면 null·쓰기 0행입니다.

**A snapshot is not write authorization. A valid lease is not permission to execute or persist arbitrary data.** P2-E의 WeakMap 기반 Trusted Policy, 고정 3필드·1,024-byte 상한·TTL 1~86,400초·PostgreSQL 정밀도의 ttl_valid와 P2-F No-Store를 유지합니다. Projector는 트랜잭션 전에 완료합니다. Token을 반환 Step/Result·로그·HTTP·진단 이력에 추가하지 않습니다.

다중 문장 Legacy Writer는 READ COMMITTED 전용 client에서 부모 Run을 잠근 **뒤 새 statement**로 Lease 존재를 검사합니다. Claim의 COMMIT을 기다렸다면 새 snapshot에서 생긴 Lease를 보고 거부합니다. Finalizer도 Lease 검사 전 Run 상태를 바꾸지 않습니다. query-only `tryStartRun/tryFinishRun`은 Pool·PoolClient 계약을 유지하고 한 UPDATE에 NOT EXISTS를 추가합니다. 이 예외는 Claim이 queued→running과 Lease 생성의 유일한 지원 경로이고, running Run 사후 Lease 부착·Lease 삭제·requeue가 없다는 불변식에 의존합니다. 일반 append나 미래 Reclaim에 일반화하지 않습니다.

새 쓰기는 **runs → Lease** 잠금 statement를 모두 완료한 뒤 **첫 DML의 단일 clock_timestamp()**로 쓰기 진입을 판정합니다. 같은 DB 정밀도에서 running·run/owner/token 일치·expires_at > t·renewed_at <= t 및 유한 시각·기간·시간 관계를 검사합니다. Snapshot/JS Date/트랜잭션 시작 시각을 허가에 사용하지 않습니다. Guard는 Step 순번 집계 바깥의 입력이므로 Guard 0행이 MAX 집계 때문에 INSERT 1행으로 바뀌지 않습니다. 부모 잠금은 순번 계산과 COMMIT까지 유지합니다.

보장은 진입 판정 시각 t의 유효성입니다. **잠금 대기 중 만료는 거부**하지만, 판정 후 지연된 COMMIT은 만료 뒤 확정·반환될 수 있습니다. 자동 갱신이나 retry로 시간을 수리하지 않습니다. Finalizer의 Run+Step, Safe Result의 Step+Result는 각각 원자적이며 COMMIT 확인 후 반환합니다. COMMIT 오류·rollback 실패는 연결 discard, 자동 재호출 없음입니다. 실제 COMMIT 후 응답 유실 검증은 모사이며 실제 네트워크 단절 실험은 아닙니다. 결정적 ±1μs/역행 테스트도 실제 SQL의 시계 표현식만 치환한 fixture로, 실제 clock 장애를 주입한 것은 아닙니다.

보호 범위는 **수정된 지원 Repository API**입니다. raw SQL·DB 소유자·악성 호스트·구버전 Writer·혼합 버전 배포·외부 서비스까지 강제하는 보안 경계가 아닙니다. 필요한 migration #1~8이 없으면 인프라 오류이며 보호를 생략하지 않습니다. 과거 migration 테스트는 최소 SQL fixture로 데이터를 준비하고, 현재 API 회귀는 전체 migration이 적용된 스키마에서 수행합니다.

`createRun`은 queued 생성만 하고 Lease를 만들지 않습니다. 조회 및 P3-A Claim/Renewal 계약은 유지합니다. `deleteExpiredToolResults`는 별도의 신뢰된 유지보수 경로로 만료 Result만 삭제하며 Run·Step·Lease를 지우지 않습니다. 기존 Runtime 세 함수·Executor에 자동 연결하지 않았고, 내부 synthetic 테스트로만 통합을 검증합니다. Reclaim·Release·Token 교체·Worker·heartbeat·Checkpoint·Replay·Retry·Recovery·Exactly-Once는 구현하지 않았습니다.

## Durable Checkpoint & Budget · 보수적 진행 기록 (P3-C 완료)

Issue #35는 PR #36으로 병합했고 main에서 검증했습니다. `createRunExecutionProgressRepository(db)`는 전용 connection을 제공하는 내부 DB 의존성을 받습니다. 기존 Runtime의 Decision/Tool 예산은 여전히 메모리에서 관리하며 새 Ledger를 자동 호출하지 않습니다. `run_steps`는 전체 Model/Tool 호출 로그가 아니므로 기존 Step에서 예산을 역산하거나 backfill하지 않습니다.

**A checkpoint watermark is evidence of observed committed metadata, not permission to replay.**

**A budget reservation is conservative accounting, not proof of a completed call.**

**Lease existence selects the write protocol. Expiry never falls back to legacy writes.**

| 내부 API | 계약 |
| --- | --- |
| `initializeProgress(runId, credentials, { maxDecisions, maxToolAttempts })` | 유효한 running Lease, Progress·Step·Safe Result 모두 없음. version 0, watermark null, 예약 0으로 최초 1행만 생성. 재초기화·backfill 금지. |
| `tryReserveDecision(runId, credentials, expectedVersion)` | version 일치·잔여 Decision 예산에서 예약과 version을 각각 +1. |
| `tryReserveToolAttempt(runId, credentials, expectedVersion)` | version 일치·잔여 Tool 예산 및 `toolAttemptsReserved < decisionsReserved`에서 예약과 version을 각각 +1. |
| `tryConfirmCommittedStep(runId, credentials, { expectedVersion, stepNo })` | 같은 Run의 COMMIT된 `continued` 또는 `tool_succeeded` Step을 정확히 다음 번호로만 확인. watermark 갱신, version +1; Step/Result·예산은 변경하지 않음. |
| `getProgressSnapshot(runId)` | 한 statement의 읽기 전용 관찰. Progress가 없으면 null; 있으면 Run 상태·Lease 관찰 상태·최대 Step·정합성 진단 포함. |

입력은 UUID Run/Owner/Token과 정확한 own data 필드만 허용합니다. Credential은 `{ ownerId, leaseToken }`, Decision 상한 1~5, Tool 상한 0~1, expectedVersion 0~2,147,483,647, stepNo 1~2,147,483,647입니다. Proxy·accessor·coercion·추가 override를 실행하지 않고 연결 전에 고정 입력 오류로 거부하며, 첫 await 전에 값을 캡처합니다. 정상 형식의 조건 불충족은 null, DB 오류는 reject입니다.

쓰기마다 전용 client의 READ COMMITTED 트랜잭션에서 **Run → Lease → Progress** 잠금을 완료한 뒤 첫 DML의 단일 `clock_timestamp()`로 판정합니다. 기존 P3-B Guard의 running·Owner/Token·미만료(`expires_at > t`)·시계 역행 방지·유한 시각 검증을 재사용합니다. 갱신 시 `t >= updated_at`도 요구합니다. version CAS와 INTEGER overflow 차단을 같은 UPDATE에 적용하며, COMMIT 응답 확인 후에만 불변 메타데이터를 반환합니다. SQL 실패는 rollback, COMMIT 응답 불확실·rollback 실패는 연결을 한 번 폐기하고 자동 재시도하지 않습니다. 권한 진입 후 COMMIT이 지연되면 반환 시 이미 Lease가 만료됐을 수 있습니다.

Migration #9의 `run_execution_progress`는 run_id PK/FK, schema_version=1, checkpoint_version, nullable last_confirmed_step_no, 두 예산 상한·예약 카운터, DB 생성 created_at/updated_at만 저장합니다. 모든 필수 필드는 NOT NULL, 예산 범위·예약 상한·Tool 예약 ≤ Decision 예약·유한 시각·updated_at ≥ created_at을 DB가 강제합니다. `(run_id, last_confirmed_step_no)`는 실제 Step 복합 FK이며 CASCADE 삭제하지 않습니다. 원본 Task/Prompt/Output/Error·임의 JSON/TEXT·Hash·Credential/Token은 저장하지 않습니다. UTC timestamp 반환은 microsecond 문자열이므로 Date 객체를 통한 변경도 없습니다. #1~8은 보존합니다. Down은 runs → Lease → Step → Progress 테이블 잠금 후 한 행이라도 있으면 active/expired/terminal/예산 소진 여부와 무관하게 거부하고 데이터·제약·이력을 보존합니다. 빈 Down과 Re-Up만 허용합니다.

Snapshot의 `diagnostic` 우선순위는 **inconsistent → steps_ahead → aligned**입니다. Step 순번에 구멍이 있거나 watermark가 관찰 최대값보다 크거나 확인 대상 Step이 없거나 비종료 종류가 아니면 inconsistent, 그 외 최대 Step이 watermark(null은 0)보다 크면 steps_ahead, 같으면 aligned입니다. Lease 관찰은 missing → run_not_running → invalid_clock → expired → active 순서로 판단합니다. Token·Owner·Task·원본 Step·Tool Output·실행 허가 필드는 반환하지 않습니다. **aligned/active는 resumable 또는 후속 쓰기 권한이 아닙니다.** Terminal Run도 관찰할 수 있지만 확인 API는 terminal Step을 허용하지 않습니다.

Step COMMIT과 watermark COMMIT은 별개입니다. Step #2 저장 후 프로세스가 종료되면 watermark #1과 `steps_ahead`가 남을 수 있으며 조회는 이를 수정하거나 재확인하지 않습니다. Terminal Finalizer와 Progress도 원자적으로 결합하지 않았습니다. 예산 예약은 실제 호출의 시작·성공·완료 증명이 아니고, 실패·응답 유실·crash 후 환불하지 않습니다. Tool 결과가 불명확할 때 재호출하면 외부 부작용이 중복될 수 있습니다. No Resume / No Retry / No Replay / No Recovery이며 Exactly-Once를 구현하지 않았습니다. 직접 SQL·구버전 writer·외부 서비스의 부작용까지 보호하지 않습니다. 기존 Runtime 세 경로는 메모리 예산을 사용합니다. 아래 P3-D 진입점에서 Decision 예산을 영속적으로 예약합니다.

신규 검증은 `apps/api/test/execution-progress.test.ts`와 `apps/api/test/db/execution-progress.test.ts`에 있으며 기존 `npm test` / `npm run test:db`에 포함됩니다. 격리 `axiom_test` schema에서 synthetic P3-A Claim → 예약 → P3-B Step COMMIT → 확인 흐름, 독립 backend의 CAS·잠금·renewal 경합, 시간 경계, 실패 원자성, migration 보호를 검사합니다. 정확한 microsecond 경계는 실제 SQL의 단일 clock 표현식만 치환하며 실제 DB 시계 기반 lock-wait와 구분합니다. COMMIT 후 응답 유실은 모사이며 실제 네트워크 단절 실험이 아닙니다. 기존 HTTP 서버 재시작 회귀도 계속 실행합니다. 추가 live smoke·외부 Tool/LLM 요청은 하지 않습니다.

## Trusted Lease-Bound Decision Orchestration · P3-D 완료

신뢰된 Host가 내부 함수 `runLeaseBoundedDecisions(runId, dependencies, options)`를 명시적으로 호출합니다. 호출자는 Owner UUID, Lease 기간(1~300초), Decision 상한(1~5회)을 지정합니다. 새 Claim이 성공해야 Progress를 초기화하며 Tool 예산은 0입니다. 이미 시작된 Run을 다시 호출하면 `not_started`로 끝납니다.

각 Decision은 해당 슬롯의 예산 예약 COMMIT을 확인한 뒤 호출합니다. 다음 슬롯을 사용하려면 먼저 `continued` Step과 그 순번의 watermark가 각각 COMMIT돼야 합니다. 마지막 `continue`는 `decision_limit_exceeded`, Tool 요청은 `unsupported_tool_request`로 종료합니다. Lease-aware Finalizer는 종료 상태와 Step을 함께 저장합니다. Terminal Step은 watermark에 포함하지 않으므로 정상 종료 후에도 snapshot이 `steps_ahead`일 수 있습니다.

Claim과 초기화는 별도 트랜잭션입니다. 초기화 실패나 콜백 도중 Lease 만료로 Run이 running에 남을 수 있습니다. 충돌은 단계별 고정 결과로 반환하고 DB 오류·불확실한 COMMIT은 호출자에게 reject합니다. 예산 환불, 자동 갱신·재개·재시도·재생·복구는 수행하지 않습니다. 예약은 실제 호출 완료를 보장하지 않으며 Exactly-Once도 제공하지 않습니다. 이 경로에는 Worker, HTTP 트리거, 실제 모델 클라이언트, Tool Executor가 없습니다.

## Durable Tool Attempt Protocol · P3-E 완료

신뢰된 Host가 내부 함수 `runLeaseBoundedToolDecisions(runId, dependencies, options)`를 선택해 호출합니다. 새 Lease를 획득한 Run에 Decision 1~5회, Tool Attempt 0~1회의 예산을 설정합니다. 마지막 Decision 슬롯에서는 Tool을 예약하지 않습니다. 그 외 슬롯에서 Tool 요청을 받으면 PostgreSQL의 예약 COMMIT 응답과 카운터를 확인한 뒤 Executor를 한 번 호출합니다. 순수 in-memory Handler는 호스트가 등록하고 동기 permit이 정확히 `true`일 때만 실행됩니다.

Tool 성공 시 `tool_succeeded` Step 저장과 해당 순번의 watermark 확인이 차례로 COMMIT돼야 다음 Decision을 예약합니다. 검증된 출력은 다음 Decision 한 번에만 메모리로 전달합니다. 이 경로는 Tool 인자·출력·해시를 저장하지 않습니다. Terminal Step은 watermark에 포함하지 않습니다.

예약 뒤 Lease가 만료되거나 응답이 유실되면 예산이 소비된 채 Run이 남을 수 있습니다. 실행 중 DB 트랜잭션을 잡아 두지 않으며 환불·자동 재시도·재생·복구도 수행하지 않습니다. 예약 기록만으로 외부 효과를 판별할 수 없습니다. 외부 fencing, Exactly-Once, 상시 Worker 프로세스와 사용자 승인은 후속 범위입니다.

## One-Shot Worker & Recovery Inspector · P3-F 완료

신뢰된 Host가 한 Run에 대해 `runOneShotWorker(runId, dependencies, options)`를 명시적으로 호출합니다. 옵션은 정확히 `mode`, `ownerId`(UUID), `leaseSeconds`(1~300), `maxDecisions`(1~5), `maxToolAttempts` 다섯 개입니다. 실행 전 모드별 의존성을 검사합니다.

| 모드 | Tool 예산 | 위임 |
|---|---|---|
| `decision_only` | 0 필수 | P3-D에 owner·Lease 기간·Decision 예산만 전달 |
| `tool_enabled` | 0 또는 1 | P3-E에 Tool 예산까지 전달. Handler는 기존 동기 permit 규칙 적용 |

Worker는 신뢰된 Host가 전달한 일반 함수, async 함수, 화살표 함수, 일반·async 메서드를 지원합니다. 첫 위임 전에 모든 콜백과 `executor.execute`의 형태를 검사합니다. 직접 전달된 클래스 생성자, Proxy, generator·async generator, 원본 소스를 확인할 수 없는 bound/native 함수는 입력 오류로 거부합니다. 일반 함수에 `bind()`를 적용한 경우도 여기에 포함됩니다.

이 검사는 변조되지 않은 JavaScript 내장 메서드를 전제로 합니다. Worker는 후보의 `toString`을 읽거나 후보를 실행·생성하지 않고 내장 `Function.prototype.toString`으로 소스 형태를 확인합니다. 함수 본문의 동작과 반환값은 실행 시점에 결정되며, 예외와 반환값 검증은 기존 Orchestrator 계약을 따릅니다.

두 경로 모두 Fresh Claim부터 기존 Orchestrator가 처리합니다. Worker는 한 번 위임하고 그 결과 또는 내부 rejection을 전달합니다. 응답이 유실돼도 다른 모드 호출, 자동 재시도·재개·재생·환불은 없습니다.

`createRunRecoveryInspectionRepository(pool).inspectRunRecovery(runId)`는 매개변수화한 SELECT 한 문장으로 Run·Lease·Progress·Step을 관찰합니다. PostgreSQL 시각은 한 번 평가합니다. Run이 없으면 `missing_run`을, 있으면 category와 status·lease·progress·steps, 두 진단 필드를 반환합니다. Progress 부재는 `null`입니다. Lease의 active/expired는 관찰 시각의 유효 기간만 나타냅니다.

| 분류 우선순위 | 관찰 의미 |
|---|---|
| `legacy_or_inconsistent_manual_review` | 시간·카운터 관계, Step 연속성, 종료 상태 등이 맞지 않거나 running에 Lease가 없어 수동 검토가 필요 |
| `terminal_observed` / `queued_observed` | 종료 상태와 마지막 종료 Step이 호환되거나, 아무 실행 기록이 없는 queued Run |
| `claimed_without_progress` | Lease 획득 뒤 초기화 기록이 없는 running Run |
| `ambiguous_attempt_manual_review` / `unconfirmed_step_manual_review` | Tool 예약에 대응하는 성공 Step이 없거나 비종료 Step이 watermark보다 앞섬 |
| `expired_lease_manual_review` / `active_lease_unverified` | 위 진단이 없는 running Run의 Lease 시간 관찰. 프로세스 생존 여부는 미확인 |

`ambiguousToolAttempt`와 `unconfirmedNonterminalStep`은 대표 분류와 함께 읽습니다. 예를 들어 Handler 응답 유실 후 failed Run과 종료 Step을 확인해도 Tool 효과는 불확실할 수 있습니다. 정상적인 마지막 종료 Step은 watermark 확인 대상에서 제외됩니다. DB 조회 실패는 `Recovery inspection query failed`, 응답 계약 위반은 `Invalid recovery observation`으로 reject합니다.

관찰은 즉시 오래될 수 있으며 실행 권한을 부여하지 않습니다. Inspector는 task·owner·token·Tool 원문을 읽거나 저장하지 않습니다. 테스트는 격리 DB에서 읽기 전용 트랜잭션, 독립 연결의 snapshot·Claim 경합, COMMIT 직후 응답 유실을 검증합니다. 운영 Worker 프로세스, polling, 자동 Lease 인수·복구 및 외부 부작용의 Exactly-Once는 후속 범위입니다.

## Trusted Host Authorization Policy · P4-A 로컬 검토 중

Host는 `createToolAuthorizationPolicy(rules?)`로 최대 32개의 정적 규칙을 구성하고 기존 Executor에 `permitExecution: createToolAuthorizationPermit(policy)`를 전달합니다. 기본 정책은 모든 요청을 거부합니다. 각 규칙은 Run UUID(대소문자 무관), Tool 이름, 중첩 인자의 정확한 값에 적용됩니다. 객체 키 순서는 무관하고 배열 순서와 숫자의 부호 있는 0은 구분합니다. 정책은 인자를 독립 복사하며 같은 범위의 중복 규칙은 거부합니다.

`evaluateToolAuthorization(policy, plan)`은 현재 요청을 평가합니다. `allow`만 동기 permit을 통과하고 `deny`와 `approval_required`에서는 Handler를 호출하지 않습니다. `approval_required`는 Host가 읽는 진단 결과입니다. P3-E에서는 Tool 예약의 COMMIT 응답을 받은 뒤 Executor가 Preflight와 정책 검사를 수행하므로 거부해도 예약은 유지됩니다. 거부 시 기존 `execution_unavailable` 경로를 따르며 Finalizer가 성공하면 Run은 failed로 종료됩니다.

권한의 출처는 신뢰된 Host 구성입니다. 같은 요청의 독립 실행은 매번 허용될 수 있습니다. 사용자 동의 확인, 승인 대기·재개, 일회성 허가, 만료·철회는 후속 P4 범위입니다. 이 정책은 Lease를 검사하거나 외부 효과의 Exactly-Once를 보장하지 않습니다.

## Run HTTP API · 생성과 조회

루트에서 `npm run build` 후 `npm start`를 실행합니다. `npm start`는 저장소 루트의 `.env`를 읽으며, 기존 환경 변수가 우선합니다. `packages/contracts`의 Zod 스키마와 타입은 workspace 패키지로 공유하고 빌드 시 JavaScript 및 타입 선언을 생성합니다.

```sh
curl -i http://127.0.0.1:3000/runs \
  -H 'Content-Type: application/json' \
  -d '{"task":"회의록 정리"}'
# 201 응답의 id로 조회
curl -i "http://127.0.0.1:3000/runs/<id>"
```

POST는 `task` 하나만 허용하며 원문의 양끝 공백을 유지합니다. 생성은 `201`, 조회는 `200`이고 동일한 네 필드 계약을 사용합니다. 응답 예시:

```json
{"id":"12345678-1234-4234-8234-123456789abc","task":"회의록 정리","status":"queued","createdAt":"2026-11-06T00:00:00.000Z"}
```

`createdAt`은 DB 시각을 UTC ISO 8601로 직렬화합니다. 잘못된 입력·UUID·JSON은 `400 INVALID_REQUEST`, 미존재 UUID는 `404 RUN_NOT_FOUND`, DB 미설정·연결 장애는 `503 DATABASE_UNAVAILABLE`, 내부 오류는 `500 INTERNAL_ERROR`입니다. 오류 형식은 `{"error":{"code":"INVALID_REQUEST","message":"Invalid request"}}`입니다. 본문 크기 제한(`413`)과 미지원 미디어 타입(`415`)도 상태 코드를 유지합니다. 오류 응답과 요청 오류 로그에 입력 원문이나 DB 상세 정보를 포함하지 않습니다.

## Validation · 검증

```sh
npm run typecheck
npm run build
npm test
npm run test:db  # PostgreSQL 테스트 컨테이너가 필요합니다.
```

| 명령 | 확인 대상 |
| --- | --- |
| `npm run typecheck` | 소스와 테스트의 TypeScript 타입 검사 |
| `npm run build` | contracts 패키지와 서버의 JavaScript 빌드 |
| `npm test` | HTTP 계약·오류·pool 종료, health regression, task 입력·DB 대상·모델 결정 계약·one-shot/bounded Runtime·Step repository·Continue Recorder·Tool Registry·snapshot·Dispatch Preflight·Outcome·In-Memory Executor·Tool Runtime/Recorder 보안 검증 (DB 불필요) |
| `npm run test:db` | 실제 PostgreSQL HTTP POST→GET, migration, repository, constraint, pool 종료, API 재시작 영속성, Runtime 동시 claim·종료 경합, Step 동시 append·bounded 실행·종료 경합·INSERT/COMMIT 실패 rollback·안전한 down |

health 테스트는 `app.inject()`를 사용하며 실제 TCP 포트를 열지 않습니다. 각 테스트의 앱 인스턴스는 종료 후 정리합니다. 실제 서버 기동과 SIGINT/SIGTERM 종료 신호는 A3에서 별도로 검증했습니다. A4 DB 테스트는 서로 다른 프로세스가 실제 loopback 포트에서 HTTP를 처리하고 정상 종료하는 흐름을 추가합니다.

## Roadmap · 개발 계획

아래는 단계별 개발 방향입니다. P0-A1~A4, P1-A~G 및 P2-A~F는 병합·검증 완료됐으며 P3-A~F는 병합·검증 완료됐고 P4-A는 로컬 구현·검토 단계입니다. 또한, 요구사항과 검증 결과에 따라 세부 범위가 조정될 수 있습니다.

| 단계 | 목표 | 상태 |
| --- | --- | --- |
| P0 — Foundation | 백엔드 기반, PostgreSQL 저장, Run API 계약, 테스트 환경 | A1~A4 완료 |
| P1 — Core Runtime | 실행 상태 머신, 모델 결정 계약, 실행 루프와 단계 기록 | P1-A~G 완료; 추가 실행 기능은 후속 범위 |
| P2 — Tool System | 도구 등록, 입력 검증, 실행 결과 저장, 첫 외부 연동 | P2-A~F 병합·main 검증 완료 |
| P3 — Durable Execution | 체크포인트, 재시도, 워커, 복구와 멱등성 | P3-A~F 완료 |
| P4 — Safety & Governance | 사용자 승인, 권한, 취소와 실행 예산 | P4-A 로컬 구현·검토 중 |
| P5 — Observability | 실행 타임라인, 메트릭, 트레이싱 | 예정 |
| P6 — Production Runtime | 다중 모델, 분산 실행, 동시성 제어와 테넌트 격리 | 예정 |

현재 런타임 의존성은 Fastify, pg와 Zod이며, migration에는 개발 의존성인 node-pg-migrate를 사용합니다. Redis·큐 등 추가 인프라는 구체적인 요구가 생겼을 때 검토합니다.

A2 설치 시 npm audit은 node-pg-migrate → glob/minimatch 개발 의존성 경로에 moderate 경고 3건을 보고했습니다. 자동 강제 다운그레이드나 호환성 미검증 override는 적용하지 않았습니다. 현재 migration 경로는 로컬 고정 경로이며 외부 glob 패턴을 받지 않습니다. 후속 patch 및 의존성 업데이트를 검토해야 합니다.

## Development Workflow · 개발 방식

`main`은 검증된 기준선입니다. 최초 P0-A1 baseline 이후 모든 기능·문서 변경은 목적이 분명한 별도 브랜치에서 진행합니다.

```text
main → feature branch → implementation → validation → diff review
     → approval → commit → push → PR → review → merge approval
     → merge → local main sync
```

- 브랜치에는 `feat/`, `fix/`, `test/`, `docs/`, `refactor/`, `chore/` 접두사를 사용합니다.
- 커밋은 Conventional Commits 형식으로 작성하고 하나의 명확한 변경 목적을 유지합니다.
- commit·push·merge는 명시적인 승인 범위 안에서 수행합니다. 일반 개발에서 `main`에 직접 commit·push하지 않습니다.
- 실제 자격증명과 환경 파일, 빌드·로컬 산출물을 커밋하지 않습니다. 공유용 환경 예시는 실제 비밀정보가 없는 `.env.example`로 작성합니다.
