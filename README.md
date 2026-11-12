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
api/
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
│  │  ├─ email/            sending email (console in development, Resend in production)
│  │  ├─ errors/           AppException + the filter that shapes every error response
│  │  ├─ audit/            AuditService → audit_log table
│  │  ├─ http/             client IP / user agent, rate limiter
│  │  ├─ health/           /health (process up), /health/ready (database reachable)
│  │  ├─ notifications/    in-app notifications (the bell), written with each change
│  │  └─ validation/       shared input validators
│  ├─ modules/             features, one folder each
│  │  ├─ auth/             register, sign-in, sessions, two-step, providers, email change
│  │  ├─ users/            /me: my profile, Terms acceptance, my conferences
│  │  ├─ conferences/      conferences, Call for Papers, team and invitations
│  │  └─ admin/            super-admin endpoints
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
- One deliberate change: authors need a **published** CFP to submit (the old 0021 migration
  dropped that check by mistake); a chair may submit on an author's behalf at any time.

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

## Database

- **Source of truth:** `src/core/database/schema/*.ts`, grouped by area: `identity.ts` (users,
  sessions, tokens, two-step, profiles), `conferences.ts`, `submissions.ts`, `reviews.ts`,
  `communications.ts`, `ai.ts`, `audit.ts`.
- **Migrations** in `drizzle/` are generated from the schema, never written by hand first:
  1. Edit the tables in `src/core/database/schema/`.
  2. `npm run db:generate -- --name=<what-changed>` and review the SQL it writes.
  3. `npm run test:e2e` (tests build their database from the migrations).
  4. On deploy, `node dist/migrate.js` applies pending migrations before the new version starts.

## Running locally

Requires Node 22.18+. No Docker needed.

```bash
cd api
npm install
cp .env.example .env
npm run secrets:generate     # paste the output into .env
npm run db:serve             # terminal 1: local Postgres on :54329 (keep it open)
npm run start:dev            # terminal 2: http://localhost:3000, API docs at /docs
```

- **Demo account:** `dev@example.test` / `smartconferu-dev` (a super admin).
- **Emails** (links, codes) are printed in the `start:dev` terminal while `EMAIL_TRANSPORT=log`.
- **Local data** lives in `.pglite-dev/`. `npm run db:serve -- --fresh` starts over.
- **pgAdmin / psql:** host `127.0.0.1`, port `54329`, user `postgres`, no password, database
  `postgres`, tables under Schemas → public. (Port 5432 is a different, unrelated Postgres if
  one is installed.)

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
| 503 `NOT_READY` on every request       | The database isn't running: start `npm run db:serve` (inside `api/`)  |
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

CI (`.github/workflows/api-ci.yml`) runs all of these on every pull request that touches `api/`,
and fails if the schema changed without a migration.
