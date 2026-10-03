import { openApiDocument } from '../openapi';

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function apiReference() {
  const paths = openApiDocument.paths as Record<
    string,
    Record<
      string,
      {
        summary?: string;
        description?: string;
        requestBody?: unknown;
        responses?: unknown;
        parameters?: unknown;
        security?: readonly unknown[];
      }
    >
  >;
  const operations = Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([m]) => ['get', 'post', 'patch', 'delete'].includes(m))
      .map(([method, op]) => ({ path, method, op })),
  );
  const items = operations
    .map(
      ({ path, method, op }) =>
        `<details><summary><strong>${escape(method.toUpperCase())}</strong> <code>${escape(path)}</code> — ${escape(op.summary ?? '')}</summary><p>${escape(op.description ?? '')}</p><p>Authentication: ${escape(op.security?.length ? JSON.stringify(op.security) : 'Public')}</p>${op.parameters ? `<h3>Parameters</h3><pre>${escape(JSON.stringify(op.parameters, null, 2))}</pre>` : ''}${op.requestBody ? `<h3>Request</h3><pre>${escape(JSON.stringify(op.requestBody, null, 2))}</pre>` : ''}<h3>Responses</h3><pre>${escape(JSON.stringify(op.responses, null, 2))}</pre></details>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frontend Foundation API • Reference</title><link rel="stylesheet" href="./docs.css"></head><body><main><header><span class="badge">API v1</span><h1>Frontend Foundation API</h1><p>Small, predictable endpoints for learning and building real integrations.</p><a href="./openapi.json">Download OpenAPI 3.1</a></header><section><h2>Start here</h2><ol><li>Register with <code>POST /api/v1/auth/register</code> or log in.</li><li>Send <code>Authorization: Bearer &lt;accessToken&gt;</code> on protected requests.</li><li>Read <code>data</code> on success and <code>error.code</code> on failure.</li><li>For lists use <code>?page=1&amp;limit=20&amp;order=desc</code>. Follow <code>meta.hasNext</code>.</li><li>Refresh once with the latest refresh token. A reused token revokes the session.</li></ol><p>Tokens stay in memory in a browser. API keys belong in trusted servers. File content is a private binary download; other endpoints use JSON.</p><h3>Response pattern</h3><pre>{ "success": true, "data": { ... }, "requestId": "..." }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "..." }, "requestId": "..." }</pre></section><section><h2>Endpoints (${operations.length})</h2>${items}</section><section><h2>Schemas</h2><pre>${escape(JSON.stringify(openApiDocument.components.schemas, null, 2))}</pre></section></main></body></html>`;
}
export const referenceCss = `:root{color-scheme:dark;font:16px/1.6 system-ui,sans-serif;background:#101827;color:#dee6f3}body{margin:0}main{max-width:1000px;margin:auto;padding:3rem 1.5rem}header,section{margin-bottom:2.5rem}h1{font-size:2.5rem;line-height:1.2}h2{font-size:1.5rem}a{color:#69d5bc}code,pre{font-family:ui-monospace,monospace}pre{background:#0b1220;padding:1rem;overflow:auto;border-radius:.5rem;font-size:.85rem}details{border:1px solid #314057;border-radius:.5rem;margin:.75rem 0;padding:1rem}summary{cursor:pointer;overflow-wrap:anywhere}summary strong{display:inline-block;min-width:5rem;color:#69d5bc}p{color:#b6c5dd}.badge{background:#254544;color:#90e3c9;padding:.2rem .6rem;border-radius:1rem}`;
