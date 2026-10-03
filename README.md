# Frontend Foundation API

A modular, hosted Supabase Edge Functions API for frontend developers learning real integration: consistent JSON, strict validation, private files, authentication, access controls, and complete request examples. TypeScript + Hono + Zod, with prepared PostgreSQL queries and no application server to maintain. Run your frontend locally and call the live HTTPS API directly.

## Connect your local frontend to the live API

The live API base URL is **https://fvhpmujmbavwdpjoyyal.supabase.co/functions/v1/backend**. Use the complete URL, including `/functions/v1/backend`. Your frontend stays on your machine, for example at `http://localhost:5173` (Vite), `http://localhost:3000` (Next.js), or `http://localhost:5500` (a static development server).

In the **frontend project's** `.env.local`, set the variable for your framework to that public base URL:

```dotenv
# Vite: paste the deployed HTTPS base URL after =
VITE_API_BASE_URL=https://fvhpmujmbavwdpjoyyal.supabase.co/functions/v1/backend
# Next.js: use this variable instead of the Vite variable
NEXT_PUBLIC_API_BASE_URL=
```

Restart the frontend development server after changing environment variables. These values are bundled into browser code and contain **only the public API URL**. Never add `JWT_SECRET`, `PASSWORD_PEPPER`, `IP_HASH_SECRET`, Supabase tokens, or an API key to a public frontend variable.

```ts
// Copy examples/frontend.ts into your frontend source directory.
import { LearningApi } from './frontend';

// Vite
const api = new LearningApi(import.meta.env.VITE_API_BASE_URL);
// Next.js client component: use this instead
// const api = new LearningApi(process.env.NEXT_PUBLIC_API_BASE_URL!);

await api.register({ email, name, password });
const project = await api.createProject({ name: 'My live API project' });
const page = await api.projects({ page: 1, limit: 10 });
```

The deployed API must allow your exact local origin in `ALLOWED_ORIGINS`. The production configuration supports HTTP loopback frontend origins while the API itself remains HTTPS. `localhost` and `127.0.0.1`, and different ports, are separate origins. See [the frontend guide](docs/frontend.md) for configuration, CORS troubleshooting, authentication, and complete integration examples.

## Run the backend locally for development

Use Node.js 22.12 or newer and npm. No Supabase account is needed for local development.

```sh
npm ci
npm run setup:local
npm run db:migrate
npm run db:seed
npm run dev
```

Open [the API reference](http://localhost:8787/docs), [OpenAPI JSON](http://localhost:8787/openapi.json), or [health](http://localhost:8787/health). The seed command generates a password for `learner@local.test` and `admin@local.test`, prints it once, and inserts example projects/tasks. It always targets local PostgreSQL. Rerunning it rotates demo passwords and revokes their sessions. Set `SEED_PASSWORD` through your shell environment to choose a local password of 15–128 characters.

`setup:local` creates a gitignored `.env.local` with four independent cryptographically random secrets and restrictive file permissions. It preserves existing secrets. Never commit this file; production secrets belong in Supabase.

## Browser starter

Run `npm run demo` and open `http://localhost:5500`. The local page calls the live API, lets you register/sign in and create/list projects, and keeps credentials only in memory. Its server exposes only allowlisted public documentation assets. Use `examples/frontend.ts` for the complete typed client with refresh and uploads.

## First integration

Register or log in, then send the returned access token as a Bearer header. Passwords below 15 characters are rejected. Live accounts and data are stored in production PostgreSQL; local PGlite accounts/data are a separate development database. They are real state, not mocked responses.

```sh
# Enter the live HTTPS base URL printed by PGlite.
# For isolated backend development, enter http://localhost:8787 instead.
read -r API_BASE_URL

curl -i "$API_BASE_URL/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  --data '{"email":"you@example.com","name":"API Learner","password":"choose-your-own-long-passphrase"}'

curl "$API_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

curl -i "$API_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"My first integration","description":"Learn fetch and CRUD"}'

curl "$API_BASE_URL/api/v1/tasks?page=1&limit=10&status=todo&sort=title&order=asc&q=learn" \
  -H "Authorization: Bearer $ACCESS_TOKEN"

curl -i "$API_BASE_URL/api/v1/files" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: image/png' -H 'X-File-Name: avatar.png' \
  --data-binary @avatar.png
```

Set `ACCESS_TOKEN` to the value in the authentication response. The example passphrase above illustrates a request; it is not a seeded account or built-in credential. See [frontend guide](docs/frontend.md) for complete fetch, refresh, errors, CRUD, filtering and uploads, and [the typed browser client](examples/frontend.ts) for a reusable implementation with refresh serialization.

## Predictable responses

```json
{
  "success": true,
  "data": [{ "id": "...", "name": "My project", "status": "active" }],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1,
    "hasNext": false,
    "hasPrevious": false
  },
  "requestId": "..."
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid",
    "details": [
      { "field": "name", "message": "Use plain text without markup or control characters" }
    ]
  },
  "requestId": "..."
}
```

List data is an array. Single-resource data is an object. Successful creates return `201`; project/task/file creates include `Location`. reads, updates and deletes return `200`. Deleted resources return `{id, deleted:true}`. Authentication and API-key revocation return `{revoked:true}`. Files use a binary response only for `/files/:id/content`; errors there still use JSON. OpenAPI JSON, API reference HTML and CORS preflight are also documented non-envelope responses.

| Status    | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| 400       | Invalid JSON, ambiguous credentials, or unexpected body              |
| 401       | Missing, expired, revoked or invalid authentication                  |
| 403       | Role, scope, registration or origin policy denies access             |
| 404       | Endpoint/resource missing, including resources owned by another user |
| 409       | Duplicate email, related resource race, or active API-key cap        |
| 413 / 415 | Body too large / unsupported content type or encoding                |
| 422       | Schema, identifier, date or query validation failed                  |
| 429       | Rate limit; follow `Retry-After`                                     |
| 500 / 503 | Internal error / temporary dependency or configuration failure       |

Pagination defaults to `page=1&limit=20&sort=createdAt&order=desc`, with `limit <= 100` and `page <= 10000`. Search `q` is a literal substring (SQL wildcard characters are escaped). Sort/filter fields vary by endpoint and are enumerated in OpenAPI; unknown or repeated list parameters are rejected. For very large tables, add cursor pagination and full-text search to the relevant service.

## Endpoint map

All application endpoints use `/api/v1`. Collection paths have no trailing slash.

| Module         | Operations                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`, `/auth/sessions`; `DELETE /auth/sessions/:id` |
| Projects       | `GET/POST /projects`; `GET/PATCH/DELETE /projects/:id`                                                                               |
| Tasks          | `GET/POST /tasks`; `GET/PATCH/DELETE /tasks/:id`                                                                                     |
| Files          | `GET/POST /files`; `GET/DELETE /files/:id`; `GET /files/:id/content`                                                                 |
| Users          | `GET/PATCH /users/me`; admin `GET /users`                                                                                            |
| API keys       | `GET/POST /api-keys`; `DELETE /api-keys/:id`                                                                                         |
| Auditing       | Admin `GET /audit-logs`                                                                                                              |
| System         | `GET /health`, `/ready`, `/api/v1`, `/docs`, `/docs.css`, `/openapi.json`                                                            |

Projects, tasks and files belong to their creator. Admin roles grant user-directory/audit access and do not override resource ownership. Task project references require the same owner, enforced in both validation and a composite database foreign key. Deleting a project clears its tasks' references inside a transaction. PATCH changes only explicitly supplied fields.

## Authentication and security

Access JWTs expire after 15 minutes by default and are linked to a PostgreSQL session. Every protected request verifies the signature, issuer, audience and expiry and reads the current user/session/key from PostgreSQL. Logout, account disabling, role changes and API-key revocation therefore take effect without waiting for JWT expiry. Sessions expire after seven days; a new login evicts the oldest if 20 are active. Refresh tokens are opaque, hashed at rest, single-use and rotated atomically; reuse revokes that session. Serialize refresh requests across browser contexts or use a BFF. A lost refresh response can require signing in again.

There are no authentication cookies or ambient cookie credentials. Browser examples retain tokens only in memory. For persistent browser sessions, integrate a trusted BFF or identity provider with an appropriate cookie and CSRF design. Keep tokens out of URLs, logs and persistent browser storage. API keys are for trusted servers/BFFs, with explicit resource/file read/write scopes, 90-day maximum lifetime and 20 active keys per user. A secret embedded in a browser bundle is public, so do not give one to a frontend app.

Exact CORS allowlists, secure headers, per-IP/per-account/per-user rate limits, actual streamed-byte limits (JSON 64 KiB, uploads 5 MiB), schema allowlists, bound SQL values, plain-text input checks and transactionally recorded audit events are included. No secrets or credentials are hardcoded. Password storage uses a secret pepper and a random salt; deployment uses a Supabase Edge Function runtime for password work. Review [security details and platform limits](docs/security.md) before production rollout.

Private image upload accepts static PNG/JPEG/WebP with structural validation, bounded dimensions, safe filenames and forced attachment downloads. HTML, SVG and animated images are rejected. This is not a malware scanner or full image decoder; add a scanning/re-encoding service if your product needs public image delivery. Storage/PostgreSQL failure recovery uses deletion tombstones and orphan reconciliation with a 24-hour grace period.

## Project structure

```text
src/index.ts                  Hono HTTP app and routes
src/core/                     Config, errors, envelopes, crypto, audit, pagination, repositories
src/middleware/               CORS, headers, size/rate limits, authentication and RBAC
src/modules/auth/             Passwords, tokens, sessions and rotation
src/modules/{projects,tasks}/  Routes → controllers → services → reusable repository
src/modules/files/            Image boundary, private Storage lifecycle, PostgreSQL metadata
src/modules/{users,api-keys,audit}/  Profile, scoped keys and admin audit access
src/openapi.ts                Runtime OpenAPI source
supabase/migrations/          Versioned PostgreSQL schema
tests/                        Unit and PostgreSQL integration tests
docs/                         Exported OpenAPI, frontend, architecture and security guides
scripts/                      Local secrets, seed, admin bootstrap and deployment checks
```

See [architecture and extension guide](docs/architecture.md) for adding a service. Rate limits use atomic PostgreSQL counters. The immutable discovery response needs no external cache. Authorization always reads current database state.

## Validate changes

```sh
npm run check          # TypeScript, PostgreSQL tests, OpenAPI validity/export, bundle dry run
npm run test:watch
npm run format:check
npm audit
npm run openapi:export # After editing src/openapi.ts
```

Tests use real PostgreSQL through PGlite with the production application migration, ephemeral secrets and a private in-memory object store. CI validates types, behavior, OpenAPI, bundles and production dependency vulnerabilities. The local server uses persisted PGlite and filesystem storage; use the optional Docker-based Supabase local stack for Edge runtime parity.

## Deploy on Supabase Free

The backend uses a dedicated Supabase Free project, Edge Functions, PostgreSQL and a private Storage bucket. No paid add-on or purchased domain is required. Free quotas are finite: 500 MB database, 1 GB file storage, 5 GB egress and 500,000 Edge Function invocations per month; inactive Free projects may pause after a week. Custom authentication in this project does not use Supabase Auth's MAU quota. Review [current pricing](https://supabase.com/pricing) and [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

```sh
npm ci
npm run supabase:login
npx supabase link --project-ref YOUR_PROJECT_REF
npm run setup:production-secrets
npm run deploy
```

For your own installation, first create a Free project in the dashboard and update `projectRef` and `baseUrl` in `docs/configuration.json`, plus the server URL in `src/openapi.ts`. Set exact frontend origins in that configuration and regenerate OpenAPI. `setup:production-secrets` creates four distinct server secrets in an ignored, permission-restricted `.secrets/supabase-production.env`, preserving existing values, and sends them to Supabase Secrets. Store a secure backup; do not casually replace the password pepper. Supabase supplies its own database URL and Storage service credential inside deployed functions.

`npm run deploy` checks types/tests/OpenAPI/build, validates the linked configuration and required secret names, applies tracked PostgreSQL migrations, and deploys both `backend` and `maintenance` with the API bundler. Docker is unnecessary for deployment. `verify_jwt=false` is intentional: public register/login endpoints and custom sessions/API keys are authenticated by the application's middleware, with live database checks on every protected request. Native Supabase Auth JWTs and publishable keys do not authenticate this REST API. Never expose the database URL or service-role key to a browser.

Configure cleanup after initial deployment:

```sh
npm run maintenance:setup
```

This provisions a 15-minute Supabase Cron job using pg_cron/pg_net and stores the maintenance URL/token in encrypted Vault. The dedicated maintenance function requires its independent server secret. Cleanup deletes expired sessions/keys/audit records and rate counters in bounded batches, retries file deletion tombstones and scans unreferenced objects with a 24-hour grace period. `npm run maintenance` runs the same routine only on the local development database. Do not seed production.

Create an ordinary user through registration, then promote the intended administrator through the operator CLI:

```sh
npm run admin:promote -- you@example.com --production
```

The promotion checks for an active account and commits the role change and operator audit event together. No default production admin or public role-change endpoint exists. Inspect Edge Function logs in the Supabase dashboard; logs omit bodies, credentials, query strings and raw IP addresses. Free projects have no automatic database backups: define secure exports and a tested restore process before relying on this service for irreplaceable data.

GitHub `main` is the source branch. Validation runs automatically. The manual **Deploy production API** workflow uses GitHub encrypted `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD` secrets. Application secrets stay in Supabase. See [GitHub deployment](docs/github-deployment.md).

The local `/docs` page is a polished browser reference. On the free Supabase domain, the platform rewrites HTML to plain text; use the PDF, checked-in `docs/index.html` or OpenAPI JSON for hosted integrations. This platform behavior is documented by [Supabase](https://supabase.com/docs/guides/functions/limits). No custom domain is needed to call APIs.

## Configuration

Non-secret defaults are documented in `docs/configuration.json`: mode, exact origins, JWT issuer/audience, token/session lifetimes, registration policy, audit retention and request limits. Supabase Secrets may override those values. Only the full API URL belongs in `VITE_` / `NEXT_PUBLIC_` frontend variables. Server secrets are `JWT_SECRET`, `PASSWORD_PEPPER`, `IP_HASH_SECRET` and `MAINTENANCE_SECRET`; Supabase injects `SUPABASE_URL`, `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The browser needs neither a Supabase SDK nor a service key.
