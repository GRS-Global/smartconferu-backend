# Smartconferu API

The Smartconferu backend: **NestJS + TypeScript over PostgreSQL**.

The API owns everything: accounts and sign-in, every business rule and permission, files and
emails. The database only stores data and keeps it consistent (constraints, foreign keys,
indexes); there is no business logic in it. The web app talks to this API only.

```
Browser / web app
      │  JSON over HTTP · access token in "Authorization: Bearer" · refresh token in a cookie
      ▼
┌──────────────────────────── NestJS API ────────────────────────────┐
│ setup-app.ts  security headers, CORS, /api/v1 prefix, input validation│
│ guards        rate limit → signed in? → conference role?             │
│ modules/      controller → service → repository   (one per feature)  │
│ core/         shared building blocks (auth, database, email, errors…)│
└─────────────────────────────────────────────────────────────────────┘
      │  SQL through Drizzle ORM
      ▼
PostgreSQL  (locally: PGlite on :54329 · production: AWS RDS)
```

## Tech stack

| Concern         | Choice                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| Framework       | NestJS 12 (Express), TypeScript strict, ES modules                         |
| Database        | PostgreSQL + pgvector, Drizzle ORM, drizzle-kit migrations                 |
| Validation      | class-validator DTOs (requests), Zod (environment)                         |
| Auth            | Own implementation: argon2id passwords, Ed25519 JWTs (jose), TOTP, OIDC    |
| Logs            | pino (JSON in production, one line per request with a `requestId`)         |
| API docs        | Swagger / OpenAPI at `/docs`                                               |
| Tests           | Vitest; API tests run against a real Postgres (PGlite) with all migrations |
| Lint and format | oxlint, Prettier                                                           |
| Hosting (plan)  | AWS: ECS Fargate, RDS, S3, built from the `Dockerfile`                     |

## Project structure

```
smartconferu-backend/
├─ src/
│  ├─ main.ts              starts the server
│  ├─ app.module.ts        root module: imports every module, global guards, error filter
│  ├─ setup-app.ts         helmet, cookies, CORS, /api/v1 prefix, validation, Swagger
│  ├─ migrate.ts           applies pending migrations (deploy step)
│  ├─ config/env.ts        every setting from .env, validated at startup
│  ├─ core/                shared building blocks; never depends on modules/
│  │  ├─ auth/             access tokens, passwords, crypto helpers, the sign-in guard
│  │  ├─ rbac/             permissions: AccessService, @ConfRoles, @SuperAdminOnly
│  │  ├─ database/         connection, transactions; schema/ = every table
│  │  ├─ email/            templates, the email queue and its worker, Resend / console
│  │  ├─ errors/           AppException + the filter that shapes every error response
│  │  ├─ audit/            AuditService → audit_log table
│  │  ├─ http/             client IP / user agent, rate limiter
│  │  ├─ health/           /health (process up), /health/ready (database reachable)
│  │  ├─ notifications/    in-app notifications (the bell), written with each change
│  │  ├─ realtime/         LiveEventsService: pushes new notifications to open SSE streams
│  │  ├─ storage/          FileStorage: uploaded files (local folder; S3-compatible later)
│  │  ├─ plan/             PlanService: which paid features a conference has (all free now)
│  │  └─ validation/       shared input validators
│  ├─ modules/             features, one folder each
│  │  ├─ auth/             register, sign-in, sessions, two-step, providers, email change
│  │  ├─ users/            /me: my profile, Terms acceptance, my conferences
│  │  ├─ conferences/      conferences, Call for Papers, team and invitations
│  │  ├─ submissions/      papers: submit, lists, paper page, edit, withdraw, screening
│  │  ├─ reviews/          assignments, review form, chair reviews, sending decisions, reminders
│  │  ├─ communications/   email templates, Email Logs, the chair's own emails
│  │  ├─ notifications/    the bell (/me/notifications) and live events (/me/events, SSE)
│  │  ├─ ai/               Claude helpers, paper RAG (pgvector) and chat, fill from website
│  │  ├─ jobs/             background jobs: review reminders, cleanup, AI backlog
│  │  └─ admin/            super-admin console: stats, users, activity, review health
│  └─ types/express.d.ts   adds request.user
├─ drizzle/                SQL migrations generated from the schema (0000, 0001, …)
├─ test/                   API (e2e) tests + helpers (test app, fake Google/Microsoft/ORCID)
├─ scripts/                db:serve (local Postgres), secrets:generate
├─ .env.example            every setting, documented (copy to .env)
└─ Dockerfile              production image
```

### Inside a module

Every feature has the same four kinds of file (example: `modules/users/`):

| File              | Job                                                           | Never                       |
| ----------------- | ------------------------------------------------------------- | --------------------------- |
| `*.controller.ts` | URLs (`@Get`, `@Post`…), reads body/params/user, Swagger docs | business rules, SQL         |
| `*.service.ts`    | Business rules, permission checks, transactions, emails       | HTTP details (req, cookies) |
| `*.repository.ts` | Database queries (Drizzle)                                    | decisions                   |
| `dto/*.ts`        | Request shapes with validation; response shapes               | logic                       |
| `*.module.ts`     | Registers the pieces with NestJS                              |                             |

Classes receive what they need through their constructor (dependency injection); nothing is
created with `new`.

### The life of a request

`PATCH /api/v1/me`:

1. **setup-app.ts:** security headers, CORS check, cookies parsed.
2. **Global guards** (`app.module.ts`), in order:
   1. `AppThrottlerGuard`: too many requests → 429.
   2. `JwtAuthGuard`: checks the `Authorization: Bearer` token and sets `request.user`
      (`{ id, sessionId, mfa }`). Skipped for routes marked `@Public()`.
   3. `ConferenceRoleGuard`: only for routes with `@ConfRoles(...)`.
3. **ValidationPipe:** the body becomes a DTO; invalid or unknown fields → 400 with a list per field.
4. **Controller → service → repository**, then the JSON response.
5. Anything thrown is turned into the standard error shape by `AllExceptionsFilter`.

## Conventions

- **Every route is private** unless marked `@Public()`. `@CurrentUser()` gives the signed-in user.
- **Permissions** are decided in one place, `core/rbac` (see [Permissions](#permissions)). Use
  `@ConfRoles('chair', …)` on routes with `:conferenceId`, or load a snapshot with `AccessService`
  and check a rule from `access-rules.ts` in the service. Super-admin powers (`@SuperAdminOnly()`)
  need a session that passed two-step verification.
- **Errors:** throw `AppException` with a stable `code` (listed in `core/errors/app.exception.ts`).
  Every error response is `{ statusCode, code, message, details?, requestId }`. Unexpected errors
  become a generic 500 (logged with the `requestId`, details never sent to the client); an
  unreachable database is a 503 `NOT_READY`.
- **Several writes that belong together** run in `database.transaction(async (tx) => …)`; pass
  `tx` to repository methods.
- **Sensitive actions** (sign-ins, password and email changes, two-step on/off…) are recorded with
  `AuditService.record(...)`.
- **Settings** are read with `ConfigService` and declared in `config/env.ts`. A new setting goes
  in both `env.ts` and `.env.example`.

## Permissions

Every rule of who may do what lives in `core/rbac/access-rules.ts`, one plain function per rule
(`canEditCfp`, `canViewSubmission`, `canWithdraw`, `canWriteReview`…). They replace the old
Supabase RLS policies and the checks inside its SQL functions; each says which one it replaces, and
`access-rules.spec.ts` tests every case.

1. In a service, load a snapshot of the user's standing:
   - `access.requireConference(user, conferenceId, tx)` → `ConferenceAccess` (roles, team, author,
     creator, super admin), or
   - `access.requireSubmission(user, submissionId, tx)` → `SubmissionAccess` (the conference
     snapshot plus submitter, linked author, claimed, the user's review assignment, outcome).

   Both answer **404** when the user may not see the thing at all, so ids don't leak.

2. Check the rule and throw `AppException.forbidden('…')` with a message saying who may.

- A **chair** is a chair or track chair. A **super admin** in a two-step-verified session counts as a
  chair everywhere.
- Rows that are simply the user's own (profile, notifications, own AI usage) are filtered in the
  query (`where user_id = me`), not by a rule.
- Submitting needs a **published** CFP, for everyone (the old 0021 migration dropped that check
  by mistake). A chair may submit on an author's behalf after the deadline, never to a draft or
  closed CFP.

## Accounts and sign-in (modules/auth)

| File                         | Responsibility                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `auth.controller.ts`         | register, confirm email, sign in (password / code), second step, refresh, sign out, passwords |
| `account.controller.ts`      | signed-in account: change email, devices, two-step on/off, recovery codes, merge accounts     |
| `oauth/`                     | Google, Microsoft, ORCID (OpenID Connect + PKCE)                                              |
| `auth.service.ts`            | core sign-in; every method ends in `completeSignIn()`                                         |
| `sessions.service.ts`        | refresh tokens: rotation, reuse detection, revoking                                           |
| `mfa.service.ts`             | authenticator-app codes, recovery codes, lockout                                              |
| `one-time-tokens.service.ts` | emailed links and 6-digit codes (hashed, single use, expiring)                                |
| `auth-cookies.ts`            | the httpOnly cookies and the allowed-origin check                                             |

How it works:

- **Passwords:** argon2id, minimum 8 characters. Old bcrypt hashes (from Supabase) are upgraded
  at the next sign-in. Repeated wrong passwords lock the account for a while.
- **Tokens:** sign-in returns a 15-minute **access token** (Ed25519 JWT with `sub` = user,
  `sid` = session, `mfa` when the second step was passed; public keys at
  `/.well-known/jwks.json`) and sets a 30-day **refresh token** as an httpOnly cookie scoped to
  `/api/v1/auth`. `POST /auth/refresh` swaps it for a new pair; replaying an old refresh token
  revokes the whole session (theft detection).
- **Session** = one signed-in device (`sessions` table). Users can list and sign out devices.
- **Emailed secrets** (confirm email, reset password, sign-in code, change email) are stored only
  as hashes and work once.
- **Two-step verification:** authenticator app (TOTP) + 10 recovery codes. When on, sign-in
  answers `{ mfaRequired: true }` and sets a 5-minute `sc_mfa` cookie; `POST /auth/mfa/verify`
  with the code finishes it. A code can't be reused; 5 wrong codes lock it for 15 minutes.
- **Google, Microsoft, ORCID:** the app links to `/auth/oauth/<provider>/start?terms=<version>`;
  the API redirects back to `<APP_URL>/auth/callback?status=signed_in|mfa_required|linked` (or
  `error=…`) with the refresh cookie set. A provider account joins an existing account only when
  the provider verified the email. ORCID accounts start without an email; the user adds one
  (`/auth/email/change`) or connects to the account that owns it (`/auth/account/merge`).
- **Terms of Service:** register requires `termsVersion`; the API stores the version and time on
  the account (`users.terms_accepted_at`). `POST /me/terms` records a later acceptance.

## Conferences, CFP and team (modules/conferences)

| Who             | Can                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------- |
| Anyone          | `GET /public/cfps` (Smart CFP directory), `GET /public/conferences/{slug}` (submission link)  |
| Signed in       | `POST /conferences` (request one; becomes its chair), `GET /conferences` (mine + my requests) |
| Chairs          | edit details and settings, archive / restore, ask for deletion, invite and remove the team    |
| Chairs, CFP mgr | edit, publish and close the CFP                                                               |
| Invited person  | `GET /invitations`, accept or decline                                                         |
| Super admin     | approve or decline requests, decide deletion requests, undelete (`/admin/…`)                  |

- **Lifecycle:** `pending_approval` → (super admin) `active` or `rejected`; `active` ⇄ `archived`;
  `archived` → deletion request → (super admin) `deleted` → (super admin) back to `archived`.
- **CFP:** `draft` → `published` (only once the conference is active; submissions open) →
  `closed`. Outside the team a CFP is only ever seen as published or closed.
- **Who sees a conference:** its creator, its team (not removed), verified super admins, and
  authors once it is live or archived. Anyone else gets 404, not 403, so ids don't leak.
- **Team:** inviting links the account with that email now, or when it signs up. Accepting turns
  papers queued for the invitation into review requests; declining hands back papers already
  given. Removing a reviewer withdraws their open assignments and keeps submitted reviews. The
  last chair can't be removed.
- These rules are the old Supabase RLS policies and SQL functions, now in `core/rbac/access-rules.ts`
  and the module's services.

## Submissions and screening (modules/submissions)

| Who               | Can                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Signed in         | `POST /conferences/{id}/submissions` (CFP published, before the deadline), `GET /submissions` |
| Authors           | the paper page, edit title/abstract/keywords until a decision, withdraw                       |
| Submitter         | replace the author list (`PUT /submissions/{id}/authors`) until a decision                    |
| Chairs            | every paper, submit on an author's behalf (after the deadline too), screening, decisions      |
| Assigned reviewer | the paper page (no authors under double-blind review)                                         |

- **Paper ids:** numbered per conference (`ICX-1`, `ICX-2` …) from `conferences.next_paper_no`.
- **Authors:** each email once, at least one corresponding. An author whose email has an account
  is linked at once, anyone else when they sign up; a linked author has "claimed" the paper. A
  chair who submitted for an author can edit the paper only until an author claims it.
- **Views:** `GET /submissions/{id}` answers with `view` = `chair`, `author` or `reviewer`. Authors
  see only what they were told: a recorded but unsent decision reads as `no_decision`. `can`
  says what the signed-in user may do now (edit, withdraw, decide…).
- **Files:** `POST /submissions/{id}/files` (multipart `file`, optional `supplementary=true`)
  stores the next paper version (v1, v2 …; PDF or Word, checked by content, up to
  `MAX_UPLOAD_MB`). The first one moves the paper from `upload_pending` to `no_decision`; later
  ones tell the chairs there is a new version to check. `GET /submissions/{id}/files/{fileId}`
  downloads it. Files go through `FileStorage` (`core/storage`): a local folder now, an
  S3-compatible driver once the hosting is chosen.
- **Screening:** `GET/PUT /conferences/{id}/screening-settings` (steps, criteria, AI mode).
  `PUT /submissions/{id}/screening/{version}` saves the chair's record of that version (checked:
  the version must exist, allowed decisions, page counts, percentages, dates, file paths, and the
  plagiarism step only after a passed initial check); a decision the chair sets is marked
  `chairSet`. `POST …/notify` emails the authors the correction, revision or rejection.
  `POST /submissions/{id}/decision` records a decision or a stage (e.g. "Plagiarism clear").
- **Not yet:** sending decisions to authors (the decisions module).

### AI mode (automatic initial check)

The initial check doesn't read papers on the server. The app checks each PDF in the browser when it is picked
(`src/chair-plagiarism/autoCheck.js`: the rules read pages, editable text, English and layout;
Claude settles what the rules aren't sure of) and sends the result with the upload: the
multipart field `autoCheck` (JSON), or `PUT /submissions/{id}/files/{fileId}/auto-check` when the
check finishes later.

1. **Kept:** the result is checked (`screening/auto-check.ts`: known fields only, valid values;
   a `decision` sent by the client is ignored) and stored on the version
   (`submission_files.auto_check`). Under double-blind review "author names missing" is dropped.
2. **Decided, with AI mode on** (`autoInitialCheck` in the screening settings; a paid feature
   later, free for every conference now: `PlanService`), by `AutoInitialCheckService` in the same
   transaction: a certain result that meets every requirement → Passed; one that fails → Revision
   with the reasons and the correction deadline, emailed to the authors (or left for the chair,
   per `autoInitialFail`). The stored result's `decision` says what was done.
3. **Left for the chair:** AI mode off (the chair checks every paper by hand), an unsure result,
   a failed check (a Word file, an unreadable PDF), or no result at all.

A decision already made is never touched, only the newest version is decided, and turning AI mode
on decides the papers already waiting. The result comes from the browser, so the chair stays in
charge: every automatic decision is tagged `autoSet` and can be changed.

## Emails (core/email)

Two ways to send:

- `EmailService.send` sends at once: account emails the user waits for (codes, links).
- `EmailQueueService.enqueue(tx, event, emails)` takes one email or many and queues them in the
  transaction of the change they report, so an email exists exactly when the change does. Each
  email is either a template (`{ template: 'submissionReceived', values, to, conference }`) or a
  written message (`{ key, label, subject, body, to }`).

How it works:

- **Templates:** the conference's own copy (Conference Settings › Email Templates; turned off =
  not sent) wins over the platform default (`email_templates`, seeded from the app's email catalog
  in migration 0004). Account emails always use the platform default.
- **Queue:** `email_log` is both the queue and the Email Logs chairs read: `queued` → `sending` →
  `sent`, or back to `queued` for a retry (after 1, 5, 30, 120 minutes) until `EMAIL_MAX_ATTEMPTS`,
  then `failed` with the reason.
- **Worker:** `EmailWorker` sends the queue from the API process every `EMAIL_QUEUE_INTERVAL_MS`,
  in batches (Resend's batch API, 100 per request). Several API instances can run it together
  (`for update skip locked`). Tests turn it off and call `t.sendQueuedEmails()`.
- **Recipients:** `EmailRecipientsService` gives the chairs, the super admins, app links, and the
  one-time "Welcome to Smartconferu" for people added who have no account yet.

## Peer review and decisions (modules/reviews)

- **Assigning** (`POST /submissions/{id}/assignments`, chairs): committee members by member id.
  Active reviewers get the paper now ("Papers assigned to you" + bell); invited ones get a waiting
  row that becomes an assignment when they accept the committee invitation. Authors of the paper
  can't be given it. Someone who declined or was taken off gets it again.
- **Reviewers** answer each paper (`POST /assignments/{id}/respond`) and save their form
  (`PUT /assignments/{id}/review`, `submit: false` = draft). The first send marks the assignment
  done and emails thanks, "New review" and, once all are in, "Ready for decision". A sent review can
  be corrected until the paper has a decision; a draft save never takes it back.
- **Chairs** see every assignment (`GET /submissions/{id}/reviews`), correct a sent review
  (`PUT /reviews/{id}`, the reviewer is told), write their own (`PUT …/chair-review`), share a
  review with the authors (`PATCH /reviews/{id}/shared`) and take a paper back
  (`DELETE /assignments/{id}`: a sent review stays on record but no longer counts).
- **Decisions:** recorded with `POST /submissions/{id}/decision` (authors see nothing yet), sent
  with `POST …/decision/notify`: the authors' email and bell (shared reviews, anonymised), the final
  decision to the reviewers, "Decision changed" when it differs from what was sent before.
  `PUT /conferences/{id}/decision-types` replaces the list; a type a paper uses can't be removed.
- **Reminders:** the jobs runner sends "N days left" and "Last day" per the conference's review
  timeline (`settings.reviewTimeline`), once per reviewer per day (`reminders/`).

## Notifications and live events (core/notifications, core/realtime, modules/notifications)

- `NotificationsService.notify(tx, userIds, …)` saves bell notifications in the change's
  transaction. Once it commits (`DatabaseService.afterCommit`), `LiveEventsService` pushes them.
- `GET /me/notifications` (paged) and `POST /me/notifications/read` read the bell.
- **Live events (Server-Sent Events):** the app gets a one-minute ticket
  (`POST /me/events/ticket`, with its access token) and opens
  `new EventSource(API + '/me/events?ticket=' + ticket)`. Events: `ready` ({ unread }), then
  `notification` ({ notification, unread }) with an id. After a drop, or `expired` (streams end
  after an hour, or when a sixth tab opens for the same user), get a new ticket and reopen with
  `&lastEventId=<last id>`: missed notifications come first. A heartbeat comment every 25 s keeps
  proxies from closing the stream.
- **Several API instances:** with `REALTIME_FANOUT` (default on) the ids also go out on Postgres
  `NOTIFY sc_live_events`, and every instance pushes to its own streams, so no sticky sessions or
  Redis are needed. PGlite doesn't relay NOTIFY over its socket, so tests turn it off and the
  fan-out is unit tested.
- Paging uses `keyset()` (core/http/pagination.ts): times are compared to the millisecond, so
  rows saved in one transaction are never skipped at a page edge.

## Email templates and Email Logs (modules/communications)

- `GET/PUT/DELETE /conferences/{id}/email-templates[/{key}]`: the conference's copy of each email
  (on/off, subject, body; DELETE puts it back to the default) and its custom emails
  (`custom:<id>` keys). Account emails stay the platform's.
- `GET /conferences/{id}/email-log`: Email Logs, newest first, paged (`?limit&cursor`), filtered by
  status, paper or template.
- `POST /conferences/{id}/emails`: the chair's own email to author groups and/or reviewers; each
  person once, with their name and paper filled in (at most 2000 people).
- Super admins: `/admin/email-templates` (change a default: copies nobody changed follow it;
  `…/test` sends one with example values) and `/admin/email-log`.

## AI (modules/ai)

Claude through the official SDK (`ANTHROPIC_API_KEY`), Voyage AI embeddings for paper chat
(`VOYAGE_API_KEY`). Without keys the routes answer 503 `NOT_READY`; a provider failure is 502
`AI_FAILED`, a declined request 422. Every call writes an `ai_usage` row with its cost.

- `POST /ai/paper-metadata` (Smart Fill), `/ai/screening` (the initial check's AI part, from the
  app's digest of the PDF), `/ai/topics`, `/ai/review-enhance` (three wordings of the reviewer's
  own review), `/ai/conference-from-website` (reads public http(s) sites only; private addresses
  are refused, also through DNS and redirects).
- **Paper RAG:** each new PDF version is prepared in the background (`AI_AUTO_INGEST`): pdf.js
  text → section chunks → embeddings in `paper_chunks` (pgvector) → a Haiku digest in
  `paper_digests`. The jobs runner prepares any paper missed. `POST /submissions/{id}/ai/chat`
  (chairs and assigned reviewers) answers from the digest and the 5 closest chunks.
- Tests point `ANTHROPIC_BASE_URL` / `VOYAGE_BASE_URL` at a fake server (`test/support/fake-ai.ts`).

## Background jobs (modules/jobs)

`JobsRunner` runs every `JOBS_INTERVAL_MS` (and 30 s after start): review reminders, deleting
sign-in links and sessions expired over a week ago (each in a transaction under an advisory
lock, so only one instance runs it), and the AI backlog. Tests turn it off and call
`t.runJobs(now)`.

## Database

- **Source of truth:** `src/core/database/schema/*.ts`, grouped by area: `identity.ts` (users,
  sessions, tokens, two-step, profiles), `conferences.ts`, `submissions.ts`, `reviews.ts`,
  `communications.ts`, `ai.ts`, `audit.ts`.
- **Migrations** in `drizzle/` are generated from the schema, never written by hand first:
  1. Edit the tables in `src/core/database/schema/`.
  2. `npm run db:generate -- --name=<what-changed>` and review the SQL it writes.
  3. `npm run test:e2e` (tests build their database from the migrations).
  4. On deploy, `node dist/migrate.js` applies pending migrations before the new version starts.

### Migration files

| File                        | What it does                                                    |
| --------------------------- | --------------------------------------------------------------- |
| `0000_extensions.sql`       | Turns on `pgvector` (embeddings for the paper AI)               |
| `0001_baseline.sql`         | All 27 tables: the 22 from Supabase plus the new identity/audit |
| `0002_mfa.sql`              | Two-step verification (`user_mfa`, `mfa_recovery_codes`)        |
| `0003_terms_acceptance.sql` | Terms-acceptance columns                                        |
| `0004_email_queue.sql`      | Columns for sending emails through the queue                    |
| `meta/`                     | Drizzle's bookkeeping; never edit by hand                       |

### Compared with Supabase

- **All 22 Supabase tables** (from `supabase/migrations/` in the frontend repo) exist here with
  the same names and columns, so data can be copied across one-to-one.
- **7 tables are new**, because the API does its own sign-in instead of Supabase Auth: `users`,
  `sessions`, `auth_tokens`, `user_identities`, `user_mfa`, `mfa_recovery_codes`, `audit_log`.
- Supabase's SQL functions, triggers and RLS policies are not tables: they became API code
  (permissions in `core/rbac/access-rules.ts`, emails and notifications in the services).
- **Not moved yet:** the data itself and the uploaded files in Supabase Storage. Both move in the
  data-migration step, after hosting is chosen.

**On a real PostgreSQL server** (16+, with the pgvector extension available): set `DATABASE_URL`
to it, then `npm run build` and `npm run db:migrate`. That creates the same tables there.

## Running locally

Step by step, on a fresh Windows machine (macOS/Linux: the same, with `cp` instead of `copy`).
**No PostgreSQL or Docker to install:** `npm run db:serve` runs an embedded PostgreSQL (PGlite)
with pgvector, every migration applied and a demo account.

### 1. Install the tools (once)

| Tool    | Version                               | Where                   |
| ------- | ------------------------------------- | ----------------------- |
| Node.js | **22.18 or newer** (22.x or 24.x LTS) | https://nodejs.org      |
| Git     | any                                   | https://git-scm.com     |
| pgAdmin | optional, to look at the tables       | https://www.pgadmin.org |

Check in a new terminal: `node -v` (must print v22.18.0 or higher) and `git --version`.

### 2. Get the code

```powershell
cd D:\Projects
git clone https://github.com/GRS-Global/smartconferu-backend.git
cd smartconferu-backend
npm install
```

The repository is private: the GitHub account on the machine needs access to GRS-Global.

### 3. Create `.env`

```powershell
copy .env.example .env
npm run secrets:generate
```

`secrets:generate` prints four lines (`JWT_PRIVATE_KEY`, `JWT_KEY_ID`, `TOKEN_HASH_SECRET`,
`MFA_ENCRYPTION_KEY`): paste each over its empty line in `.env`. Then set the local database:

```
DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
```

Everything else can stay as it is: emails are printed in the terminal instead of sent
(`EMAIL_TRANSPORT=log`), sign-in with Google/Microsoft/ORCID and the AI features stay off until
their keys are set (see [Optional settings](#optional-settings)), uploads go to `./storage`.

### 4. Start the database (terminal 1, keep it open)

```powershell
npm run db:serve
```

The first run creates the database in `.pglite-dev/`, applies every migration and adds the demo
account. It prints:

```
Local database ready: DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
Demo account: dev@example.test / smartconferu-dev
```

`npm run db:serve -- --fresh` wipes it and starts over.

### 5. Start the API (terminal 2)

```powershell
cd D:\Projects\smartconferu-backend
npm run start:dev
```

The API answers on http://localhost:3000/api/v1, and the API docs (Swagger) are at
**http://localhost:3000/docs**. It restarts by itself when you change code.

### 6. Check it works

1. Open http://localhost:3000/docs.
2. `POST /auth/sign-in` → **Try it out** → send
   `{ "email": "dev@example.test", "password": "smartconferu-dev" }`.
3. Copy `accessToken` from the response, click **Authorize** at the top, paste it.
4. `GET /me` should return Dev User.

More to try is in [Trying the API from /docs](#trying-the-api-from-docs).

### 7. Run the checks (optional)

```powershell
npm run typecheck
npm run lint
npm test            # unit tests
npm run test:e2e    # API tests (their own in-memory database; step 4 not needed)
npm run build
```

### Good to know

- **Demo account:** `dev@example.test` / `smartconferu-dev` (a super admin).
- **Emails** (links, codes) are printed in the `start:dev` terminal while `EMAIL_TRANSPORT=log`.
- **Local data** lives in `.pglite-dev/`. `npm run db:serve -- --fresh` starts over.
- **Changed `.env`?** Restart `npm run start:dev`.
- **pgAdmin / psql** (while `db:serve` runs): host `127.0.0.1`, port `54329`, user `postgres`, no
  password, database `postgres`, tables under Schemas → public. They are empty apart from the
  demo account and the default email templates. (Port 5432 is a different, unrelated Postgres if
  one is installed.)

### Optional settings

| Feature                            | In `.env`                                                | Note                                                                             |
| ---------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Real emails                        | `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `EMAIL_FROM` | `EMAIL_FROM` must use a domain verified in Resend                                |
| AI features                        | `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`                    | Without them the AI endpoints answer with an error                               |
| Google / Microsoft / ORCID sign-in | `<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET`       | Register `http://localhost:3000/api/v1/auth/oauth/<provider>/callback` with each |
| The web app calling the API        | `APP_URL`, `CORS_ORIGINS`                                | Already set for Vite on `http://localhost:5173`                                  |

### Trying the API from /docs

Sign in, then click **Authorize** and paste the `accessToken` (it lasts 15 minutes;
`POST /auth/refresh` gives a new one, using the cookie). From a link in the console copy the value
after `token=`.

- **Register:** `POST /auth/register` (needs `termsVersion`) → `POST /auth/verify-email` with the
  link's token.
- **Sign in:** `POST /auth/sign-in`, or `POST /auth/sign-in/code` → `POST /auth/sign-in/code/verify`.
- **Passwords:** `POST /auth/password/forgot` → `POST /auth/password/reset`;
  `POST /auth/password/change`.
- **Sessions:** `POST /auth/refresh`, `POST /auth/sign-out`, `GET /auth/sessions`,
  `DELETE /auth/sessions/{id}`.
- **Two-step:** `POST /auth/mfa/totp/setup` → add the `secret` to an authenticator app →
  `POST /auth/mfa/totp/enable`. Next sign-in answers `mfaRequired` → `POST /auth/mfa/verify`.
- **Email change:** `POST /auth/email/change` → `POST /auth/email/change/confirm`.
- **Google / Microsoft / ORCID:** needs the provider's client id and secret in `.env`. Open
  `http://localhost:3000/api/v1/auth/oauth/google/start?terms=2026-10-01` in the address bar (not
  "Try it out"); afterwards `POST /auth/refresh` in /docs gives the access token.

### Troubleshooting

| Symptom                                | Cause and fix                                                         |
| -------------------------------------- | --------------------------------------------------------------------- |
| 503 `NOT_READY` on every request       | The database isn't running: start `npm run db:serve`                  |
| `EADDRINUSE` on 54329 or 3000          | Already running in another terminal: use it, or close it first        |
| 500 `INTERNAL_ERROR`                   | Find the `requestId` in the `start:dev` terminal for the real error   |
| App won't start, "Invalid environment" | A setting in `.env` is missing or wrong; compare with `.env.example`  |
| 403 on refresh / sign-out              | The calling site isn't in `CORS_ORIGINS` (or the API's own `API_URL`) |

## Adding a feature module

1. Tables: add or change them in `src/core/database/schema/`, then `npm run db:generate`.
2. Create `src/modules/<name>/` with a controller, service, repository, `dto/` and module.
3. Add the module to `imports` in `app.module.ts`.
4. Protect routes: private by default; `@ConfRoles(...)` or `AccessService` for permissions.
5. Throw `AppException` for expected problems; record sensitive actions with `AuditService`.
6. Add `test/<name>.e2e-spec.ts` calling the endpoints the way the web app will.

## Checks

```bash
npm run typecheck
npm run lint
npm run format:check
npm test             # unit tests
npm run test:e2e     # API tests against a local Postgres with every migration applied
npm run db:check     # migrations are consistent
npm run build
```

CI (`.github/workflows/ci.yml`) runs all of these on every pull request and every push to `main`,
and fails if the schema changed without a migration.
