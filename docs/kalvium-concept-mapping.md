# Kalvium Mandatory Concept Mapping — RAIN API Observatory

This document maps all **17 mandatory assessment concepts** to their exact implementations inside `rain-api-observatory`, along with concise viva explanations for project assessment.

---

## Concept Checklist Summary

| #   | Concept                                    | Status                         | Primary Location                                                                                        |
| --- | ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 1   | LLM API Integration                        | Implemented                    | `apps/server/src/ai/gemini-client.ts`                                                                   |
| 2   | Prompt Engineering                         | Implemented                    | `apps/server/src/ai/prompt-builder.ts`                                                                  |
| 3   | Structured Outputs                         | Implemented                    | `packages/shared/src/ai-analysis.ts`, `apps/server/src/ai/gemini-client.ts`                             |
| 4   | Middleware                                 | Implemented                    | `apps/server/src/app.ts`, `apps/server/src/ai/ai-analysis-routes.ts`                                    |
| 5   | Environment Variables & Secrets Management | Implemented                    | `apps/server/src/config.ts`, `apps/server/src/logger.ts`, `.env.example`                                |
| 6   | Git Workflow                               | Verified & Documented          | `.github/workflows/ci.yml`, `docs/kalvium-concept-mapping.md`                                           |
| 7   | Async Data Fetching from API               | Implemented                    | `apps/web/src/features/incidents/ai-analysis-api.ts`, `apps/web/src/lib/api-client.ts`                  |
| 8   | JavaScript Async/Await                     | Implemented                    | `apps/server/src/ai/ai-analysis-service.ts`, `apps/server/src/ai/gemini-client.ts`                      |
| 9   | JavaScript Closures                        | Implemented                    | `apps/server/src/ai/ai-analysis-routes.ts`, `apps/server/src/incidents/incident-repository.ts`          |
| 10  | JavaScript Event Loop                      | Implemented                    | `apps/server/src/monitoring/worker-engine.ts`, `apps/server/src/ai/gemini-client.ts`                    |
| 11  | JavaScript Hoisting                        | Implemented (Isolated Example) | `apps/server/src/examples/js-fundamentals.ts`                                                           |
| 12  | Promises vs Callbacks                      | Implemented (Isolated Example) | `apps/server/src/examples/js-fundamentals.ts`                                                           |
| 13  | React `useState`                           | Implemented                    | `apps/web/src/features/incidents/incident-ai-panel.tsx`                                                 |
| 14  | MongoDB CRUD Operations                    | Implemented                    | `apps/server/src/ai/ai-analysis-repository.ts`, `apps/server/src/ai/ai-analysis-routes.ts`              |
| 15  | MongoDB Schema Modelling                   | Implemented                    | `apps/server/src/ai/ai-analysis-model.ts`                                                               |
| 16  | Relational Schema Design (PK / FK)         | Implemented                    | `apps/server/src/db/schema.ts`, `apps/server/drizzle/0000`–`0007`                                       |
| 17  | SQL JOINs (PostgreSQL)                     | Implemented                    | `apps/server/src/incidents/incident-repository.ts`, `apps/server/src/analytics/analytics-repository.ts` |

---

## Detailed Concept Mapping

### 1. LLM API Integration

- **File path:** `apps/server/src/ai/gemini-client.ts`
- **Relevant module:** `createGeminiClient`
- **Implementation:** A backend-only adapter calls Google Gemini's `v1beta/models/{model}:generateContent` REST endpoint via `fetch` with an `AbortController` timeout (20 s default). `GEMINI_API_KEY` is passed strictly in the `x-goog-api-key` HTTP header on the server and never exposed to the browser or placed in URLs. Triggered from the incident details UI via `POST /api/v1/incidents/:incidentId/ai-analyses`.
- **Assessor explanation:** Keeping the LLM integration exclusively on the Express backend ensures secret API keys stay off client devices, allows server-side rate limiting and telemetry sanitization before sending context, and decouples the UI from provider-specific API changes.

### 2. Prompt Engineering

- **File path:** `apps/server/src/ai/prompt-builder.ts`
- **Relevant symbols:** `AI_ANALYSIS_PROMPT_VERSION` (`'incident-analysis-v1'`), `SYSTEM_INSTRUCTION`, `buildIncidentAnalysisPrompt`, `sanitizePromptText`
- **Implementation:** Uses a versioned system instruction paired with a structured JSON telemetry payload retrieved from PostgreSQL. Before constructing the prompt, monitor URLs are stripped of query strings/userinfo via `sanitizeUrlForLog`, and regex redaction removes accidental `Bearer`, `Basic`, or `apiKey=` tokens. The prompt instructs Gemini to separate observed facts (`supportingEvidence`) from hypotheses (`potentialCauses`), forbid inventing unseen internal server logs, calibrate confidence (`LOW` / `MEDIUM` / `HIGH`), and state telemetry gaps in `limitations`.
- **Assessor explanation:** Prompt versioning lets us track which instruction set produced each stored analysis, while explicit grounding rules and sanitization prevent secret leakage and reduce LLM hallucinations.

### 3. Structured Outputs

- **File paths:** `packages/shared/src/ai-analysis.ts`, `apps/server/src/ai/gemini-client.ts`
- **Relevant symbols:** `AiStructuredAnalysisSchema`, `GEMINI_ANALYSIS_RESPONSE_SCHEMA`
- **Implementation:** Requests Gemini with `responseMimeType: 'application/json'` and an explicit `responseSchema`. When the response arrives, `createGeminiClient` parses JSON (stripping accidental code fences), checks empty/safety-blocked candidates, and validates against `AiStructuredAnalysisSchema` using Zod `.safeParse()`. Invalid or incomplete outputs raise `AppError(502, 'AI_PROVIDER_ERROR', ...)` rather than saving corrupt data.
- **Assessor explanation:** Combining model-level JSON schema guidance with strict server-side Zod validation ensures the frontend always receives a predictable, type-safe structure and fails safely if the LLM misbehaves.

### 4. Middleware

- **File paths:** `apps/server/src/app.ts`, `apps/server/src/ai/ai-analysis-routes.ts`, `apps/server/src/auth/require-auth.ts`, `apps/server/src/http/error-handler.ts`
- **Relevant modules:** `createApp`, `requireAuth`, `createAiRateLimiters`, `notFoundHandler`, `errorHandler`
- **Implementation:** Express 5 executes middleware in strict order: `pinoHttp` request ID/logging → `helmet()` security headers → `cors()` allow-list → `express.json({ limit: '256kb' })` → unauthenticated `/healthz`, `/readyz`, and `/api/v1/public` → `/api` global rate limiter → `requireAuth` JWT verification → `Cache-Control: no-store` → feature routers (with `createAiRateLimiters` per-IP and per-user middleware on `POST .../ai-analyses`) → `notFoundHandler` → `errorHandler`.
- **Assessor explanation:** Middleware order is critical: authentication must run before per-user rate limiters (so `currentUser(req).id` exists), and error-handling middleware must be registered last so thrown `AppError` and `ZodError` instances format uniformly.

### 5. Environment Variables and Secrets Management

- **File paths:** `apps/server/src/config.ts`, `apps/server/src/logger.ts`, `.env.example`
- **Relevant symbols:** `aiEnv`, `loadServerConfig`, `REDACT_PATHS`
- **Implementation:** Zod validates `GEMINI_API_KEY`, `GEMINI_MODEL`, `MONGODB_URI`, and `MONGODB_DB_NAME` at server boot alongside `DATABASE_URL` and `ENCRYPTION_KEY`. Configuration errors report variable names only, never secret values. `REDACT_PATHS` in Pino redacts `GEMINI_API_KEY`, `MONGODB_URI`, and `x-goog-api-key` headers from logs. Both `GEMINI_API_KEY` and `MONGODB_URI` are optional at boot so RAIN stays online when AI dependencies are unconfigured.
- **Assessor explanation:** Validating environment variables at startup catches misconfigurations early without leaking credentials into logs, and `.env.example` documents every variable without storing real secrets.

### 6. Git Workflow

- **File paths:** `.github/workflows/ci.yml`, `docs/kalvium-concept-mapping.md`
- **Relevant configuration:** CI workflow (`verify` + `integration` jobs)
- **Implementation:** Work is preserved cleanly on the `feat/kalvium-ai-incident-analysis` branch without rewriting history. `.github/workflows/ci.yml` triggers `on: push: branches: [master, main]` and `on: pull_request:` so both the `verify` (`typecheck`, `lint`, `format:check`, `test`, `build`) and `integration` (`test:integration` with Postgres Testcontainers and MongoDB service) jobs run on PRs and direct pushes to either default branch.
- **Recommended practical workflow:**
  1. Branch from `main`/`master`: `git checkout -b feat/incident-ai-analysis`
  2. Keep changes atomic and run local checks (`npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`)
  3. Commit with Conventional Commits (`feat(ai): ...`, `test(ai): ...`, `docs: ...`)
  4. Push branch and open a Pull Request so GitHub Actions `verify` and `integration` jobs run before merging.

### 7. Async Data Fetching from API

- **File paths:** `apps/web/src/features/incidents/ai-analysis-api.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/features/incidents/incident-ai-panel.tsx`
- **Relevant hooks:** `useIncidentAiAnalyses`, `useGenerateIncidentAiAnalysis`, `useUpdateIncidentAiAnalysis`, `useDeleteIncidentAiAnalysis`
- **Implementation:** Reuses RAIN's `createApiClient` (which attaches Supabase Bearer tokens, handles 401 token refresh, and validates envelopes with Zod) inside TanStack Query `useQuery` and `useMutation` hooks. `IncidentAiPanel` handles `isPending` (skeletons), `isError` (`ErrorState` with retry), unavailable capability (`Alert`), empty state, and optimistic/cache-synchronized updates.
- **Assessor explanation:** Using TanStack Query over the shared Zod-validated API client avoids duplicate fetch logic, caches server responses, and cleanly separates server state from local React UI state.

### 8. JavaScript Async/Await

- **File paths:** `apps/server/src/ai/ai-analysis-service.ts`, `apps/server/src/ai/gemini-client.ts`, `apps/server/src/ai/ai-analysis-repository.ts`
- **Implementation:** Asynchronous PostgreSQL JOIN queries (`await incidentRepository.findAnalysisContext(...)`), Gemini HTTP calls (`await doFetch(...)`), JSON decoding (`await res.json()`), and Mongoose CRUD operations (`await Model.create(...)`, `await Model.find(...)`) are written sequentially using `async`/`await` with `try`/`catch`/`finally` cleanup (such as clearing abort timers).
- **Assessor explanation:** `async`/`await` makes asynchronous I/O pipelines read linearly while still yielding to the Node.js event loop while awaiting network or database responses.

### 9. JavaScript Closures

- **File paths:** `apps/server/src/ai/ai-analysis-routes.ts`, `apps/server/src/ai/gemini-client.ts`, `apps/server/src/ai/ai-analysis-service.ts`, `apps/server/src/incidents/incident-repository.ts`
- **Relevant factories:** `createAiRateLimiters`, `createGeminiClient`, `createAiAnalysisService`, `queries(db)`
- **Implementation:** Each factory function captures configuration and dependencies in its lexical scope and returns functions/middleware/methods that retain private access to those bindings without global state. For example, `createAiRateLimiters(limits)` encloses `limits`, `common`, and the `rejected(scope)` error-builder closure to produce Express middleware handlers.
- **Assessor explanation:** Closures enable clean dependency injection and encapsulation in TypeScript/Node without exposing private dependencies like `apiKey` or database handles to callers.

### 10. JavaScript Event Loop

- **File paths:** `apps/server/src/monitoring/worker-engine.ts`, `apps/server/src/ai/gemini-client.ts`
- **Implementation:** Node.js executes JS on a single event loop thread while offloading network and database I/O to libuv/OS asynchronous APIs. In `worker-engine.ts`, the monitoring loop manages up to `concurrency` checks concurrently using an active `Set<Promise<void>>`, non-blocking timer pauses (`setTimeout`), and `Promise.race` / `Promise.allSettled` during graceful shutdown. In `gemini-client.ts`, `AbortController` + `setTimeout` cancels stalled LLM calls without blocking other Express requests.
- **Assessor explanation:** Because neither the monitoring worker nor the Gemini HTTP adapter blocks the main thread, Express can serve concurrent API users while background checks and LLM calls await network I/O.

### 11. JavaScript Hoisting

- **File path:** `apps/server/src/examples/js-fundamentals.ts` (tested in `apps/server/src/examples/js-fundamentals.test.ts`)
- **Relevant function:** `demonstrateFunctionHoisting`
- **Implementation:** An isolated, non-production executable example invokes a function declaration (`doubleValue`) before its lexical definition, demonstrates that reading a `const` before initialization throws a `ReferenceError` (Temporal Dead Zone), and contrasts that with `var` initializing to `undefined` (which is banned in RAIN production files via ESLint `no-var`).
- **Assessor explanation:** Function declarations hoist both binding and body; `let`/`const` hoist the binding into a Temporal Dead Zone (`ReferenceError` before declaration); `var` hoists to function scope as `undefined`, which causes subtle bugs.

### 12. Promises vs Callbacks

- **File path:** `apps/server/src/examples/js-fundamentals.ts` (tested in `apps/server/src/examples/js-fundamentals.test.ts`)
- **Relevant functions:** `fetchStepWithCallback`, `fetchStepWithPromise`, `runPromisePipeline`
- **Implementation:** Contrasts a `queueMicrotask` error-first callback function with Promise-returning `async` functions composed via `await`. RAIN uses Promises/`async`/`await` across all production modules so errors propagate automatically to Express's async error handler and `Promise.all` / `Promise.allSettled` can coordinate concurrent work.
- **Assessor explanation:** Callbacks invert control and require manual error propagation at every nesting level, whereas Promises provide standard composition, unified `try`/`catch` error handling, and clean cancellation/timeout orchestration.

### 13. React `useState`

- **File path:** `apps/web/src/features/incidents/incident-ai-panel.tsx`
- **Relevant hooks:** `useState` in `IncidentAiPanel` and `AnalysisCard`
- **Implementation:** Local component state controls transient UI interactions without polluting TanStack Query server state: `showFocusInput` & `focusQuestion` (optional prompt focus field), `showHistory` (collapsing older AI runs), `editingNotes` & `notesDraft` (inline note editing), and `deleteTargetId` (controlling the `AlertDialog` delete confirmation).
- **Assessor explanation:** `useState` manages ephemeral UI interaction state locally inside the component while TanStack Query owns remote server data.

### 14. MongoDB CRUD Operations

- **File paths:** `apps/server/src/ai/ai-analysis-repository.ts`, `apps/server/src/ai/ai-analysis-service.ts`, `apps/server/src/ai/ai-analysis-routes.ts`
- **Operations:**
  - **Create:** `create()` via `Model.create(...)` on `POST /api/v1/incidents/:incidentId/ai-analyses`
  - **Read:** `listByIncident()` & `findById()` via `Model.find(...)` / `Model.findOne(...)` on `GET /api/v1/incidents/:incidentId/ai-analyses`
  - **Update:** `update()` via `Model.findOneAndUpdate(..., { $set }, { runValidators: true })` on `PATCH /api/v1/incidents/:incidentId/ai-analyses/:analysisId`
  - **Delete:** `remove()` via `Model.deleteOne(...)` on `DELETE /api/v1/incidents/:incidentId/ai-analyses/:analysisId`
- **Assessor explanation:** Every MongoDB query filters by both `ownerId` and `incidentId` after validating PostgreSQL ownership and checking ObjectId format, ensuring complete tenant isolation.

### 15. MongoDB Schema Modelling

- **File path:** `apps/server/src/ai/ai-analysis-model.ts`
- **Relevant symbols:** `IncidentAiAnalysisSchema`, `getIncidentAiAnalysisModel`
- **Implementation:** Models AI analyses as rich nested documents (`analysis` subdocument + `contextSnapshot` subdocument) with `timestamps: true`, `enum` constraints (`LOW`/`MEDIUM`/`HIGH`), array length validators, UUID regex checks on relational foreign references (`ownerId`, `incidentId`, `monitorId`), compound index `{ ownerId: 1, incidentId: 1, createdAt: -1 }`, and `strict: 'throw'` so unmodeled sensitive fields (headers, credentials, raw bodies) are rejected at the schema boundary.
- **Assessor explanation:** PostgreSQL stores structured relational telemetry while MongoDB stores evolving, nested AI analysis documents — demonstrating polyglot persistence where each database handles the shape it fits best.

### 16. Relational Schema Design with Primary Keys and Foreign Keys

- **File paths:** `apps/server/src/db/schema.ts`, `apps/server/drizzle/0000`–`0007`
- **Implementation:** Core RAIN entities reside in PostgreSQL with UUID primary keys and cascading foreign keys: `auth.users(id)` ← `profiles(id)` ← `monitors(owner_id)` ← `monitor_headers(monitor_id)` / `monitor_checks(monitor_id)` / `incidents(monitor_id, owner_id)` ← `incident_events(incident_id)`. Integrity is enforced with `CHECK` constraints, append-only triggers on `incident_events`, and a partial unique index `incidents_one_active_per_monitor_uq` preventing duplicate open incidents.
- **Assessor explanation:** Relational integrity guarantees that deleting a monitor cleanly cascades to checks, incidents, and notifications, while constraints prevent invalid state transitions at the database level.

### 17. SQL JOINs (PostgreSQL)

- **File paths:** `apps/server/src/incidents/incident-repository.ts`, `apps/server/src/analytics/analytics-repository.ts`
- **Relevant methods:** `findAnalysisContext` (`incident-repository.ts`), `list` / `findById` (`incident-repository.ts`), `checkTotals` / `topIncidentMonitors` (`analytics-repository.ts`)
- **Implementation:** `findAnalysisContext(ownerId, incidentId)` executes a multi-table SQL query joining `incidents` (`INNER JOIN monitors`) and `monitor_checks` twice (`LEFT JOIN monitor_checks tc` on `trigger_check_id`, `LEFT JOIN monitor_checks rc` on `resolved_by_check_id`), followed by an owner-scoped `monitor_checks INNER JOIN monitors` query for the last 15 checks and aggregate 24h failure/latency statistics — never selecting `monitor_headers` or encrypted request bodies.
- **Assessor explanation:** SQL JOINs assemble normalized relational data from `incidents`, `monitors`, and `monitor_checks` in a single owner-scoped round trip before sanitization and LLM analysis.
