# Axiom — Reliable Agent Runtime

> Backend infrastructure for reliable, controlled execution of AI-agent workflows.

Axiom은 여러 단계로 이루어진 AI 에이전트 작업의 실행 상태와 제어를 관리하기 위한 백엔드 런타임 프로젝트입니다. 모델의 판단과 실제 행동의 실행 권한을 분리하고, 단계적인 개발을 통해 영속적 실행, 도구 검증, 승인 정책, 실행 이력을 갖추는 것을 목표로 합니다.

**현재 단계: P2-A — Trusted Tool Registry + Input Snapshot Validation 구현·검토 중. P0-A1~A4 및 P1-A~G 완료.** PostgreSQL repository를 사용하는 Run 생성·조회 HTTP API와 공유 Zod 계약을 추가했습니다. 내부 `tryStartRun(id)`와 `tryFinishRun(id, outcome)`으로 `queued → running → completed | failed` 전이를 지원합니다. 내부 one-shot 실행과 최대 5회 결정의 bounded loop를 제공하며 자동 실행·실제 모델 및 도구 호출은 연결하지 않았습니다.

## Overview · 프로젝트 개요

AI 에이전트가 외부 도구를 사용하며 장시간 작업하려면, 모델의 응답뿐 아니라 실행 과정 자체를 관리해야 합니다. 프로세스가 중단되었을 때의 복구 지점, 재시도 가능한 실패, 중복 실행의 영향, 사용자 승인이 필요한 행동을 명확하게 정의해야 합니다.

Axiom은 이러한 실행 제어를 담당하는 공통 Runtime을 지향합니다. GitHub 작업, 장애 대응, 리서치 등 서로 다른 에이전트가 동일한 실행 기반을 사용할 수 있도록 특정 업무와 실행 인프라의 책임을 분리합니다.

## Design Principles · 설계 원칙

**A model request is not execution authorization.** 모델은 행동을 요청하고, Runtime은 그 행동의 실행 가능 여부를 결정합니다.

다음은 단계적으로 구현할 책임 경계입니다. 현재 구현은 Run HTTP API, PostgreSQL persistence, 모델 결정 계약, 내부 one-shot/bounded orchestration, Step metadata 저장소와 종료·기록의 원자적 결합, 실행 없는 Tool Registry·입력 snapshot 검증까지입니다.

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

P0-A2에서는 PostgreSQL 개발·테스트 환경, 마이그레이션, Run repository와 DB 통합 테스트를 추가했습니다. P0-A3에서는 Run 생성·조회 API를 추가했습니다. 모델 호출, 도구 실행, 워커, 승인 정책과 durable execution은 향후 구현 범위입니다. 현재 단계는 로컬 개발 기반이며 production readiness를 보장하지 않습니다.

## Architecture · 프로젝트 구조

현재 존재하는 주요 파일과 역할입니다.

```text
Axiom/
├── apps/api/
│   ├── src/
│   │   ├── app.ts              # Fastify 앱 구성, health 및 Run routes
│   │   ├── server.ts           # 서버 기동과 프로세스 종료
│   │   ├── persistence/        # DB pool, Run/Step, atomic finalizer, continue recorder
│   │   ├── runtime/            # run-one-decision.ts / run-bounded-decisions.ts
│   │   └── tools/              # tool-registry.ts / tool-request-resolver.ts / tool-arguments-snapshot.ts
│   ├── test/
│   │   ├── health.test.ts      # liveness 및 미등록 경로 테스트
│   │   ├── persistence.test.ts # 입력 및 테스트 DB 안전장치
│   │   ├── run-step-repository.test.ts # Step 입력·반환·연결 정리 경계
│   │   ├── atomic-run-finalizer.test.ts # 종료·Step 트랜잭션 및 실패 경계
│   │   ├── bounded-runtime.test.ts # 실행 예산·순서·중단 경계
│   │   ├── run-continue-recorder.test.ts # continued 트랜잭션·연결 정리
│   │   ├── runtime.test.ts     # claim·결정·종료 및 오류 경계
│   │   ├── model-decision.test.ts # 모델 결정·JSON 안전성 및 경계 검증
│   │   ├── tool-request-resolver.test.ts # Registry·strict schema·TOCTOU·비실행 경계
│   │   ├── tool-arguments-snapshot.test.ts # JSON 경계·독립 복사·deep freeze
│   │   ├── runs-http.test.ts   # Run 계약·오류·라우터 회귀 테스트
│   │   └── db/                # runs/run-steps/atomic-finalization/bounded-runtime.test.ts, process-fixture.ts
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
| `result_kind` | TEXT, NOT NULL, 현재 일곱 값의 CHECK (다섯 번째 migration 포함) |
| `created_at` | TIMESTAMPTZ, NOT NULL, DB의 NOW() 기본값 |

조회 가능한 결과는 `completed`, `unsupported_tool_request`, `invalid_decision`, `decision_source_error`, `finalize_conflict`, `continued`, `decision_limit_exceeded`입니다. 기존 일반 `appendRunStep()`은 앞의 다섯 종류만 받습니다. `continued`는 아래 Continue Recorder에서만, `decision_limit_exceeded`는 Atomic Finalizer에서 failed 종료와 함께 기록합니다. `not_started`는 기록하지 않습니다. 사용자 task, final content, 모델 원문, 도구 이름·인자, 예외 상세와 자격증명을 저장할 컬럼은 없습니다. UUID와 결과 종류는 연결을 얻기 전에 검증하고 입력 오류에는 원문을 담지 않습니다. DB 오류는 호출자에게 전달하며 저장소 자체에서 로그를 남기지 않습니다.

Append마다 pool에서 전용 연결을 빌려 `BEGIN ISOLATION LEVEL READ COMMITTED → runs 부모 행 SELECT FOR UPDATE → MAX(step_no)+1 INSERT → COMMIT`을 수행합니다. 부모 잠금을 얻은 뒤 별도 SQL에서 새 snapshot으로 다음 순번을 계산하므로 지원되는 append 경로에서는 같은 Run의 동시 요청이 1, 2로 기록됩니다. 다른 Run의 번호는 독립적입니다. 실패하면 같은 연결에서 ROLLBACK하고 연결을 반환하며 rollback도 실패하면 연결을 폐기합니다. Pool 자체의 종료 책임은 호출자에게 있습니다. 이미 트랜잭션 중인 공유 client를 연결 제공자로 전달하는 방식은 지원하지 않습니다.

이력 순서는 timestamp가 아닌 `step_no`로 판단합니다. 순번 보장은 이 repository의 append 경로에 한정하며 외부 SQL 수정·삭제까지 통제하지 않습니다. INTEGER 범위를 넘으면 DB 오류가 발생하고 재시도하지 않습니다. COMMIT 중 연결 장애는 결과가 불확실할 수 있으므로 자동 retry나 exactly-once를 보장하지 않습니다.

네 번째 migration의 down은 runner의 단일 트랜잭션 안에서 `run_steps`를 ACCESS EXCLUSIVE로 잠근 뒤 행 존재를 검사합니다. 빈 테이블만 제거하고 세 migration 상태로 복귀합니다. 이력이 있으면 오류로 중단하여 Step·Run 데이터, 제약과 migration 이력을 보존합니다. 기존 임시 테스트 schema 전용 rollback 제한을 유지합니다.

독립 `appendRunStep()`은 Run 상태를 변경하지 않습니다. 이 저장소는 외부 SQL 변경을 통제하는 감사 원장이 아닙니다. Runtime의 종료와 기록 결합은 아래 P1-F의 별도 finalizer를 사용합니다.

### Atomic Runtime Finalization · 종료와 Step 기록 (P1-F 완료)

`createAtomicRunFinalizer(pool).tryFinalizeWithStep(runId, resultKind)`는 성공 시 `{ run, step }`, 미존재·queued·종료된 Run이면 `null`을 반환합니다. UUID와 아래 다섯 종료 resultKind만 연결 획득 전에 검증하며 상태는 내부에서 결정합니다.

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

`npm run test:db`는 네 DB 테스트 파일을 순차 실행합니다(migration 전역 잠금의 경합 방지). DB 이름이 정확히 `axiom_test`인지 확인한 뒤 실행별 임시 스키마를 만듭니다. migration up → 재실행 → down → up, repository 저장·조회, 별도 Node 프로세스 간 영속성, API 프로세스 재시작 전후 실제 HTTP 응답 일치, 독립 연결의 동시 시작·동시 종료·최종 상태 GET·rollback 성공 및 거부, DB 제약을 검증하고 자신의 스키마만 삭제합니다. 테스트용 URL에 개발 DB를 지정하면 schema 생성 전에 실패합니다. 테스트 실패 시 DB 테스트를 자동 skip하지 않습니다.

첫 migration의 rollback은 테이블 데이터를 삭제하므로 제공된 실행기에서는 임시 테스트 스키마에만 허용합니다. 개발 DB 초기화나 자동 rollback 명령은 제공하지 않습니다. 첫 SQL migration 자체의 `down`은 파괴적이므로 별도 도구로 직접 실행할 때 주의해야 합니다.

DB 저장·조회는 durable execution이나 crash recovery를 의미하지 않습니다. 해당 실행 의미와 검증은 P3 범위입니다.

## Tool Registry & Input Snapshot · 실행 없는 검증 (P2-A 구현·검토 중)

`apps/api/src/tools/`는 Runtime과 연결되지 않은 내부 검증 계층입니다. `createToolRegistry(definitions)`는 신뢰된 애플리케이션 코드가 제공한 `{ name, inputSchema }` 목록만 사용합니다. 실제 도구 정의나 handler는 기본 등록하지 않습니다. 이름은 기존 Model Decision의 1~64자 규칙을 재사용하고 중복·잘못된 이름은 고정된 설정 오류로 거부합니다. 비공개 Map을 사용하므로 prototype chain을 조회하지 않으며 빈 Registry에는 기본 허용 도구가 없습니다. `constructor` 같은 유효한 이름도 명시적으로 등록해야 조회됩니다.

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

**A model request is not execution authorization.** 조회·검증 성공은 실행 승인·사용자 동의가 아닙니다. Handler/Executor, 외부 모델 API, 실제 Tool·network·filesystem·shell 호출은 추가하지 않았습니다. 기존 one-shot/bounded Runtime은 계속 tool_request를 `failed + unsupported_tool_request`로 종료합니다. HTTP endpoint, Run 상태, 다섯 DB migration과 저장 데이터는 그대로이며 Tool arguments를 DB에 저장하지 않습니다.

후속 P2 단계에서 실행·Runtime 통합·결과 처리 책임을 별도 설계하고 승인받습니다. 사용자 승인, 권한 및 정책 집행은 P4 Safety & Governance의 별도 책임입니다. P2-A는 아직 병합 전 구현·검토 상태입니다.

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
| `npm test` | HTTP 계약·오류·pool 종료, health regression, task 입력·DB 대상·모델 결정 계약·one-shot/bounded Runtime·Step repository·Continue Recorder·Tool Registry·snapshot 보안 검증 (DB 불필요) |
| `npm run test:db` | 실제 PostgreSQL HTTP POST→GET, migration, repository, constraint, pool 종료, API 재시작 영속성, Runtime 동시 claim·종료 경합, Step 동시 append·bounded 실행·종료 경합·INSERT/COMMIT 실패 rollback·안전한 down |

health 테스트는 `app.inject()`를 사용하며 실제 TCP 포트를 열지 않습니다. 각 테스트의 앱 인스턴스는 종료 후 정리합니다. 실제 서버 기동과 SIGINT/SIGTERM 종료 신호는 A3에서 별도로 검증했습니다. A4 DB 테스트는 서로 다른 프로세스가 실제 loopback 포트에서 HTTP를 처리하고 정상 종료하는 흐름을 추가합니다.

## Roadmap · 개발 계획

아래는 단계별 개발 방향입니다. P0-A1~A4와 P1-A~G는 완료됐으며 P2-A는 Trusted Tool Registry + Input Snapshot Validation 구현·검토 단계입니다. 이후 항목은 아직 구현하지 않았습니다. 또한, 요구사항과 검증 결과에 따라 세부 범위가 조정될 수 있습니다.

| 단계 | 목표 | 상태 |
| --- | --- | --- |
| P0 — Foundation | 백엔드 기반, PostgreSQL 저장, Run API 계약, 테스트 환경 | A1~A4 완료 |
| P1 — Core Runtime | 실행 상태 머신, 모델 결정 계약, 실행 루프와 단계 기록 | P1-A~G 완료; 추가 실행 기능은 후속 범위 |
| P2 — Tool System | 도구 등록, 입력 검증, 실행 결과 저장, 첫 외부 연동 | P2-A 실행 없는 Registry·snapshot 검증 구현·검토 중; 실행·연동은 예정 |
| P3 — Durable Execution | 체크포인트, 재시도, 워커, 복구와 멱등성 | 예정 |
| P4 — Safety & Governance | 사용자 승인, 권한, 취소와 실행 예산 | 예정 |
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
