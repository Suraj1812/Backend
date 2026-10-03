# Architecture and extension guide

The public API is one Hono application deployed as a Supabase Edge Function. Routing/controllers translate HTTP; services express business rules; repositories use bound PostgreSQL queries. Strict Zod schemas guard create, patch, query and configuration boundaries. Each module owns its routes, service, repository and DTO mapping. Shared modules handle envelopes, errors, logging, validation, authorization, pagination and audit records.

```text
Local frontend → HTTPS Edge Function → validation + authentication + authorization
                                   → service → PostgreSQL transaction + audit
                                   → private Supabase Storage
```

`src/index.ts` mounts the API. `src/runtime/handler.ts` builds server capabilities from Supabase's injected variables and validated public defaults. `supabase/functions/backend/index.ts` is the Deno entry point; `npm run build` bundles the application while pinning the Postgres driver import. The function normalizes Supabase's mount prefix, preserving the same `/api/v1/*` contract locally and remotely. Its separate `maintenance` entry requires a secret and is invoked by Supabase Cron. There are no browser database credentials or arbitrary SQL RPC endpoints.

## State and transactions

PostgreSQL owns users, session state, hashed refresh tokens, API keys, resources, file metadata, audit events and atomic rate counters. Tables enable RLS and revoke native anon/authenticated Data API access. This application uses custom sessions rather than Supabase Auth: the trusted server connection authorizes each request with current user/session/key state and owner-scoped statements. Administrator status never bypasses resource ownership. Do not add browser-native table policies casually; those would be a separate trust boundary.

The small `Database` adapter exposes prepare/bind/first/all/run and transactional batch operations. Identifiers originate only in source-controlled module definitions; values stay bound. A batch executes sequentially in one PostgreSQL transaction. Mutation/audit failure rolls back both. Per-user transaction advisory locks serialize session and API-key cap changes. Refresh rotation uses a row compare-and-set and binds its child token/audit to the winning replacement hash. A replay revokes its session.

Canonical UTC ISO strings remain database TEXT so timestamps return identically from local PostgreSQL and the Edge driver. The services generate timestamps; callers cannot alter IDs, owners, roles or timestamps. JSON scope/audit metadata is stored as TEXT with database JSONB validation. Unique and foreign-key constraints defend invariants after validation. Task `(project_id,owner_id)` references the same-owner project; project deletion clears task references within the same transaction.

## Files, limits and cleanup

Private Storage contains validated image bytes under generated owner/UUID paths; PostgreSQL metadata controls every read/download. Storage and SQL cannot share a transaction. Uploads reconcile uncertain metadata commits before compensation. Deletes first mark a durable tombstone, immediately blocking reads, then remove bytes and metadata with an audit event. Repeated deletion is safe. Storage failures return structured 503 errors.

Every 15 minutes, a secret-protected maintenance function processes at most 100 tombstones, scans 100 objects, and removes at most 1,000 rows per expired session/key/audit/counter batch. A private PostgreSQL setting advances the lexical Storage scan cursor. Unreferenced objects require a 24-hour grace period. Completion is eventual and depends on backlog; monitor failures and scale the cadence/batches as needed. Cron tokens are encrypted in Supabase Vault.

Rate counters use atomic UPSERTs shared across instances. Fixed-minute windows limit API traffic to 120 requests per ingress IP/user and authentication to 10 per IP/account. IP keys are HMAC pseudonyms. The rightmost gateway forwarding hop is used conservatively; missing IP shares one fallback bucket. Proxy/NAT peers may share a limit. The function limiter cannot prevent a request from consuming a platform invocation. Free quotas and inactivity pausing are independent of these limits.

## Local development

`npm run dev` runs the identical HTTP app on Node with persisted PGlite, real PostgreSQL SQL/constraints and private filesystem objects. Tests use isolated PGlite databases and a private in-memory object store. This requires no Docker, card or cloud account. `npm run dev:supabase` is optional Edge runtime parity and requires the Docker-based Supabase local stack. Remote smoke tests validate the actual Deno runtime, Storage and ingress behavior. PGlite serializes queries, so tests alone do not demonstrate cross-server concurrency; advisory-lock and compare-and-set behavior must also be reviewed/tested against hosted PostgreSQL.

## Add a module

1. Define strict, bounded create/patch/list schemas and DTOs. A patch contains at least one mutable field.
2. Add a tracked PostgreSQL migration with ownership constraints, RLS/default-deny privileges and appropriate query indexes.
3. Supply a source-controlled `ResourceDefinition` for simple owned CRUD, or a dedicated repository for specialized transactions/integrations.
4. Keep business invariants in the service. Scope the actual SQL read/write to its owner, even after an earlier check.
5. Mount authentication, role/Bearer and API-key scope gates explicitly. Return `success()` or raise an expected `ApiError`.
6. Commit necessary non-secret audit events with sensitive mutations.
7. Update OpenAPI, frontend examples and the PDF source; export the contract and run project checks.
8. Test ownership, invalid/extra inputs, permission changes, consistency and relevant state transitions.

Offset pagination is intentionally easy to learn. For large/changing datasets add cursor pagination, purpose-built search/indexes and bounded background job APIs within the relevant module. Inject new provider credentials through Supabase Secrets.
