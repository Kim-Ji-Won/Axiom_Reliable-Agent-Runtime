# Axiom — Reliable Agent Runtime

> Backend infrastructure for reliable, controlled execution of AI-agent workflows.

Axiom은 여러 단계로 이루어진 AI 에이전트 작업의 실행 상태와 제어를 관리하기 위한 백엔드 런타임 프로젝트입니다. 모델의 판단과 실제 행동의 실행 권한을 분리하고, 단계적인 개발을 통해 영속적 실행, 도구 검증, 승인 정책, 실행 이력을 갖추는 것을 목표로 합니다.

**현재 단계: P0-A1 — Backend Foundation 완료.** TypeScript 워크스페이스, Fastify API, 자동 테스트와 기본 실행 검증을 갖추었습니다. 에이전트 실행 루프와 데이터 영속성은 아직 구현하지 않았습니다.

## Overview · 프로젝트 개요

AI 에이전트가 외부 도구를 사용하며 장시간 작업하려면, 모델의 응답뿐 아니라 실행 과정 자체를 관리해야 합니다. 프로세스가 중단되었을 때의 복구 지점, 재시도 가능한 실패, 중복 실행의 영향, 사용자 승인이 필요한 행동을 명확하게 정의해야 합니다.

Axiom은 이러한 실행 제어를 담당하는 공통 Runtime을 지향합니다. GitHub 작업, 장애 대응, 리서치 등 서로 다른 에이전트가 동일한 실행 기반을 사용할 수 있도록 특정 업무와 실행 인프라의 책임을 분리합니다.

## Design Principles · 설계 원칙

**A model request is not execution authorization.** 모델은 행동을 요청하고, Runtime은 그 행동의 실행 가능 여부를 결정합니다.

다음은 단계적으로 구현할 책임 경계입니다. 현재 구현은 API 기반에 한정됩니다.

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

PostgreSQL, Run API, 모델 호출, 도구 실행, 워커, 승인 정책과 durable execution은 향후 구현 범위입니다. 현재 단계는 로컬 개발 기반이며 production readiness를 보장하지 않습니다.

## Architecture · 프로젝트 구조

현재 존재하는 주요 파일과 역할입니다.

```text
Axiom/
├── apps/api/
│   ├── src/
│   │   ├── app.ts              # Fastify 앱 구성과 health route
│   │   └── server.ts           # 서버 기동과 프로세스 종료
│   ├── test/
│   │   └── health.test.ts      # liveness 및 미등록 경로 테스트
│   ├── package.json
│   ├── tsconfig.json
│   └── tsconfig.build.json
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

서버 주소는 `http://127.0.0.1:3000`이며, 해당 포트가 비어 있어야 합니다. 환경 변수나 `.env` 파일은 필요하지 않습니다. `npm start`는 컴파일된 결과를 실행하므로 먼저 빌드해야 합니다.

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

## Validation · 검증

```sh
npm run typecheck
npm run build
npm test
```

| 명령 | 확인 대상 |
| --- | --- |
| `npm run typecheck` | 소스와 테스트의 TypeScript 타입 검사 |
| `npm run build` | 서버 소스의 JavaScript 빌드 |
| `npm test` | `/health`의 응답 코드·본문 및 미등록 경로의 404 응답 |

테스트는 `app.inject()`를 사용하며 실제 TCP 포트를 열지 않습니다. 각 테스트의 앱 인스턴스는 종료 후 정리합니다. 실제 서버 기동과 종료 신호 검증은 자동 테스트와 별도로 수행했습니다.

## Roadmap · 개발 계획

아래는 단계별 개발 방향입니다. P0-A1 이후 항목은 아직 구현하지 않았으며, 요구사항과 검증 결과에 따라 세부 범위가 조정될 수 있습니다.

| 단계 | 목표 | 상태 |
| --- | --- | --- |
| P0 — Foundation | 백엔드 기반, PostgreSQL 저장, Run API 계약, 테스트 환경 | A1 완료; A2 이후 예정 |
| P1 — Core Runtime | 실행 상태 머신, 모델 결정 계약, 실행 루프와 단계 기록 | 예정 |
| P2 — Tool System | 도구 등록, 입력 검증, 실행 결과 저장, 첫 외부 연동 | 예정 |
| P3 — Durable Execution | 체크포인트, 재시도, 워커, 복구와 멱등성 | 예정 |
| P4 — Safety & Governance | 사용자 승인, 권한, 취소와 실행 예산 | 예정 |
| P5 — Observability | 실행 타임라인, 메트릭, 트레이싱 | 예정 |
| P6 — Production Runtime | 다중 모델, 분산 실행, 동시성 제어와 테넌트 격리 | 예정 |

현재 런타임 의존성은 Fastify입니다. PostgreSQL은 다음 저장 단계에서 도입할 예정이며, Redis·큐 등 추가 인프라는 구체적인 요구가 생겼을 때 검토합니다.

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
