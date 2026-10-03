# Security model and operating limits

This is a deployed security foundation with explicit boundaries. Operate it with monitoring, backups, a restore procedure and product-specific identity requirements. Supabase Free has finite quotas and can pause after inactivity; it provides no production availability SLA or automatic database backups.

## Credentials and identity

Access JWTs use HS256 with explicit issuer/audience/type/expiry and random session IDs. Their lifetime defaults to 15 minutes and never exceeds the absolute session deadline. Every protected request reads current user/role, session or API-key state from PostgreSQL. Disabled accounts, logout, revocations and role changes take effect immediately. Sessions last seven days by default and cap at 20 active sessions; another login evicts the oldest with an audit event.

Refresh tokens are random opaque values hashed with SHA-256 at rest, rotate once, and are bound to the winning PostgreSQL compare-and-set. Reuse revokes the whole session. Mutation and success audit commit together. Serialize refresh in every browser context; a lost successful refresh response may require a new login. Never blindly retry refresh or uncertain writes.

Passwords require 15–128 characters, at most 256 UTF-8 bytes, and no control characters. A random 16-byte salt and independent secret pepper protect Argon2id v19 verifiers using 19 MiB memory, two iterations and one lane. The pinned MIT-licensed WASM engine is embedded, bounded and cached; allocations are wiped. Missing/malformed accounts perform dummy password work. Password-pepper replacement requires a planned reset/migration; JWT secret rotation invalidates current JWTs.

No default production credentials or admin exist. Registration grants member only; roles cannot be assigned through HTTP input. Email verification, recovery/password reset, MFA, breached-password checks and CAPTCHA are not implemented. An email field is an account identifier, not evidence of verified email ownership. Add these modules before use cases that rely on verified identity.

Browsers retain access/refresh tokens in memory, send Bearer headers and omit cookies. Durable sessions need a separately designed trusted BFF/identity provider with its own cookie and CSRF policy. API keys are shown once, hashed at rest, scoped, expire within 90 days and cap at 20 per user. Keys belong in trusted servers; CORS cannot keep a browser-embedded key secret. Native Supabase Auth JWTs do not authenticate this custom REST contract.

## HTTP and data boundaries

Strict Zod schemas reject extra fields, duplicate/unknown list parameters, invalid UUIDs/dates, markup and control characters. Output strings remain plain text; encode them in frontend text contexts. Prepared SQL binds values and source allowlists select identifiers/sort columns. Resource reads/writes enforce owners; admin access is limited to user directory/audit lists. Composite foreign keys enforce task/project ownership even under races.

Application tables enable RLS and revoke PUBLIC/anon/authenticated privileges. No anonymous Data API table access or arbitrary SQL execution RPC exists. The Edge Function's trusted database connection and Storage credential stay server-only. `verify_jwt=false` bypasses only Supabase's native JWT gate; application middleware still verifies custom sessions on protected routes. The separate maintenance function verifies an independent random secret before touching state.

The API requires HTTPS in production, permits only exact configured browser origins (including explicit HTTP loopback frontend origins), validates preflight methods/headers, applies nosniff/frame-denial/referrer/permissions/CSP/HSTS headers and returns correlated errors without stack traces or secrets. No credential cookies are used. JSON is capped at 64 KiB and uploads at 5 MiB by default; the reader enforces actual streamed bytes, rejects compressed bodies and cancels overflow. The platform may reject requests before the app, producing a platform-specific error outside the envelope.

Atomic PostgreSQL counters limit traffic per fixed minute: 120 API requests per ingress IP/user and 10 auth attempts per IP/account. Rightmost proxy-hop extraction is conservative and can group NAT/proxy users; a missing IP uses a shared bucket. These limits protect application work, not invocation quotas or availability against all attacks. Monitor quota usage and adjust registration, abuse controls and data/storage quotas for your product.

## Private files and audit

Static PNG/JPEG/WebP uploads receive signature, structure, checksum/dimension, filename, extension and size checks. APNG, animated WebP, SVG, HTML, path traversal, trailing payloads and unsupported content are rejected. Downloads require ownership/scope and use attachment disposition, nosniff and private/no-store caching. Validation is not antivirus or complete image decoding; use scanning/re-encoding before adding public media delivery.

The Storage bucket is private and has no anonymous user policies. SQL metadata controls access. Upload compensation confirms uncertain commits before deleting bytes. Tombstones hide pending deletions and the secret-protected Cron routine reconciles failures and orphan objects after a 24-hour grace period. Keep Cron healthy; delayed cleanup can consume storage quota.

Audit events include actor/action/resource, request ID, HMAC IP pseudonym and minimal non-secret metadata. Database mutations requiring audit fail atomically if audit cannot commit. Admin audit responses exclude IP pseudonyms; request logs include method/route/status/duration, not bodies, tokens, emails, raw IPs, URLs or query strings. Supabase platform logs have their own retention/access policy. Export necessary audit records before bounded retention cleanup.

Keep `.env.local` and `.secrets/` private and out of Git. Supabase runtime credentials belong in Supabase Secrets; deployment credentials belong in operator login or encrypted GitHub environment secrets. Do not put secrets in PDFs, public framework variables, logs or client code. Test restore procedures and keep encrypted exports because Free projects lack automatic backups.

References: [Supabase function security](https://supabase.com/docs/guides/functions/auth), [Secrets](https://supabase.com/docs/guides/functions/secrets), [Limits](https://supabase.com/docs/guides/functions/limits), [Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
