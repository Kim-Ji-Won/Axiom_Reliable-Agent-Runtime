# Axiom — Reliable Agent Runtime

> Backend infrastructure for reliable, controlled execution of AI-agent workflows.

Axiom은 여러 단계로 이루어진 AI 에이전트 작업의 실행 상태와 제어를 관리하기 위한 백엔드 런타임 프로젝트입니다. 모델의 판단과 실제 행동의 실행 권한을 분리하고, 단계적인 개발을 통해 영속적 실행, 도구 검증, 승인 정책, 실행 이력을 갖추는 것을 목표로 합니다.

**현재 단계: P1-D — One-Shot Runtime 구현 브랜치에서 검토 중. P0-A1~A4 및 P1-A·B·C 완료.** PostgreSQL repository를 사용하는 Run 생성·조회 HTTP API와 공유 Zod 계약을 추가했습니다. 내부 `tryStartRun(id)`와 `tryFinishRun(id, outcome)`으로 `queued → running → completed | failed` 전이를 지원합니다. 자동 실행이나 에이전트 실행 루프는 아직 구현하지 않았습니다.

## Overview · 프로젝트 개요

AI 에이전트가 외부 도구를 사용하며 장시간 작업하려면, 모델의 응답뿐 아니라 실행 과정 자체를 관리해야 합니다. 프로세스가 중단되었을 때의 복구 지점, 재시도 가능한 실패, 중복 실행의 영향, 사용자 승인이 필요한 행동을 명확하게 정의해야 합니다.

Axiom은 이러한 실행 제어를 담당하는 공통 Runtime을 지향합니다. GitHub 작업, 장애 대응, 리서치 등 서로 다른 에이전트가 동일한 실행 기반을 사용할 수 있도록 특정 업무와 실행 인프라의 책임을 분리합니다.

## Design Principles · 설계 원칙

**A model request is not execution authorization.** 모델은 행동을 요청하고, Runtime은 그 행동의 실행 가능 여부를 결정합니다.

다음은 단계적으로 구현할 책임 경계입니다. 현재 구현은 Run HTTP API, PostgreSQL persistence, 모델 결정 계약과 내부 one-shot orchestration까지입니다.

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
│   │   ├── persistence/        # DB pool 및 Run repository
│   │   └── runtime/            # run-one-decision.ts; 내부 단일 결정 실행
│   ├── test/
│   │   ├── health.test.ts      # liveness 및 미등록 경로 테스트
│   │   ├── persistence.test.ts # 입력 및 테스트 DB 안전장치
│   │   ├── runtime.test.ts     # claim·결정·종료 및 오류 경계
│   │   ├── model-decision.test.ts # 모델 결정·JSON 안전성 및 경계 검증
│   │   ├── runs-http.test.ts   # Run 계약·오류·라우터 회귀 테스트
│   │   └── db/                # runs.test.ts 및 process-fixture.ts; DB/HTTP 재시작 검증
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
{ kind: 'final', content: '분석 결과입니다.' }
{ kind: 'tool_request', toolName: 'search_documents', arguments: { query: 'PostgreSQL' } }
```

`final.content`는 원문을 보존하며 1~4000 Unicode code points, 비공백 텍스트만 허용합니다. NUL과 짝이 맞지 않는 surrogate를 거부합니다. `toolName`은 소문자로 시작하는 1~64자의 소문자·숫자·`_`·`-`입니다. 두 variant 모두 추가 필드와 암묵적 타입 변환을 거부합니다.

`arguments`는 JSON 객체이며 루트 객체를 깊이 1로 세고 중첩 객체·배열은 최대 깊이 8까지 허용합니다. 공백 없는 `JSON.stringify(arguments)` 형식의 UTF-8 크기는 최대 8192 bytes입니다. 키·구분자·escape·반복 참조의 직렬화 크기도 포함합니다. 검증은 객체의 getter나 `toJSON`을 실행하지 않고 data property를 검사하며 문자열·유한 숫자·boolean·null·배열·객체를 보존합니다.

Node.js의 `util.types.isProxy`로 Proxy를 탐지해 trap 실행 전에 거부합니다. 같은 realm의 plain object(Object.prototype 또는 null prototype)와 밀집 배열만 받으며 accessor·symbol key·숨겨진 속성·사용자 지정 prototype·비 JSON 객체·순환 참조를 거부합니다. 방문 깊이와 값/문자열 처리량은 제한하지만 `Reflect.ownKeys` 자체는 전달된 객체의 전체 키 목록을 생성합니다. 입력 객체의 생성 및 전송 크기 제한은 호출 경계에서도 적용해야 합니다. 현재 구현은 Node.js용이며 브라우저 지원은 검증하지 않았습니다.

`parseModelDecision`은 실패 시 Run 입력 오류와 별개의 `InvalidModelDecisionError`를 던집니다. 스키마는 Zod 오류를 반환하며, 실패 입력은 오류 생성 전에 제거해 `reportInput` 옵션에서도 원문·인자·비밀정보가 담기지 않도록 합니다. 검증된 인자는 복사·freeze하지 않으므로 호출자는 검증 후 입력을 변경하지 않고 사용해야 합니다.

**A model request is not execution authorization.** `tool_request`는 모델의 도구 요청 제안이며 실행 승인은 별도 Runtime 정책의 책임입니다. `final`도 최종 텍스트 제안입니다. P1-C는 결정 계약과 입력 검증까지 구현하며, 모델 호출·provider adapter·권한 정책·실제 도구 실행·Run 자동 전이·실행 루프는 후속 단계입니다.

### One-Shot Runtime · 단일 결정 실행 (P1-D 검토 중)

`apps/api/src/runtime/run-one-decision.ts`의 `runOneDecision(runId, { repository, decide })`는 기존 `tryStartRun`·`tryFinishRun`과 주입된 테스트용 `decide(run): Promise<unknown>`를 연결합니다. 실제 모델 호출이나 HTTP 호출 경로는 연결하지 않았습니다.

```text
queued → 원자적 claim → running → decide 1회 → parseModelDecision → 종료 시도
```

| 상황 | 종료 시도 | 반환 결과 |
| --- | --- | --- |
| 미존재·이미 running·종료 Run | 없음, decide 호출 없음 | `not_started` |
| 유효한 final | completed | 종료 성공 시에만 `completed`와 원문 `content` |
| 유효한 tool_request | failed | `unsupported_tool_request` |
| 계약 위반 | failed | `invalid_decision` |
| 결정 함수 throw/reject | failed | `decision_source_error` |
| 어떤 종료 시도든 null 반환 | 추가 조회·재시도 없음 | `finalize_conflict` |

**A model request is not execution authorization.** 도구 요청은 현재 초기 정책에 따라 failed로 종료하며 Tool Registry 조회·승인·실행은 수행하지 않습니다. `completed` 이외의 결과에는 모델 원문·도구 이름·인자·task·결정 함수 오류를 담지 않으며 Runtime은 이를 로그에 남기지 않습니다. 최종 텍스트는 호출자에게만 일시적으로 반환하고 DB나 HTTP 응답에 저장·추가하지 않습니다.

잘못된 UUID와 시작·종료 DB 오류는 호출자에게 reject되며 정상 결과로 위장하지 않습니다. 호출자는 persistence 예외의 상세 내용을 그대로 로그나 외부 응답에 노출하지 않아야 합니다. Runtime은 pool을 만들거나 닫지 않으며 의존성을 제공한 호출자가 연결 수명을 관리합니다.

이 기능은 in-process 한 번의 결정 시도입니다. 프로세스 중단이나 DB 오류로 Run이 running에 남을 수 있고 자동 복구하지 않습니다. exactly-once 실행, retry, timeout, cancellation, durable recovery, 여러 단계의 실행 루프를 보장하지 않습니다. `decide`는 신뢰하는 주입 코드이며 Runtime이 해당 함수의 부작용을 격리하지는 않습니다. P1-D는 아직 병합 전 검토 단계입니다.

### Migrations & Test Isolation

`db/migrations/1793883600000-create-runs.cjs`는 timestamp-prefix 이름의 첫 migration입니다. `node-pg-migrate`가 `pgmigrations`에 이력을 기록하며, 재실행 시 이미 적용한 migration을 건너뜁니다. 실행기는 advisory lock과 단일 transaction을 사용합니다.

기존 migration은 보존하고 `1793962800000-allow-running-runs.cjs`를 추가했습니다. 새 migration은 상태 CHECK만 확장하며 기존 행과 `queued` 기본값을 유지합니다. 기존 DB에서는 `npm run db:migrate`로 새 migration을 적용한 뒤 내부 시작 연산을 사용하세요. 이 migration의 down은 `running` 행이 하나라도 있으면 제약 검증에서 안전하게 실패하고 행·기존 제약·migration 이력을 유지합니다. 행을 `queued`로 되돌리거나 삭제하지 않습니다.

새 `1793966400000-allow-finished-runs.cjs`는 네 상태를 허용하며 기존 queued/running 행을 보존합니다. 이 migration의 down은 종료 행이 없을 때 queued/running 제약으로 돌아갑니다. completed 또는 failed 행이 있으면 데이터·현재 제약·migration 이력을 바꾸지 않고 실패합니다. 개발 DB에 자동 적용하지 않습니다.

`npm run test:db`는 DB 이름이 정확히 `axiom_test`인지 확인한 뒤 실행별 임시 스키마를 만듭니다. migration up → 재실행 → down → up, repository 저장·조회, 별도 Node 프로세스 간 영속성, API 프로세스 재시작 전후 실제 HTTP 응답 일치, 독립 연결의 동시 시작·동시 종료·최종 상태 GET·rollback 성공 및 거부, DB 제약을 검증하고 자신의 스키마만 삭제합니다. 테스트용 URL에 개발 DB를 지정하면 schema 생성 전에 실패합니다. 테스트 실패 시 DB 테스트를 자동 skip하지 않습니다.

첫 migration의 rollback은 테이블 데이터를 삭제하므로 제공된 실행기에서는 임시 테스트 스키마에만 허용합니다. 개발 DB 초기화나 자동 rollback 명령은 제공하지 않습니다. 첫 SQL migration 자체의 `down`은 파괴적이므로 별도 도구로 직접 실행할 때 주의해야 합니다.

DB 저장·조회는 durable execution이나 crash recovery를 의미하지 않습니다. 해당 실행 의미와 검증은 P3 범위입니다.

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
| `npm test` | HTTP 계약·오류·pool 종료, health regression, task 입력·DB 대상·모델 결정 계약·one-shot Runtime 검증 (DB 불필요) |
| `npm run test:db` | 실제 PostgreSQL HTTP POST→GET, migration, repository, constraint, pool 종료, API 재시작 영속성, Runtime 동시 claim·종료 경합 |

health 테스트는 `app.inject()`를 사용하며 실제 TCP 포트를 열지 않습니다. 각 테스트의 앱 인스턴스는 종료 후 정리합니다. 실제 서버 기동과 SIGINT/SIGTERM 종료 신호는 A3에서 별도로 검증했습니다. A4 DB 테스트는 서로 다른 프로세스가 실제 loopback 포트에서 HTTP를 처리하고 정상 종료하는 흐름을 추가합니다.

## Roadmap · 개발 계획

아래는 단계별 개발 방향입니다. P0-A1~A4와 P1-A·B·C는 완료됐으며 P1-D는 One-Shot Runtime 구현·검토 단계입니다. 이후 항목은 아직 구현하지 않았습니다. 또한, 요구사항과 검증 결과에 따라 세부 범위가 조정될 수 있습니다.

| 단계 | 목표 | 상태 |
| --- | --- | --- |
| P0 — Foundation | 백엔드 기반, PostgreSQL 저장, Run API 계약, 테스트 환경 | A1~A4 완료 |
| P1 — Core Runtime | 실행 상태 머신, 모델 결정 계약, 실행 루프와 단계 기록 | P1-A·B·C 완료; P1-D One-Shot Runtime 구현·검토 중; 나머지 예정 |
| P2 — Tool System | 도구 등록, 입력 검증, 실행 결과 저장, 첫 외부 연동 | 예정 |
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
