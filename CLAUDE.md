# CLAUDE.md

Guidance for AI coding assistants (Claude Code and similar) working in this repository.

## What This Project Is

A **prototype / scaffold** for a full-stack automation and analytics platform: a workflow
orchestration engine with a real-time analytics layer, a Next.js dashboard frontend, and
integrations with GitHub and OpenAI Codex. The `package.json` author is "Manus AI" — this
looks like AI-scaffolded boilerplate rather than a mature, battle-tested codebase.

**Current state: this is a thin skeleton, not a working system.** Several files central to the
architecture (as described by the code that does exist) are missing entirely — see
"Known Gaps / Gotchas" below before assuming anything runs end-to-end. There is no README,
no CI, no Dockerfiles, no lockfiles, and no `node_modules` installed anywhere in the repo as
of this writing.

## Directory Structure

```
automation-system-backend/
├── backend/                          Node.js/Express microservices (no shared package, each file is standalone)
│   ├── api-gateway.js                Entry point (main). Auth, rate limiting, proxies to other services.
│   ├── automation-service.js         Workflow CRUD + execution (Postgres + Redis).
│   ├── analytics-service.js          Event/metrics ingestion, queries, trends, summary stats.
│   ├── codex-integration-service.js  OpenAI Codex wrapper (code gen/completion/review/docs/tests).
│   ├── github-integration-service.js GitHub OAuth + webhook handling, PR automation.
│   ├── package.json                  Scripts + dependencies for ALL backend services (single package).
│   ├── .env.example                  Documents every env var the backend code reads.
│   └── tests/
│       └── api-gateway.test.js       Jest + Supertest — tests a locally re-declared mock Express
│                                     app, NOT the real api-gateway.js (see gotchas).
├── frontend/                         Next.js 14 + TypeScript dashboard (App Router assumed, not present)
│   ├── components/
│   │   └── Dashboard.tsx             Client component: metrics cards, Recharts charts, executions table.
│   └── package.json                  Next.js/React/Tailwind/Recharts/Zustand/React Query stack.
└── infrastructure/
    └── docker-compose.yml            Defines postgres, redis, api-gateway, automation-service,
                                       analytics-service, dashboard-service, integration-service,
                                       frontend, prometheus, grafana.
```

There is no `frontend/app` or `frontend/pages` directory, no `next.config.js`, no
`tailwind.config.js`, and no `tsconfig.json` — only the one `Dashboard.tsx` component exists.
There is no top-level `database-schema.sql`, despite being referenced by both
`backend/package.json` (`db:init` script) and `infrastructure/docker-compose.yml` (Postgres
init volume).

## Tech Stack

**Backend** (`backend/package.json`): Node.js (`>=16`), Express 4, `pg` (raw SQL, no ORM),
`redis` v4 client, `jsonwebtoken`, `axios`, `joi` (declared but unused in the code that exists —
validation is hand-rolled in `api-gateway.js`), `winston` (declared, unused), `socket.io`
(declared, unused), `bull` (declared, unused — execution queuing is a `TODO` stub), and
`temporal-sdk` (declared, unused — also just a `TODO` stub). Test stack: Jest + Supertest.
Lint/format: ESLint + Prettier (declared, **no config files present**).

**Frontend** (`frontend/package.json`): Next.js 14, React 18, TypeScript 5, Tailwind CSS 3,
Recharts, `tremor`, Zustand, TanStack React Query v4, `next-auth`, React Hook Form + Zod,
`socket.io-client`.

**Infrastructure**: PostgreSQL 15 (alpine), Redis 7 (alpine), Prometheus, Grafana, all wired
in `infrastructure/docker-compose.yml`. The compose file references `../backend/Dockerfile`
and `../frontend/Dockerfile` — **neither Dockerfile exists in the repo**, so `docker compose
up --build` will fail until they're added.

## Setup / Dev / Build / Test / Lint Commands

All commands below are as declared in the two `package.json` files; they have not been
verified to succeed given the gaps noted above (e.g. no lockfile, no `node_modules`).

### Backend (`cd backend`)
```bash
npm install                # no package-lock.json committed — will resolve fresh
npm run dev                # nodemon api-gateway.js (port from API_GATEWAY_PORT, default 3000)
npm run dev:automation     # nodemon automation-service.js (default port 3001)
npm run dev:analytics      # nodemon analytics-service.js (default port 3002)
npm run dev:dashboard      # nodemon dashboard-service.js — FILE DOES NOT EXIST, will error
npm run dev:all            # concurrently runs dev + dev:automation + dev:analytics + dev:dashboard
npm run start / start:*    # same as dev:* but with `node` instead of `nodemon`
npm test                   # jest — only backend/tests/api-gateway.test.js exists
npm run lint               # eslint . — no .eslintrc present, will need a config to do anything
npm run format             # prettier --write .
npm run db:init            # psql -U postgres -d automation_db -f ../database-schema.sql — FILE DOES NOT EXIST
```
Note: `codex-integration-service.js` and `github-integration-service.js` have no npm scripts
at all (no `start:codex`, `start:github`, `dev:codex`, `dev:github`). To run them you must
invoke Node directly, e.g. `node codex-integration-service.js` (reads `CODEX_SERVICE_PORT`,
default 3006) or `node github-integration-service.js` (reads `GITHUB_INTEGRATION_PORT`,
default 3004).

### Frontend (`cd frontend`)
```bash
npm install
npm run dev          # next dev
npm run build        # next build
npm run start        # next start
npm run lint          # next lint
npm run type-check    # tsc --noEmit
npm run format        # prettier --write .
```

### Infrastructure
```bash
cd infrastructure
docker compose up     # WILL FAIL: backend/Dockerfile and frontend/Dockerfile are missing,
                       # and prometheus.yml referenced by the prometheus service is also absent
```

## Architecture & Conventions Actually Observed

- **Gateway-only auth.** `api-gateway.js` is the only service that verifies JWTs
  (`authenticateToken` middleware using `jsonwebtoken`, secret from `JWT_SECRET` env var,
  falling back to the hardcoded string `'your-secret-key'` if unset — treat that fallback as a
  bug, not a feature, in any production-facing change). Downstream services
  (`automation-service.js`, `analytics-service.js`, etc.) do **not** re-verify auth; they trust
  the `X-User-ID` header forwarded by the gateway's `proxyRequest` helper. Any new downstream
  route should follow this same trust boundary rather than re-implementing JWT checks.
- **Two different response envelopes are in use simultaneously** — this is a real
  inconsistency, not a stylistic choice to preserve:
  - `api-gateway.js` responses: `{ success: boolean, data, error: { code, message } }`
  - All other services (`automation-service.js`, `analytics-service.js`,
    `codex-integration-service.js`, `github-integration-service.js`): flat `{ code, data,
    message, meta }` with no `success` field.
  If you touch either shape, be deliberate about which convention the file already follows;
  don't silently mix them within one service.
- **Direct `pg` access, no ORM/query builder, no migrations tooling.** Every service that
  touches Postgres (`automation-service.js`, `analytics-service.js`,
  `codex-integration-service.js`, `github-integration-service.js`) instantiates its own
  `new Pool({...})` from the same env vars (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`,
  `DB_NAME`) rather than sharing a connection module. Schema is expected to come from a
  `database-schema.sql` file that does not currently exist in the repo — tables referenced in
  code (`workflows`, `workflow_executions`, `workflow_tasks`, `events`, `analytics_metrics`,
  `github_integrations`, `webhook_logs`) have no corresponding `CREATE TABLE` anywhere checked
  in. If you need the schema, you'll have to infer column names from the SQL in these files
  (e.g. `automation-service.js`'s `INSERT INTO workflows (id, name, description, owner_id,
  definition, status)`) or ask the user for it.
- **Redis used both as cache and (declared but unimplemented) queue.** `automation-service.js`
  and `analytics-service.js` use Redis purely as a read-through cache
  (`redisClient.get/setEx/del`, keyed like `workflow:${id}`, 1hr TTL). Actual workflow
  execution queuing (`queueWorkflowExecution` in `automation-service.js`) and event publishing
  (`publishEvent` in `analytics-service.js`) are stub functions that only `console.log` — the
  `bull`/`temporal-sdk`/Kafka/RabbitMQ integration implied by `.env.example` and
  `docker-compose.yml` (`TEMPORAL_SERVER_URL`, `CONDUCTOR_SERVER_URL`, `KAFKA_BROKERS`,
  `RABBITMQ_URL`) is not implemented in code.
- **Naive SQL-injection guard.** `analytics-service.js`'s `/query` endpoint (arbitrary SQL
  execution!) is only protected by a regex blacklist (`isValidQuery`) checking for
  `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, `ALTER TABLE`, `CREATE TABLE`, `INSERT INTO`,
  `UPDATE`. This is trivially bypassable and should not be treated as a real security boundary
  — flag this if asked to harden the analytics service.
- **Codex service targets a deprecated OpenAI API.** `codex-integration-service.js` calls
  `POST /completions` with `model: 'text-davinci-003'` — both the legacy Completions API and
  that specific model are deprecated/retired by OpenAI. Any real integration work here should
  probably migrate to the Chat Completions or Responses API with a current model.
  `CODEX_API_ENDPOINT` in `.env.example` is defined but never read by the code (the base URL
  is hardcoded in `codexClient = axios.create({ baseURL: 'https://api.openai.com/v1', ... })`).
- **GitHub webhook verification uses `crypto.timingSafeEqual`** on the `X-Hub-Signature-256`
  header (HMAC-SHA256 over the raw JSON body, secret from `GITHUB_WEBHOOK_SECRET`) — note this
  will throw if the two buffers differ in length (a `Buffer.byteLength` mismatch), which is
  itself a small correctness bug in `verifyWebhookSignature` worth knowing about if you touch
  it.
- **Frontend data fetching**: `Dashboard.tsx` uses TanStack React Query with short polling
  intervals (5s for summary/executions, 10s for trends) hitting `NEXT_PUBLIC_API_URL` (default
  `http://localhost:3000`), reading the JWT out of `localStorage.getItem('token')` directly
  (no `next-auth` wiring visible despite it being a dependency). No WebSocket/`socket.io-client`
  usage exists yet despite being a listed dependency.
- **Standard Express security middleware stack** in the gateway only: `helmet`, `cors`
  (origins from `ALLOWED_ORIGINS`), `compression`, `express-rate-limit` (100 req/15min per IP,
  applied globally, not per-route), `morgan('combined')` logging.

## Environment Variables

Documented in `backend/.env.example` (copy to `backend/.env`; no secret values are printed
here). Key groups:
- API Gateway: `NODE_ENV`, `API_GATEWAY_PORT`, `ALLOWED_ORIGINS`
- Database: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Redis: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`
- Auth: `JWT_SECRET`, `JWT_EXPIRATION`, `REFRESH_TOKEN_EXPIRATION`
- Service URLs/ports: `AUTOMATION_SERVICE_URL/PORT`, `ANALYTICS_SERVICE_URL/PORT`,
  `DASHBOARD_SERVICE_URL/PORT`, `INTEGRATION_SERVICE_URL/PORT`, `USER_SERVICE_URL/PORT`
- Workflow orchestration (unimplemented): `TEMPORAL_SERVER_URL`, `TEMPORAL_NAMESPACE`,
  `CONDUCTOR_SERVER_URL`
- Queues (unimplemented): `QUEUE_TYPE`, `BULL_REDIS_URL`, `KAFKA_BROKERS`, `RABBITMQ_URL`
- GitHub: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`
- Codex/OpenAI: `OPENAI_API_KEY`, `CODEX_API_ENDPOINT` (defined but unused by code)
- Logging: `LOG_LEVEL`, `LOG_FORMAT`, `SENTRY_DSN`
- Email (unimplemented): `SMTP_*`
- Storage (unimplemented): `STORAGE_TYPE`, `AWS_*`
- Feature flags: `ENABLE_REAL_TIME_UPDATES`, `ENABLE_WORKFLOW_SCHEDULING`,
  `ENABLE_GITHUB_INTEGRATION`, `ENABLE_CODEX_INTEGRATION`, `ENABLE_ANALYTICS` (declared, not
  actually read/branched-on anywhere in the current code)
- Rate limiting / CORS / timezone: `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`,
  `CORS_ORIGIN`, `CORS_CREDENTIALS`, `TZ`

Frontend needs `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` (seen referenced in
`Dashboard.tsx` / `docker-compose.yml`), but there is no `frontend/.env.example` file.

## Known Gaps / Gotchas (read before assuming things work)

1. **Missing files referenced elsewhere in the repo:**
   - `backend/dashboard-service.js` — referenced by 4 npm scripts and by
     `infrastructure/docker-compose.yml`'s `dashboard-service`, but does not exist.
   - Top-level `database-schema.sql` — referenced by `npm run db:init` and by the Postgres
     container's init volume in docker-compose; does not exist.
   - `backend/Dockerfile` and `frontend/Dockerfile` — referenced by every docker-compose build
     context; neither exists.
   - `infrastructure/prometheus.yml` — mounted into the Prometheus container; does not exist.
   - No single file named `integration-service.js` exists even though docker-compose defines
     one `integration-service` container — the closest real code is the two separate files
     `github-integration-service.js` and `codex-integration-service.js`, which are not merged
     and use different default ports (`GITHUB_INTEGRATION_PORT` default 3004,
     `CODEX_SERVICE_PORT` default 3006) than the compose file's single
     `INTEGRATION_SERVICE_PORT` (3004).
2. **No lockfiles, no `node_modules`, no CI.** There's no `package-lock.json`/`yarn.lock` in
   either `backend/` or `frontend/`, and no `.github/workflows`. Nothing has been run/verified
   in this environment — assume `npm install` needs to happen before anything else works, and
   double check dependency versions resolve (some, like `tremor@^3.8.0`, may have moved or been
   renamed on npm since this was scaffolded).
3. **No lint/format configs.** `eslint`/`prettier` are dependencies and have npm scripts, but
   there is no `.eslintrc*`, `eslint.config.js`, or `.prettierrc*` anywhere in the repo, so
   `npm run lint` will likely fail or no-op until a config is added.
   the frontend also has no `tsconfig.json` despite a `type-check` script that runs `tsc`.
4. **The only test file doesn't test the real code.** `backend/tests/api-gateway.test.js`
   redeclares a small mock Express app inline (with a hardcoded `'test-secret'` JWT secret)
   instead of importing `../api-gateway.js`. Passing this test suite does not guarantee the
   real gateway works. If asked to add real test coverage, prefer importing the actual service
   modules (note: as written, `api-gateway.js` etc. call `app.listen()` at import time with no
   guard, so they'll need a refactor — e.g. only listening when `require.main === module` — to
   be safely `require`d from tests without binding a real port).
5. **No shared/common package** between the backend services — expect duplicated boilerplate
   (Postgres pool setup, health check route, error-handling middleware, server startup block)
   copy-pasted across `automation-service.js`, `analytics-service.js`,
   `codex-integration-service.js`, and `github-integration-service.js`. If refactoring for
   DRYness, that's a deliberate, low-risk improvement — just do it consistently across all
   four files.
6. **Author field says "Manus AI"** and the description says "Full-Stack Automation +
   Analytics System" — there's no other product documentation (no README, no ARCHITECTURE.md,
   no ADRs) to cross-check assumptions against, so treat this CLAUDE.md and direct code reading
   as the source of truth.

## Practical Guidance for Future Changes

- Before wiring up something docker-compose already declares (e.g. `dashboard-service`,
  `integration-service`, Dockerfiles, `prometheus.yml`), check whether the referenced file
  actually exists first — several don't, per the gaps above.
- When adding a new backend service/route, match the existing per-service conventions (own
  `Pool`, own `/health` route, own error-handling middleware at the bottom, `PORT` from a
  service-specific env var with a hardcoded fallback) unless you're deliberately consolidating
  them — don't introduce a third response envelope shape.
- When adding real workflow execution or event publishing, look at the `TODO` stub functions
  (`queueWorkflowExecution` in `automation-service.js`, `publishEvent` in
  `analytics-service.js`) — they mark exactly where real integration (Temporal/Bull/Kafka/
  WebSocket) needs to be plugged in.
- Don't assume `npm install`/`npm test`/`docker compose up` currently succeed in this repo —
  verify locally after making changes, and call out clearly in your work if a gap above blocks
  verification.
