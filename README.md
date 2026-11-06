# Axiom — Reliable Agent Runtime

> Backend infrastructure for reliable, controlled execution of AI-agent workflows.

Axiom은 여러 단계로 이루어진 AI 에이전트 작업의 실행 상태와 제어를 관리하기 위한 백엔드 런타임 프로젝트입니다. 모델의 판단과 실제 행동의 실행 권한을 분리하고, 단계적인 개발을 통해 영속적 실행, 도구 검증, 승인 정책, 실행 이력을 갖추는 것을 목표로 합니다.

**현재 단계: P0-A3 — Run HTTP API 구현 및 검토 단계.** PostgreSQL repository를 사용하는 Run 생성·조회 HTTP API와 공유 Zod 계약을 추가했습니다. 에이전트 실행 루프는 아직 구현하지 않았습니다.

## Overview · 프로젝트 개요

AI 에이전트가 외부 도구를 사용하며 장시간 작업하려면, 모델의 응답뿐 아니라 실행 과정 자체를 관리해야 합니다. 프로세스가 중단되었을 때의 복구 지점, 재시도 가능한 실패, 중복 실행의 영향, 사용자 승인이 필요한 행동을 명확하게 정의해야 합니다.

Axiom은 이러한 실행 제어를 담당하는 공통 Runtime을 지향합니다. GitHub 작업, 장애 대응, 리서치 등 서로 다른 에이전트가 동일한 실행 기반을 사용할 수 있도록 특정 업무와 실행 인프라의 책임을 분리합니다.

## Design Principles · 설계 원칙

**A model request is not execution authorization.** 모델은 행동을 요청하고, Runtime은 그 행동의 실행 가능 여부를 결정합니다.

다음은 단계적으로 구현할 책임 경계입니다. 현재 구현은 Run HTTP API와 PostgreSQL persistence에 한정됩니다.

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

P0-A1에서 구현하고 검증한 범위는 다음과 같습니다.

| 항목 | 현재 상태 |
| --- | --- |
| Workspace | npm workspaces 기반 TypeScript 구성 |
| Type safety | strict 타입 검사와 테스트 코드 타입 검사 |
| Application | 포트를 열지 않는 `buildApp()` 구성 함수 |
| Process lifecycle | 별도 서버 진입점, SIGINT·SIGTERM 종료 처리 |
| Health endpoint | `GET /health` → `200 {"status":"ok"}` |
| Automated tests | 포트를 열지 않는 Fastify injection 테스트 2개 |
| Baseline validation | 타입 검사, 빌드, 테스트, 실제 HTTP 요청 및 두 종료 신호 검증 완료 |

`/health`는 **API liveness**만 나타냅니다. 데이터베이스 readiness나 외부 의존성의 정상 동작을 확인하지 않습니다.

P0-A2에서는 PostgreSQL 개발·테스트 환경, 마이그레이션, Run repository와 DB 통합 테스트를 추가했습니다. P0-A3에서는 Run 생성·조회 API를 추가했습니다. 모델 호출, 도구 실행, 워커, 승인 정책과 durable execution은 향후 구현 범위입니다. 현재 단계는 로컬 개발 기반이며 production readiness를 보장하지 않습니다.

## Architecture · 프로젝트 구조

현재 존재하는 주요 파일과 역할입니다.

```text
Axiom/
├── apps/api/
│   ├── src/
│   │   ├── app.ts              # Fastify 앱 구성과 health route
│   │   ├── server.ts           # 서버 기동과 프로세스 종료
│   │   └── persistence/        # DB pool 및 Run repository
│   ├── test/
│   │   ├── health.test.ts      # liveness 및 미등록 경로 테스트
│   │   ├── persistence.test.ts # 입력 및 테스트 DB 안전장치
│   │   └── db/                # 실제 PostgreSQL 통합 테스트
│   ├── package.json
│   ├── tsconfig.json
│   └── tsconfig.build.json
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

`app.ts`는 네트워크 포트를 열지 않으며, `server.ts`가 실제 listener를 시작합니다. 자동 테스트도 같은 앱 구성 함수를 사용합니다. 빌드 결과는 `apps/api/dist/`에 생성되며 테스트 파일과 생성 산출물은 각각 빌드 대상과 Git 추적 대상에서 제외됩니다.

Runtime, Model, Tool 패키지는 해당 단계에서 실제 역할이 필요할 때 추가합니다.

## Getting Started · 실행 방법

### Requirements

- **Node.js 22.21.0:** `.nvmrc`에 기록된 검증 버전입니다. 프로젝트의 허용 범위는 `>=22.21.0 <23`입니다.
- **npm 10.9.4:** baseline 검증에 사용한 버전입니다.

직접 의존성은 정확한 버전으로 지정하고, 전체 의존성 트리는 `package-lock.json`으로 기록합니다. `.npmrc`에서 engine 호환성을 검사합니다.

아래 명령은 모두 프로젝트 루트에서 실행합니다. nvm을 사용한다면 먼저 버전을 선택합니다.

```sh
nvm install
nvm use
```

### Install & Run

```sh
npm ci
npm run build
npm start
```

서버 주소는 `http://127.0.0.1:3000`이며, 해당 포트가 비어 있어야 합니다. health API만 실행할 때는 DB 환경 변수나 `.env` 파일이 필요하지 않습니다. `npm start`는 컴파일된 결과를 실행하므로 먼저 빌드해야 합니다.

별도 터미널에서 응답을 확인합니다.

```sh
curl --fail --include http://127.0.0.1:3000/health
```

예상 응답은 HTTP `200`과 다음 JSON입니다.

```json
{"status":"ok"}
```

Ctrl-C(SIGINT) 또는 SIGTERM으로 서버를 정상 종료할 수 있습니다.

### Development

```sh
npm run dev
```

`tsx watch`를 사용해 소스 변경 시 서버를 다시 시작합니다. watch mode의 실제 재시작 동작은 baseline 검증 범위에 포함되지 않았습니다.

## PostgreSQL · 로컬 저장 환경

Docker Desktop과 Docker Compose가 필요합니다. API는 컨테이너화하지 않으며 Compose는 PostgreSQL만 실행합니다.

```sh
cp .env.example .env
# .env의 두 비밀번호와 각 URL의 비밀번호를 같은 값으로 교체합니다.
npm run db:up
npm run db:migrate
npm run db:migrate:test
npm run test:db
```

이미 `.env`가 있다면 복사로 덮어쓰지 마세요. `.env`는 Git에서 제외됩니다. URL의 비밀번호에 특수문자가 포함되면 URL encoding이 필요합니다. Node의 `--env-file-if-exists`를 사용하므로 dotenv는 설치하지 않습니다. 명시적으로 export한 환경 변수가 `.env`보다 우선합니다.

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
| `status` | TEXT, 기본값 `queued`, CHECK로 `queued`만 허용 |
| `created_at` | TIMESTAMPTZ, DB의 `NOW()` 기본값 |

애플리케이션은 잘못된 타입·빈 값·공백 전용 값·길이 초과·NUL·잘못된 Unicode 문자열을 거부합니다. DB는 NOT NULL, 길이, JavaScript trim 공백 집합에 해당하는 nonblank CHECK, status CHECK 및 UUID/PK 제약을 독립적으로 강제합니다. emoji도 PostgreSQL `char_length`와 동일하게 code point 단위로 셉니다. 사용자 입력의 양끝 공백은 저장 전에 제거하지 않습니다.

`createRunRepository(db)`는 `createRun(task): Promise<Run>`과 `findRunById(id): Promise<Run | null>`을 제공합니다. 반환값은 `{ id, task, status: 'queued', createdAt: Date }`입니다. status는 호출자가 지정할 수 없고, 조회 시에도 `queued` 여부를 확인합니다. 오류는 숨기지 않고 호출자에게 전달하며 DB 오류나 task 내용을 그대로 로그에 남기지 않습니다.

각 생성은 parameterized INSERT 한 문장이므로 DB의 단일 문장 원자성을 사용합니다. `createDatabase(url)`로 만든 pool의 종료 책임은 호출자에게 있습니다. `withDatabase(url, work)`는 성공·실패 모두 `finally`에서 pool을 종료합니다. HTTP 앱은 DB 설정이 있으면 pool 하나를 소유하고 요청 간 재사용하며 `app.close()`에서 종료합니다. 연결은 요청 시 시작하므로 DB가 꺼져도 `/health`는 정상 동작합니다.

### Migrations & Test Isolation

`db/migrations/1793883600000-create-runs.cjs`는 timestamp-prefix 이름의 첫 migration입니다. `node-pg-migrate`가 `pgmigrations`에 이력을 기록하며, 재실행 시 이미 적용한 migration을 건너뜁니다. 실행기는 advisory lock과 단일 transaction을 사용합니다.

`npm run test:db`는 DB 이름이 정확히 `axiom_test`인지 확인한 뒤 실행별 임시 스키마를 만듭니다. migration up → 재실행 → down → up, repository 저장·조회, 별도 Node 프로세스 간 영속성, DB 제약을 검증하고 자신의 스키마만 삭제합니다. 테스트용 URL에 개발 DB를 지정하면 schema 생성 전에 실패합니다. 테스트 실패 시 DB 테스트를 자동 skip하지 않습니다.

rollback은 테이블 데이터를 삭제하므로 제공된 실행기에서는 임시 테스트 스키마에만 허용합니다. 개발 DB 초기화나 자동 rollback 명령은 제공하지 않습니다. SQL migration 자체의 `down`은 파괴적이므로 별도 도구로 직접 실행할 때 주의해야 합니다.

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
| `npm test` | HTTP 계약·오류·pool 종료, health regression, task 입력 및 DB 대상 검증 (DB 불필요) |
| `npm run test:db` | 실제 PostgreSQL HTTP POST→GET, migration, repository, constraint, pool 종료, 프로세스 간 영속성 |

health 테스트는 `app.inject()`를 사용하며 실제 TCP 포트를 열지 않습니다. 각 테스트의 앱 인스턴스는 종료 후 정리합니다. 실제 서버 기동과 종료 신호 검증은 자동 테스트와 별도로 수행했습니다.

## Roadmap · 개발 계획

아래는 단계별 개발 방향입니다. P0-A2는 완료됐으며 P0-A3는 구현 후 검토 단계입니다. 이후 항목은 아직 구현하지 않았습니다. 또한, 요구사항과 검증 결과에 따라 세부 범위가 조정될 수 있습니다.

| 단계 | 목표 | 상태 |
| --- | --- | --- |
| P0 — Foundation | 백엔드 기반, PostgreSQL 저장, Run API 계약, 테스트 환경 | A1·A2 완료; A3 구현·검토 중 |
| P1 — Core Runtime | 실행 상태 머신, 모델 결정 계약, 실행 루프와 단계 기록 | 예정 |
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
