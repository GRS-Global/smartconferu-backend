---
name: smartconferu-api
description: How to work on the Smartconferu backend API (NestJS 12 + TypeScript + PostgreSQL + Drizzle) in this repo — layout, the controller/service/repository pattern, permissions, transactions, emails, notifications, live events, AI, jobs, paging, tests and checks. Load before planning, reviewing or changing any code here.
---

# Smartconferu API

The backend of Smartconferu, a conference-management platform (Call for Papers, submissions,
screening, peer review, decisions, emails, admin console, AI helpers). The API **owns
everything**: its own auth, database and emails. It replaces the Supabase backend that the React
frontend currently uses; the frontend switches over module by module later.

- **Repo:** GRS-Global/smartconferu-backend, branch `main` (local: `D:\Projects\smartconferu-backend`).
- **Frontend (reference for behaviour):** GRS-Global/smartconferu-frontend, today still in the
  `author-journey` repo (`D:\Projects\author-journey`). When porting a feature, read the frontend
  code and `supabase/migrations/*.sql` there: behaviour, emails and permissions must match
  what the app does now, unless the user decides otherwise.
- **Plan doc:** https://claude.ai/artifact/7hyNDAr3zdmcDVi7mHJ4Vj (the user's own working plan,
  not for the client). Read its "Progress" and "Resume here" before starting new work, and update
  them when a piece is finished.
- **README.md** is the detailed reference: one section per module. Keep it current when you add
  or change behaviour.

## Working rules

- **Confirm the approach with the user before changing code.** Propose, then wait for a go-ahead.
  The user decides product and architecture.
- Commit or push only when asked. Branch first if on `main`.
- Do not touch the frontend repo unless asked.
- Hosting is undecided (the client rejected AWS on 2026-11-12). Don't add provider-specific code.
  The API needs only a container host, PostgreSQL 16 + pgvector, S3-compatible storage and Resend.
- Windows machine: Python is not on PATH. For scripts, use Node or the editing tools. Avoid long
  `node -e` one-liners, because shell escaping mangles `$`, backticks and regexes.

## Stack

NestJS 12 (ESM: **imports end in `.js`**), strict TypeScript, Node 22.18+, Drizzle ORM +
postgres.js, PostgreSQL 16 + pgvector, Vitest (unit) + Supertest (e2e against PGlite via
pglite-socket, pool max 1), oxlint (type-aware), Prettier, Swagger at `/docs`, REST under
`/api/v1`. Emails go through Resend (console transport locally). AI uses `@anthropic-ai/sdk`
(Claude) and Voyage embeddings over HTTP. PDFs are read with pdfjs-dist (legacy build).

## Layout

```
src/
  config/env.ts      every setting, validated (zod); add new ones here AND in .env.example
  core/              shared building blocks; never imports from modules/
    auth/ rbac/ database/ email/ errors/ audit/ http/ health/
    notifications/ realtime/ storage/ plan/ validation/
  modules/           features: auth users conferences submissions reviews communications
                     notifications ai jobs admin
drizzle/             generated SQL migrations
test/                *.e2e-spec.ts + support/ (test-app, fake-oidc, fake-ai, sse-client)
```

Each module has `*.controller.ts` (URLs, Swagger, reads params/user; no rules or SQL),
`*.service.ts` (rules, permissions, transactions, emails), `*.repository.ts` (Drizzle queries;
no decisions), `dto/*.ts` (class-validator request/response shapes), `*.module.ts`. Everything
arrives through constructor injection. Unit tests sit next to the code as `*.spec.ts`.

## Patterns to follow

**Routes.** Every route is private unless marked `@Public()`. `@CurrentUser() user: AuthUser`.
`@ConfRoles('chair', …)` on routes with `:conferenceId`. `@SuperAdminOnly()` for the admin console
(needs a two-step-verified session). Add Swagger decorators (`@ApiTags`, `@ApiOperation`,
response types) because the frontend switch is done against this contract.

**Permissions.** Every rule is a plain function in `core/rbac/access-rules.ts`, unit tested in
`access-rules.spec.ts`. In the service, load a snapshot first:
`access.requireConference(user, conferenceId, tx)` or `access.requireSubmission(user, submissionId, tx)`.
Both answer 404 when the user may not see the thing, so ids don't leak. Then check the rule and
`throw AppException.forbidden('who may do this')`. "Chair" means chair or track chair. A super
admin in a two-step-verified session counts as a chair everywhere. The user's own rows (profile,
notifications, own AI usage) are filtered in the query by `user_id = me`.

**Errors.** Throw `AppException` (`notFound`, `forbidden`, `businessRule`, `conflict`,
`validation`, or `new AppException(status, ErrorCode.X, message)`). Codes are listed in
`core/errors/app.exception.ts`; add a new one there when needed. Messages are written for end users.
The response shape is `{ statusCode, code, message, details?, requestId }`.

**One change, one transaction.** The row changes, the notifications, the queued emails and the
audit entry all go in a single `database.transaction(async (tx) => …)`, with `tx` passed down:

```ts
await this.database.transaction(async (tx) => {
  await this.repo.update(tx, …);
  await this.notifications.notify(tx, userIds, { kind, title, body?, link?, conferenceId?, submissionId? });
  await this.emailQueue.enqueue(tx, 'eventName', emails);           // sent later by the worker
  await this.audit.record({ action, actorId, entityType, entityId, client, data }, tx);
});
```

Work that must happen only after commit goes in `database.afterCommit(tx, () => …)`. Live
notifications use this: `NotificationsService` publishes to `LiveEventsService`, so a rolled-back
change pushes nothing.

**Emails.** Templates are keyed by event. Conferences can override them in the email-templates
module, and the samples live in `core/email/email-samples.ts`. Recipients and render live in
`core/email`. Per-module email builders such as `review-emails.service.ts` and
`submission-emails.service.ts` assemble the `OutgoingEmail`s. Every sent email shows up in
Email Logs (`email_log`).

**Paging.** Lists take `?limit&cursor` and return `{ data, nextCursor }` (`core/http/pagination.ts`).
For timestamp-ordered lists, use the `keyset(at, id, cursor, 'newest-first' | 'oldest-first')`
helper. It compares at millisecond precision, which matters because Postgres keeps
microseconds, JS Dates don't, and rows from one transaction share a timestamp.

**Live events (SSE).** `POST /me/events/ticket` returns a 60 s ticket (audience
`smartconferu-events`). `GET /me/events?ticket=…` streams `ready`, `notification` and `expired`
events. It supports Last-Event-ID catch-up, a 25 s heartbeat, a 1 h maximum and 5 streams per user.
Between instances it uses Postgres LISTEN/NOTIFY on `sc_live_events` (`REALTIME_FANOUT`). New
kinds of live event go through `LiveEventsService`.

**Background jobs.** `modules/jobs/jobs.runner.ts` runs in process every `JOBS_INTERVAL_MS`. Each
job takes a `pg_try_advisory_xact_lock` with its own number (7_201_00x), so only one instance runs it.
Current jobs: review reminders, cleanup of expired tokens and sessions, and the paper-AI backlog.

**AI.** Everything goes through `modules/ai/ai-core.service.ts`. It records usage and cost in
`ai_usage` and maps provider failures to `AI_FAILED` with a user-facing message. Models:
`claude-haiku-5-5` (form fill, screening, digest, chat, review enhance), `claude-sonnet-5-5`
(topics), `claude-opus-5-5` (website reader, with the server-side fallback beta). Structured
output uses `output_config.format` json_schema. Embeddings use voyage-3.5 (1024 dims) with
pgvector cosine distance. Load the `claude-api` skill before changing Claude calls. Website
fetching is SSRF-safe (`website-reader.ts`); keep it that way.

**Files.** `core/storage/file-storage.ts`: the abstract `FileStorage` has one driver for now, `LocalFileStorage` (`FILE_STORAGE_DIR`).
The S3-compatible driver waits for the hosting choice.

## Database changes

1. Edit the tables in `src/core/database/schema/*.ts` (identity, conferences, submissions,
   reviews, communications, ai, audit).
2. Run `npm run db:generate -- --name=<what-changed>` and review the SQL in `drizzle/`. Never hand-write
   a migration first.
3. Run `npm run test:e2e`; the tests build their database from the migrations.

Deploys run `node dist/migrate.js` before starting. CI fails if the schema changed without a
migration.

## Tests

- Every behaviour gets an e2e test in `test/<module>.e2e-spec.ts` that calls the endpoints the
  way the web app will. Pure logic gets a unit `*.spec.ts`.
- `createTestApp(overrides)` from `test/support/test-app.ts` gives `app`, `db` (PGlite), `outbox()`,
  `sendQueuedEmails()`, `runJobs(now?)`, `tokenFor(userId, mfa?)`, `createUser()`, `reset()`
  (call it in `afterEach`) and `close()`. Defaults: jobs off, AI keys empty, auto-ingest off,
  fan-out off.
- AI is tested against the `FakeAi` server (`test/support/fake-ai.ts`, with `textPdf()`) and
  OAuth against `fake-oidc.ts`. SSE uses `SseClient`. PGlite can't relay LISTEN/NOTIFY, so
  cross-instance fan-out is unit tested with a fake client.
- Dates in job tests are relative to now, because dedupe compares real `created_at` values.

## Before saying it's done

```bash
npm run typecheck && npm run lint && npm run format:check
npm test && npm run test:e2e
npm run db:check && npm run build
```

All must pass. The known lint warnings (no-base-to-string in email-render and screening-record,
plus a few in screening-rules and auto-initial-check) are old, so don't add new ones. Common lint
traps are `no-misused-spread` on DTO class instances (use `Object.assign`), `no-new-array`
(use `Array.from`) and `no-thenable` in specs. Then update the README section, the plan doc's
Progress/"Resume here", and report the test counts.

## Still to do (as of 2026-11-16)

1. S3-compatible storage driver, once the host is chosen.
2. Admin actions the app doesn't have yet (disable a user, resend a failed email), if wanted.
3. Infrastructure for the chosen host, then data migration from Supabase and the frontend
   switch, module by module, against the Swagger contract.
