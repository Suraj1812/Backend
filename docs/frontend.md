# Frontend integration guide

Run your frontend locally and point it at the **live Supabase HTTPS API**. Use `https://fvhpmujmbavwdpjoyyal.supabase.co/functions/v1/backend`, including the function path. You do not need to run the backend locally to learn frontend integration against the hosted service. Use `http://localhost:8787` only when you deliberately run the local development server for backend development.

## Configure a local frontend

In your frontend project's `.env.local`, paste the deployed API base URL after `=`. Set the variable for your framework:

```dotenv
# Vite: public HTTPS API base URL only
VITE_API_BASE_URL=https://fvhpmujmbavwdpjoyyal.supabase.co/functions/v1/backend
# Next.js: use this name instead
NEXT_PUBLIC_API_BASE_URL=
```

Then restart your frontend server. The base URL is public and contains no `/api/v1` suffix, credentials, query string, or fragment. Never put an API key, JWT signing secret, password pepper, IP hashing secret, or Supabase service-role or management token into a `VITE_` or `NEXT_PUBLIC_` variable. Both frameworks expose these prefixed values in browser JavaScript; published builds must be rebuilt when that URL changes. Browser users receive their own access/refresh tokens by signing in. [Vite environment variables](https://vite.dev/guide/env-and-mode), [Next.js environment variables](https://nextjs.org/docs/pages/guides/environment-variables).

```ts
import { LearningApi } from './frontend'; // Copy examples/frontend.ts into your app.

// Vite
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
const api = new LearningApi(apiBaseUrl);

// Next.js client component: use this initialization instead.
// const api = new LearningApi(process.env.NEXT_PUBLIC_API_BASE_URL!);
```

The live API's `ALLOWED_ORIGINS` must list your exact frontend origin. Common local origins are `http://localhost:5173`, `http://localhost:3000`, and `http://localhost:5500`, plus their `127.0.0.1` counterparts. Ports and hostnames are significant. Only configured loopback origins may use HTTP; the hosted API uses HTTPS and published frontend origins require HTTPS. Opening an HTML file with `file://` produces an unsupported origin: serve it through your local development server.

If the browser reports a CORS failure, verify `location.origin` against the deployed allowlist, confirm you restarted after changing the public base URL, and inspect the Network panel's preflight request. Keep `credentials: 'omit'`; the API uses authorization headers rather than cookies. A successful curl request alone does not verify a browser origin policy.

The local reference runs at `http://localhost:8787/docs`; the PDF covers the live API. Supabase rewrites hosted HTML to plain text on its free domain. The machine-readable schema is at `<API base URL>/openapi.json` and can be imported into Postman or an OpenAPI client generator.

## One response shape

JSON successes contain `success`, `data`, and `requestId`. A list also contains `meta`. Handle HTTP errors with `response.ok`; `fetch` only rejects on network/transport failures.

```json
{
  "success": true,
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0,
    "hasNext": false,
    "hasPrevious": false
  },
  "requestId": "example-request-id"
}
```

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some fields are invalid",
    "details": [{ "field": "name", "message": "Required" }]
  },
  "requestId": "example-request-id"
}
```

Keep `requestId` when reporting problems. Do not show raw stack traces or request credentials. `/docs`, `/openapi.json`, and a successful binary file download are the documented envelope exceptions.

## Sign in, then fetch

`POST /api/v1/auth/register` accepts `{email,name,password}` and immediately signs in the new member. Registration name is limited to 80 characters. `POST /api/v1/auth/login` accepts `{email,password}`. Passwords require 15–128 characters, at most 256 UTF-8 bytes, and no control characters. Registration may be disabled by the deployment. JSON objects reject unrecognized fields; do not send an entire form state containing UI-only properties. Live accounts are separate from local the local development server seed accounts.

```ts
const baseUrl = import.meta.env.VITE_API_BASE_URL; // Live HTTPS base URL.
const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'omit',
  body: JSON.stringify({ email, password }),
});
const login = await loginResponse.json();
if (!loginResponse.ok) throw new Error(login.error.message);

// Keep these in memory; never log them or put them in a URL.
let { accessToken, refreshToken } = login.data;
const response = await fetch(`${baseUrl}/api/v1/projects?page=1&limit=20`, {
  headers: { Authorization: `Bearer ${accessToken}` },
  credentials: 'omit',
});
const result = await response.json();
if (!response.ok) throw new Error(result.error.message);
console.log(result.data, result.meta); // Safe: these are resource data.
```

Use the complete typed client in [`examples/frontend.ts`](../examples/frontend.ts). It provides CRUD methods, validation errors, abort signals, a timeout, and a single shared refresh operation when several requests receive 401 together. It keeps credentials in memory and makes no requests when imported.

```ts
import { LearningApi, ApiClientError } from './frontend';

const api = new LearningApi(import.meta.env.VITE_API_BASE_URL);
try {
  await api.login(email, password);
  const project = await api.createProject({ name: 'My first project' });
  const task = await api.createTask({ title: 'Show the project list', projectId: project.id });
  await api.updateTask(task.id, { status: 'done' });
  const page = await api.tasks({ projectId: project.id, page: 1, limit: 10 });
  renderTasks(page.items); // Your framework/UI function.
} catch (error) {
  if (error instanceof ApiClientError && error.status === 422) showFieldErrors(error.details);
  else showMessage(error instanceof Error ? error.message : 'Request failed');
}
```

Render strings with React text interpolation, Vue interpolation, or DOM `textContent`. Never use `innerHTML`, `dangerouslySetInnerHTML`, or `v-html` for user input. Validation rejects markup, but the frontend must still encode output correctly.

## Refresh and logout

Access JWTs expire after the `expiresIn` seconds returned at login (default 900). `POST /api/v1/auth/refresh` takes `{refreshToken}` and returns a new access token **and a replacement refresh token**. The old refresh token can no longer be used; replay revokes the whole session. Refresh tokens do not extend the absolute `sessionExpiresAt` deadline. Serialize refresh operations, save the replacement immediately, and retry an unauthorized request once. A rejected refresh requires signing in again. Automatic retry of timeouts, 429, or 5xx writes is deliberately omitted: the original write may already have completed.

`POST /api/v1/auth/logout` requires the current Bearer token and revokes its session. Clear both local tokens. `GET /api/v1/auth/sessions` lists active sessions; `DELETE /api/v1/auth/sessions/{id}` revokes one. The cap is 20 active sessions; another login evicts the oldest. Because access tokens are checked against the database, revocation also blocks existing JWTs. A browser reload clears the example client's credentials; sign in again. Avoid persisting tokens in `localStorage`, where any script running in your origin can read them. A production application that needs durable login should use a separately designed server session/BFF or identity-provider integration; it must include its own cookie/CSRF policy.

## Lists, filters and partial updates

Resource list endpoints return a `data` array and `meta`. The typed example client converts that to `{items,meta}` for convenient UI use. `page` is 1–10,000 (default 1), `limit` is 1–100 (default 20), and `order` is `asc` or `desc` (default `desc`). `q` is optional trimmed plain text of 1–100 characters. Omit an empty search. Query names must be supported and supplied once; unknown or duplicate parameters return 422. Use `URLSearchParams` for encoding. Session/key management lists use their documented `{sessions}` / `{items}` data objects and are not paginated resource lists.

| Resource           | Filters                                                                            | Sort fields                                  | Search                |
| ------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------- | --------------------- |
| Projects           | `status=active\|archived`                                                          | `createdAt`, `updatedAt`, `name`             | Name and description  |
| Tasks              | `status=todo\|in_progress\|done`, `priority=low\|medium\|high`, `projectId=<uuid>` | `createdAt`, `updatedAt`, `title`, `dueDate` | Title and description |
| Files              | `contentType=image/png\|image/jpeg\|image/webp`                                    | `createdAt`, `filename`, `size`              | Filename              |
| Users (admin)      | `role=member\|admin`                                                               | `createdAt`, `name`, `email`                 | Name and email        |
| Audit logs (admin) | `action=<text>`, `actorId=<uuid>`                                                  | `createdAt`                                  | No `q` parameter      |

All default to `sort=createdAt`. SQL wildcards `%` and `_` in `q` are literal characters. A page past the end returns an empty array; it is not an error. Offset pagination is easy to learn, but rows can move between pages during concurrent updates; use a cursor-based module for future high-volume feeds.

Create with `POST`, read with `GET`, change supplied fields with `PATCH`, and delete with `DELETE /{resource}/{id}`. A patch must contain at least one supported field. Task `projectId` and `dueDate` accept `null` to clear them; omitting a field preserves it. `dueDate` uses a real calendar date in `YYYY-MM-DD` form. Projects and tasks default their description to `""`; task status defaults to `todo`, priority to `medium`, and project status to `active`. Deleting a project keeps its tasks and sets their `projectId` to `null`. Delete successes use `{id,deleted:true}` instead of a 204 response so callers can always parse JSON.

Ownership is enforced on every operation. Other users' resource IDs return 404. Administrator directory/audit access does not grant access to another user's projects, tasks, or files.

## File upload and download

Upload raw file bytes using `POST /api/v1/files`, `Content-Type`, and `X-File-Name`. Do not use `FormData` for this endpoint. Static PNG, JPEG and WebP are accepted; APNG, animated WebP, SVG, HTML and executable files are rejected. The default upload cap is 5 MiB and the image limit is 40 million pixels with 16,384 pixels per side. Filenames start with an ASCII letter/digit, have a maximum of 120 ASCII letters/digits/spaces/dots/underscores/hyphens, and must carry an extension that matches the MIME type. Paths are rejected and spaces become underscores.

```ts
const file = fileInput.files?.[0];
if (file) {
  const metadata = await api.upload(file);
  const blob = await api.download(metadata.id);
  const objectUrl = URL.createObjectURL(blob);
  imageElement.src = objectUrl;
  // Revoke when the component unmounts or the image is replaced.
  imageElement.onload = () => URL.revokeObjectURL(objectUrl);
}
```

Metadata includes `downloadUrl`, a protected relative URL. An `<img src="...">` cannot add a Bearer header. Fetch the content with authorization and create a Blob URL, as shown above. Successful downloads contain binary content with attachment disposition; failed downloads use the normal JSON error envelope. Files are private and downloads must not be cached in public/CDN caches.

## Errors worth handling

| HTTP status | Frontend action                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| 400         | Fix malformed JSON or required body/header.                                                                           |
| 401         | Refresh once, then sign in if refresh fails.                                                                          |
| 403         | Explain insufficient permission or disabled registration; do not retry.                                               |
| 404         | Show missing resource; an unowned resource has the same result.                                                       |
| 409         | Resolve duplicate email or key-limit conflict.                                                                        |
| 413         | Reduce request/upload size.                                                                                           |
| 415         | Send the documented `Content-Type`.                                                                                   |
| 422         | Show `error.details` field messages.                                                                                  |
| 429         | Respect `Retry-After`; avoid retrying all tabs at once.                                                               |
| 500/503     | Show a retryable service message and retain `requestId`. Check whether a write already succeeded before repeating it. |

For typeahead, debounce requests and cancel outdated reads using `AbortController`. Represent loading, empty, success, and error states separately. Disable repeated form submission while a write is pending. API keys are for trusted backend integrations; no browser variable, minification, or CORS policy can keep an embedded key secret.
