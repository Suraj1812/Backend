/** The same document powers /openapi.json and the local API reference. */
type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const parameter = (name: string) => ({ $ref: `#/components/parameters/${name}` });
const bearer = [{ bearerAuth: [] }];
const resourceAuth = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
const uuid = { type: 'string', format: 'uuid' };
const dateTime = { type: 'string', format: 'date-time' };
const plain = (maxLength: number, minLength = 1): Schema => ({
  type: 'string',
  minLength,
  maxLength,
  pattern: '^[^<>\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$',
  description:
    'Trimmed plain text. Angle brackets and unsafe control characters are rejected. Render as text in the frontend.',
});
const object = (
  properties: Record<string, Schema>,
  required: string[] = Object.keys(properties),
): Schema => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const array = (items: Schema): Schema => ({ type: 'array', items });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });
const patchFields = (fields: Record<string, Schema>) =>
  Object.fromEntries(
    Object.entries(fields).map(([name, schema]) => {
      const field = { ...schema };
      delete field.default;
      return [name, field];
    }),
  );
const envelope = (data: Schema, paginated = false): Schema =>
  object({
    success: { type: 'boolean', const: true },
    data,
    requestId: { type: 'string', description: 'Correlation ID also sent in X-Request-ID.' },
    ...(paginated ? { meta: ref('PaginationMeta') } : {}),
  });
const jsonResponse = (description: string, schema: Schema, example?: unknown) => ({
  description,
  headers: {
    'X-Request-ID': {
      schema: { type: 'string' },
      description: 'Use this ID when reporting a problem.',
    },
  },
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});
const ok = (data: Schema, description = 'Successful request.', example?: unknown) =>
  jsonResponse(
    description,
    envelope(data),
    example ?? { success: true, data: sample(data), requestId },
  );
const created = (data: Schema, description: string, example?: unknown) => {
  const response = ok(data, description, example);
  return {
    ...response,
    headers: {
      ...response.headers,
      Location: {
        schema: { type: 'string' },
        description:
          'Path to the created resource, including the hosted function mount. Resolve against the API origin.',
      },
    },
  };
};
const listOk = (schema: string) =>
  jsonResponse(
    'A page of resources. An empty result is successful.',
    envelope(array(ref(schema)), true),
    {
      success: true,
      data: [sample(ref(schema))],
      requestId,
      meta: { page: 1, limit: 20, total: 1, totalPages: 1, hasNext: false, hasPrevious: false },
    },
  );
const body = (schema: Schema, example?: unknown) => ({
  required: true,
  content: { 'application/json': { schema, ...(example ? { example } : {}) } },
});
const errors = (...statuses: number[]) =>
  Object.fromEntries(
    [...new Set([...statuses, 400, 403, 429, 500, 503])].map((status) => [
      String(status),
      { $ref: `#/components/responses/Error${status}` },
    ]),
  );
const protectedErrors = (...statuses: number[]) => errors(401, 403, ...statuses);
const idParameter = parameter('ResourceId');
const listParameters = (sort: string[], defaultSort = 'createdAt') => [
  parameter('Page'),
  parameter('Limit'),
  parameter('Search'),
  parameter('Order'),
  {
    name: 'sort',
    in: 'query',
    description: 'Allowlisted field; arbitrary SQL column names are rejected.',
    schema: { type: 'string', enum: sort, default: defaultSort },
  },
];
const filter = (name: string, values: string[]) => ({
  name,
  in: 'query',
  schema: { type: 'string', enum: values },
});
const requestId = 'req_example_01';
const exampleUser = {
  id: '2cd65e90-ce9f-42e4-a7f4-1e6dc8dba84b',
  email: 'learner@example.com',
  name: 'API Learner',
  role: 'member',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};
const exampleProject = {
  id: 'b70efcda-37b8-47cc-915d-88e34902ae75',
  name: 'Learning API integration',
  description: 'Practice fetching a real API',
  status: 'active',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};
const projectFields = {
  name: plain(120),
  description: { ...plain(2000, 0), default: '' },
  status: { type: 'string', enum: ['active', 'archived'], default: 'active' },
};
const taskFields = {
  title: plain(200),
  description: { ...plain(4000, 0), default: '' },
  status: { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
  priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
  projectId: {
    ...nullable(uuid),
    default: null,
    description: 'ID of a project you own, or null to remove the association.',
  },
  dueDate: {
    ...nullable({ type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    default: null,
    description: 'Valid calendar date, YYYY-MM-DD, or null.',
  },
};
const authenticationFields = {
  email: {
    type: 'string',
    format: 'email',
    maxLength: 254,
    description: 'Trimmed and normalized to lowercase.',
  },
  password: {
    type: 'string',
    minLength: 15,
    maxLength: 128,
    pattern: '^[^\\u0000-\\u001f\\u007f]*$',
    writeOnly: true,
    description:
      'Passwords are never trimmed or returned. Maximum 256 UTF-8 bytes, no control characters.',
  },
};
const scopes = {
  type: 'string',
  enum: ['resources:read', 'resources:write', 'files:read', 'files:write'],
};
const apiKeyFields = {
  id: uuid,
  name: plain(80),
  prefix: { type: 'string' },
  scopes: array(scopes),
  createdAt: dateTime,
  expiresAt: dateTime,
};
const sampleId = 'b70efcda-37b8-47cc-915d-88e34902ae75';
const examples: Record<string, unknown> = {
  User: exampleUser,
  Project: exampleProject,
  Task: {
    id: '2fdd0cd8-74e6-4776-b509-f312dd442ae2',
    title: 'Build a project list',
    description: 'Fetch the first page',
    status: 'todo',
    priority: 'medium',
    projectId: sampleId,
    dueDate: '2026-10-31',
    createdAt: exampleProject.createdAt,
    updatedAt: exampleProject.updatedAt,
  },
  File: {
    id: sampleId,
    filename: 'profile.png',
    contentType: 'image/png',
    size: 1024,
    createdAt: exampleProject.createdAt,
    downloadUrl: `/api/v1/files/${sampleId}/content`,
  },
  AuthTokens: {
    user: exampleUser,
    accessToken: 'eyJ...example-access-token',
    refreshToken: 'A'.repeat(43),
    tokenType: 'Bearer',
    expiresIn: 900,
    sessionExpiresAt: '2026-01-08T10:00:00.000Z',
  },
  Session: {
    id: sampleId,
    createdAt: exampleProject.createdAt,
    expiresAt: '2026-01-08T10:00:00.000Z',
    lastSeenAt: exampleProject.updatedAt,
    current: true,
  },
  Revoked: { revoked: true },
  Deleted: { id: sampleId, deleted: true },
  ApiKey: {
    id: sampleId,
    name: 'Server integration',
    prefix: 'ak_AAAAAAAA',
    scopes: ['resources:read'],
    createdAt: exampleProject.createdAt,
    expiresAt: '2026-01-31T10:00:00.000Z',
  },
  AuditEvent: {
    id: sampleId,
    actorId: exampleUser.id,
    action: 'project.create',
    resourceType: 'projects',
    resourceId: sampleId,
    requestId,
    metadata: {},
    createdAt: exampleProject.createdAt,
  },
};
examples.CreatedApiKey = { ...(examples.ApiKey as object), key: `ak_${'A'.repeat(43)}` };
function sample(schema: Schema): unknown {
  if (typeof schema.$ref === 'string') return examples[schema.$ref.split('/').at(-1)!];
  if ('const' in schema) return schema.const;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf[0] as Schema);
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries((schema.properties as Record<string, Schema>) ?? {}).map(([key, value]) => [
        key,
        sample(value),
      ]),
    );
  if (schema.type === 'array') return [sample(schema.items as Schema)];
  if (schema.type === 'integer') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return true;
  if (schema.format === 'uuid') return sampleId;
  if (schema.format === 'date-time') return exampleProject.createdAt;
  return 'example';
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Frontend Learning API',
    version: '1.0.0',
    description:
      'A small, modular Supabase Edge Functions API for learning frontend integration. Protected JSON endpoints share one success/error envelope. Tokens are explicit Bearer headers; the application sets no authentication cookies. API keys belong on trusted servers, never inside a public frontend bundle. Resource ownership is enforced for members and administrators alike. See README and docs/frontend.md for an end-to-end tutorial.',
  },
  servers: [
    { url: 'http://localhost:8787', description: 'Local PostgreSQL development' },
    {
      url: 'https://{projectRef}.supabase.co/functions/v1/backend',
      description: 'Live API; local frontend calls this complete base URL',
      variables: { projectRef: { default: 'fvhpmujmbavwdpjoyyal' } },
    },
  ],
  tags: [
    { name: 'System', description: 'Public discovery, health, and documentation.' },
    {
      name: 'Authentication',
      description:
        'Short-lived, session-backed access JWTs and single-use rotating refresh tokens.',
    },
    {
      name: 'API keys',
      description:
        'Bearer-only key management. Keys authorize trusted server integrations with narrow scopes.',
    },
    { name: 'Projects', description: 'Projects owned by the authenticated user.' },
    { name: 'Tasks', description: 'Tasks owned by the authenticated user.' },
    { name: 'Files', description: 'Private, owner-scoped raster image uploads and downloads.' },
    { name: 'Users', description: 'Current-user profile and administrator directory.' },
    { name: 'Audit', description: 'Administrator access to security audit events.' },
  ],
  paths: {
    '/health': {
      get: {
        operationId: 'health',
        tags: ['System'],
        summary: 'Check API liveness',
        security: [],
        responses: {
          '200': ok(
            object({
              status: { type: 'string', const: 'ok' },
              version: { type: 'string', const: '1.0.0' },
            }),
          ),
          ...errors(),
        },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        tags: ['System'],
        summary: 'Check database readiness',
        description:
          'Runs a lightweight PostgreSQL query. A failed dependency returns 503 without infrastructure details.',
        security: [],
        responses: {
          '200': ok(object({ status: { type: 'string', const: 'ready' } })),
          ...errors(),
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openApi',
        tags: ['System'],
        summary: 'Download this OpenAPI 3.1 document',
        security: [],
        responses: {
          '200': {
            description: 'The OpenAPI document itself (no envelope).',
            content: {
              'application/json': { schema: { type: 'object', additionalProperties: true } },
            },
          },
          ...errors(),
        },
      },
    },
    '/docs': {
      get: {
        operationId: 'apiReference',
        tags: ['System'],
        summary: 'Read the API reference',
        security: [],
        responses: {
          '200': {
            description:
              'Self-contained HTML locally; the free Supabase domain rewrites HTML to text/plain. Use the PDF or portable docs/index.html for the formatted reference. No JSON envelope.',
            content: {
              'text/html': { schema: { type: 'string' } },
              'text/plain': { schema: { type: 'string' } },
            },
          },
          ...errors(),
        },
      },
    },
    '/docs.css': {
      get: {
        operationId: 'apiReferenceStyles',
        tags: ['System'],
        summary: 'Read the API reference stylesheet',
        security: [],
        responses: {
          '200': {
            description: 'Local CSS stylesheet (no JSON envelope).',
            content: { 'text/css': { schema: { type: 'string' } } },
          },
          ...errors(),
        },
      },
    },
    '/api/v1': {
      get: {
        operationId: 'discovery',
        tags: ['System'],
        summary: 'Discover API links and version',
        security: [],
        responses: {
          '200': ok(
            object({
              version: { type: 'string', const: 'v1' },
              documentation: { type: 'string', const: '/docs' },
              openapi: { type: 'string', const: '/openapi.json' },
              resources: array({ type: 'string' }),
            }),
          ),
          ...errors(),
        },
      },
    },
    '/api/v1/auth/register': {
      post: {
        operationId: 'register',
        tags: ['Authentication'],
        summary: 'Register a member and create a session',
        security: [],
        description:
          'Public registration can be disabled by configuration. Unknown fields, including role, are rejected. New accounts always have the member role. Registration name is limited to 80 characters.',
        requestBody: body(ref('RegisterInput'), {
          email: 'learner@example.com',
          name: 'API Learner',
          password: 'use-a-unique-long-password',
        }),
        responses: {
          '201': ok(ref('AuthTokens'), 'Account and session created.'),
          ...errors(400, 403, 409, 413, 415, 422),
        },
      },
    },
    '/api/v1/auth/login': {
      post: {
        operationId: 'login',
        tags: ['Authentication'],
        summary: 'Create a session using email and password',
        security: [],
        description:
          'A user may have at most 20 active sessions; creating a new session beyond the cap atomically revokes the oldest session.',
        requestBody: body(ref('LoginInput'), {
          email: 'learner@example.com',
          password: 'use-a-unique-long-password',
        }),
        responses: { '200': ok(ref('AuthTokens')), ...errors(400, 401, 413, 415, 422) },
      },
    },
    '/api/v1/auth/refresh': {
      post: {
        operationId: 'refresh',
        tags: ['Authentication'],
        summary: 'Rotate a refresh token and obtain a new access token',
        security: [],
        description:
          'Send the refresh token in JSON. It can be used once. Store the returned replacement. Coordinate refreshes in the frontend so parallel requests do not race. An invalid, expired, or reused token returns 401. Replay of a consumed token revokes the entire session.',
        requestBody: body(ref('RefreshInput'), { refreshToken: 'A'.repeat(43) }),
        responses: { '200': ok(ref('AuthTokens')), ...errors(400, 401, 413, 415, 422) },
      },
    },
    '/api/v1/auth/logout': {
      post: {
        operationId: 'logout',
        tags: ['Authentication'],
        summary: 'Revoke the current session',
        security: bearer,
        description:
          'Send the current access token. No request body is needed. Its access and refresh tokens stop authorizing requests after revocation.',
        responses: { '200': ok(ref('Revoked')), ...protectedErrors() },
      },
    },
    '/api/v1/auth/me': {
      get: {
        operationId: 'authMe',
        tags: ['Authentication'],
        summary: 'Get the current authenticated user',
        security: bearer,
        responses: {
          '200': ok(object({ user: ref('User') }), 'Current user.', {
            success: true,
            data: { user: exampleUser },
            requestId,
          }),
          ...protectedErrors(),
        },
      },
    },
    '/api/v1/auth/sessions': {
      get: {
        operationId: 'listSessions',
        tags: ['Authentication'],
        summary: 'List your active sessions',
        security: bearer,
        responses: { '200': ok(object({ sessions: array(ref('Session')) })), ...protectedErrors() },
      },
    },
    '/api/v1/auth/sessions/{id}': {
      delete: {
        operationId: 'revokeSession',
        tags: ['Authentication'],
        summary: 'Revoke one of your sessions',
        security: bearer,
        parameters: [idParameter],
        responses: { '200': ok(ref('Revoked')), ...protectedErrors(404, 413, 415, 422) },
      },
    },
    '/api/v1/api-keys': {
      get: {
        operationId: 'listApiKeys',
        tags: ['API keys'],
        summary: 'List your API keys without their secrets',
        security: bearer,
        responses: { '200': ok(object({ items: array(ref('ApiKey')) })), ...protectedErrors() },
      },
      post: {
        operationId: 'createApiKey',
        tags: ['API keys'],
        summary: 'Create a scoped key for a trusted server',
        security: bearer,
        description:
          'The key secret is returned exactly once. Maximum 20 active keys per user. Copy it to your server secret store. Never put it in Vite/Next.js public variables, browser code, a mobile bundle, or a repository.',
        requestBody: body(ref('ApiKeyInput'), {
          name: 'Server integration',
          scopes: ['resources:read'],
          expiresInDays: 30,
        }),
        responses: {
          '201': ok(ref('CreatedApiKey'), 'API key created; secret returned once.'),
          ...protectedErrors(400, 409, 413, 415, 422),
        },
      },
    },
    '/api/v1/api-keys/{id}': {
      delete: {
        operationId: 'revokeApiKey',
        tags: ['API keys'],
        summary: 'Revoke your API key',
        security: bearer,
        parameters: [idParameter],
        responses: { '200': ok(ref('Revoked')), ...protectedErrors(404, 413, 415, 422) },
      },
    },
    '/api/v1/projects': {
      get: {
        operationId: 'listProjects',
        tags: ['Projects'],
        summary: 'List, filter, search, and sort your projects',
        security: resourceAuth,
        description:
          'Requires resources:read for API keys. Search matches project name and description as literal text. Other users’ projects never appear.',
        parameters: [
          ...listParameters(['createdAt', 'updatedAt', 'name']),
          filter('status', ['active', 'archived']),
        ],
        responses: { '200': listOk('Project'), ...protectedErrors(422) },
      },
      post: {
        operationId: 'createProject',
        tags: ['Projects'],
        summary: 'Create a project',
        security: resourceAuth,
        description: 'Requires resources:write for API keys.',
        requestBody: body(ref('ProjectCreate'), {
          name: 'Learning API integration',
          description: 'Practice fetching a real API',
          status: 'active',
        }),
        responses: {
          '201': created(ref('Project'), 'Project created.', {
            success: true,
            data: exampleProject,
            requestId,
          }),
          ...protectedErrors(400, 413, 415, 422),
        },
      },
    },
    '/api/v1/projects/{id}': {
      get: {
        operationId: 'getProject',
        tags: ['Projects'],
        summary: 'Read a project you own',
        description: 'Requires resources:read for API keys.',
        security: resourceAuth,
        parameters: [idParameter],
        responses: { '200': ok(ref('Project')), ...protectedErrors(404, 422) },
      },
      patch: {
        operationId: 'updateProject',
        tags: ['Projects'],
        summary: 'Update supplied project fields',
        description: 'Requires resources:write for API keys. Omitted fields remain unchanged.',
        security: resourceAuth,
        parameters: [idParameter],
        requestBody: body(ref('ProjectPatch'), { status: 'archived' }),
        responses: { '200': ok(ref('Project')), ...protectedErrors(400, 404, 413, 415, 422) },
      },
      delete: {
        operationId: 'deleteProject',
        tags: ['Projects'],
        summary: 'Delete a project you own',
        description:
          'Associated tasks remain; their projectId becomes null. Requires resources:write for API keys.',
        security: resourceAuth,
        parameters: [idParameter],
        responses: { '200': ok(ref('Deleted')), ...protectedErrors(404, 413, 415, 422) },
      },
    },
    '/api/v1/tasks': {
      get: {
        operationId: 'listTasks',
        tags: ['Tasks'],
        summary: 'List, filter, search, and sort your tasks',
        security: resourceAuth,
        description:
          'Requires resources:read for API keys. Search matches task title and description as literal text.',
        parameters: [
          ...listParameters(['createdAt', 'updatedAt', 'title', 'dueDate']),
          filter('status', ['todo', 'in_progress', 'done']),
          filter('priority', ['low', 'medium', 'high']),
          { name: 'projectId', in: 'query', schema: uuid },
        ],
        responses: { '200': listOk('Task'), ...protectedErrors(422) },
      },
      post: {
        operationId: 'createTask',
        tags: ['Tasks'],
        summary: 'Create a task, optionally within your project',
        security: resourceAuth,
        description:
          'Requires resources:write for API keys. projectId must identify a project you own.',
        requestBody: body(ref('TaskCreate'), {
          title: 'Build a project list',
          description: 'Fetch the first page',
          status: 'todo',
          priority: 'medium',
          projectId: 'b70efcda-37b8-47cc-915d-88e34902ae75',
          dueDate: '2026-10-31',
        }),
        responses: {
          '201': created(ref('Task'), 'Task created.'),
          ...protectedErrors(400, 404, 409, 413, 415, 422),
        },
      },
    },
    '/api/v1/tasks/{id}': {
      get: {
        operationId: 'getTask',
        tags: ['Tasks'],
        summary: 'Read a task you own',
        description: 'Requires resources:read for API keys.',
        security: resourceAuth,
        parameters: [idParameter],
        responses: { '200': ok(ref('Task')), ...protectedErrors(404, 422) },
      },
      patch: {
        operationId: 'updateTask',
        tags: ['Tasks'],
        summary: 'Update supplied task fields',
        description: 'Requires resources:write for API keys. Omitted fields remain unchanged.',
        security: resourceAuth,
        parameters: [idParameter],
        requestBody: body(ref('TaskPatch'), { status: 'done', projectId: null }),
        responses: { '200': ok(ref('Task')), ...protectedErrors(400, 404, 409, 413, 415, 422) },
      },
      delete: {
        operationId: 'deleteTask',
        tags: ['Tasks'],
        summary: 'Delete a task you own',
        description: 'Requires resources:write for API keys.',
        security: resourceAuth,
        parameters: [idParameter],
        responses: { '200': ok(ref('Deleted')), ...protectedErrors(404, 413, 415, 422) },
      },
    },
    '/api/v1/files': {
      get: {
        operationId: 'listFiles',
        tags: ['Files'],
        summary: 'List metadata for your private files',
        security: resourceAuth,
        description: 'Requires files:read for API keys. Search matches filename as literal text.',
        parameters: [
          ...listParameters(['createdAt', 'filename', 'size']),
          filter('contentType', ['image/png', 'image/jpeg', 'image/webp']),
        ],
        responses: { '200': listOk('File'), ...protectedErrors(422) },
      },
      post: {
        operationId: 'uploadFile',
        tags: ['Files'],
        summary: 'Upload a raster image as raw bytes',
        security: resourceAuth,
        description:
          'Requires files:write for API keys. Send the File/Blob directly, not JSON, base64, or multipart FormData. MIME, extension, signature, image structure and dimensions are checked. Upload size is limited by MAX_UPLOAD_BYTES; default 5 MiB. Maximum 40 million pixels and 16384 pixels per side. APNG and animated WebP are rejected. Files are private in Storage.',
        parameters: [
          {
            name: 'X-File-Name',
            in: 'header',
            required: true,
            description:
              'Start with an ASCII letter/digit; remaining characters may be ASCII letters, digits, spaces, dots, underscores, and hyphens; no paths. Spaces are normalized to underscores. Extension must match MIME (case-insensitive).',
            schema: {
              type: 'string',
              minLength: 1,
              maxLength: 120,
              pattern:
                '^[A-Za-z0-9][A-Za-z0-9 ._-]*\\.([Pp][Nn][Gg]|[Jj][Pp][Gg]|[Jj][Pp][Ee][Gg]|[Ww][Ee][Bb][Pp])$',
            },
            example: 'profile.png',
          },
        ],
        requestBody: {
          required: true,
          content: Object.fromEntries(
            ['image/png', 'image/jpeg', 'image/webp'].map((mime) => [
              mime,
              { schema: { type: 'string', format: 'binary', contentMediaType: mime } },
            ]),
          ),
        },
        responses: {
          '201': created(ref('File'), 'File stored; metadata returned.'),
          ...protectedErrors(400, 413, 415, 422),
        },
      },
    },
    '/api/v1/files/{id}': {
      get: {
        operationId: 'getFile',
        tags: ['Files'],
        summary: 'Read metadata for a file you own',
        description: 'Requires files:read for API keys.',
        security: resourceAuth,
        parameters: [idParameter],
        responses: { '200': ok(ref('File')), ...protectedErrors(404, 422) },
      },
      delete: {
        operationId: 'deleteFile',
        tags: ['Files'],
        summary: 'Delete your file and its metadata',
        security: resourceAuth,
        description:
          'Requires files:write for API keys. PostgreSQL and Storage cannot share a transaction; a 503 FILE_DELETION_PENDING means access is already blocked and scheduled cleanup will resume. Retry is safe.',
        parameters: [idParameter],
        responses: { '200': ok(ref('Deleted')), ...protectedErrors(404, 413, 415, 422) },
      },
    },
    '/api/v1/files/{id}/content': {
      get: {
        operationId: 'downloadFile',
        tags: ['Files'],
        summary: 'Download your file as a binary attachment',
        security: resourceAuth,
        parameters: [idParameter],
        description:
          'Requires files:read for API keys. Successful responses contain bytes instead of a JSON envelope. Fetch with authorization, call response.blob(), and create an object URL. A normal image URL cannot attach your Bearer header.',
        responses: {
          '200': {
            description: 'Private image content.',
            headers: {
              'Content-Disposition': {
                schema: { type: 'string' },
                example: 'attachment; filename="profile.png"',
              },
              'X-Content-Type-Options': { schema: { type: 'string', const: 'nosniff' } },
              'Cache-Control': {
                schema: { type: 'string' },
                description: 'Private downloads must not be cached publicly.',
              },
            },
            content: Object.fromEntries(
              ['image/png', 'image/jpeg', 'image/webp'].map((mime) => [
                mime,
                { schema: { type: 'string', format: 'binary' } },
              ]),
            ),
          },
          ...protectedErrors(404, 422),
        },
      },
    },
    '/api/v1/users/me': {
      get: {
        operationId: 'getProfile',
        tags: ['Users'],
        summary: 'Read your profile',
        security: bearer,
        responses: { '200': ok(ref('User')), ...protectedErrors() },
      },
      patch: {
        operationId: 'updateProfile',
        tags: ['Users'],
        summary: 'Update your display name',
        security: bearer,
        description: 'Email, role, passwords, IDs and timestamps cannot be changed here.',
        requestBody: body(ref('ProfilePatch'), { name: 'API Learner' }),
        responses: { '200': ok(ref('User')), ...protectedErrors(400, 413, 415, 422) },
      },
    },
    '/api/v1/users': {
      get: {
        operationId: 'listUsers',
        tags: ['Users'],
        summary: 'List users (admin only)',
        security: bearer,
        description:
          'Requires an active Bearer session and the admin role. API keys are never sufficient.',
        parameters: [
          ...listParameters(['createdAt', 'name', 'email']),
          filter('role', ['member', 'admin']),
        ],
        responses: { '200': listOk('User'), ...protectedErrors(422) },
      },
    },
    '/api/v1/audit-logs': {
      get: {
        operationId: 'listAuditLogs',
        tags: ['Audit'],
        summary: 'List audit events (admin only)',
        security: bearer,
        description:
          'Requires an active Bearer session and the admin role. No token, password, secret, or raw IP is returned. Search q is not supported.',
        parameters: [
          ...listParameters(['createdAt']).filter(
            (p) => !('$ref' in p && p.$ref === '#/components/parameters/Search'),
          ),
          { name: 'action', in: 'query', schema: plain(100) },
          { name: 'actorId', in: 'query', schema: uuid },
        ],
        responses: { '200': listOk('AuditEvent'), ...protectedErrors(422) },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Session-backed HS256 access token from register/login/refresh. A signature alone is insufficient: the PostgreSQL session must remain active.',
      },
      apiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description:
          'Trusted server credentials only. One auth method per request. Keys carry their owner and explicit scopes.',
      },
    },
    parameters: {
      ResourceId: { name: 'id', in: 'path', required: true, schema: uuid },
      Page: {
        name: 'page',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
        example: 1,
      },
      Limit: {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        example: 20,
      },
      Search: {
        name: 'q',
        in: 'query',
        description:
          'Literal plain-text search. Omit for no search. SQL wildcard characters have no special meaning.',
        schema: plain(100),
        example: 'learning',
      },
      Order: {
        name: 'order',
        in: 'query',
        schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
      },
    },
    schemas: {
      User: {
        ...object({
          id: uuid,
          email: { type: 'string', format: 'email' },
          name: plain(100),
          role: { type: 'string', enum: ['member', 'admin'] },
          createdAt: dateTime,
          updatedAt: dateTime,
        }),
        example: exampleUser,
      },
      RegisterInput: object({ ...authenticationFields, name: plain(80) }),
      LoginInput: object(authenticationFields),
      RefreshInput: object({
        refreshToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', writeOnly: true },
      }),
      AuthTokens: object({
        user: ref('User'),
        accessToken: {
          type: 'string',
          description:
            'Short-lived JWT. Keep in memory; send as Authorization: Bearer <accessToken>.',
        },
        refreshToken: {
          type: 'string',
          description: 'Opaque, single-use secret; replaced on refresh.',
        },
        tokenType: { type: 'string', const: 'Bearer' },
        expiresIn: {
          type: 'integer',
          minimum: 1,
          description: 'Access lifetime in seconds; default 900.',
        },
        sessionExpiresAt: dateTime,
      }),
      Session: object({
        id: uuid,
        createdAt: dateTime,
        expiresAt: dateTime,
        lastSeenAt: dateTime,
        current: { type: 'boolean' },
      }),
      Revoked: object({ revoked: { type: 'boolean', const: true } }),
      Deleted: object({ id: uuid, deleted: { type: 'boolean', const: true } }),
      ApiKey: object(apiKeyFields),
      ApiKeyInput: object(
        {
          name: plain(80),
          scopes: { ...array(scopes), minItems: 1, maxItems: 4, uniqueItems: true },
          expiresInDays: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
        },
        ['name', 'scopes'],
      ),
      CreatedApiKey: object({
        ...apiKeyFields,
        key: {
          type: 'string',
          pattern: '^ak_[A-Za-z0-9_-]{43}$',
          description: 'Copy once. It cannot be retrieved again.',
        },
      }),
      Project: object({ id: uuid, ...projectFields, createdAt: dateTime, updatedAt: dateTime }),
      ProjectCreate: object(projectFields, ['name']),
      ProjectPatch: { ...object(patchFields(projectFields), []), minProperties: 1 },
      Task: object({ id: uuid, ...taskFields, createdAt: dateTime, updatedAt: dateTime }),
      TaskCreate: object(taskFields, ['title']),
      TaskPatch: { ...object(patchFields(taskFields), []), minProperties: 1 },
      ProfilePatch: object({ name: plain(100) }),
      File: object({
        id: uuid,
        filename: { type: 'string', maxLength: 120 },
        contentType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
        size: { type: 'integer', minimum: 1 },
        createdAt: dateTime,
        downloadUrl: {
          type: 'string',
          description: 'Relative protected URL: fetch it with your auth header.',
        },
      }),
      AuditEvent: object({
        id: uuid,
        actorId: nullable(uuid),
        action: { type: 'string' },
        resourceType: { type: 'string' },
        resourceId: nullable({ type: 'string' }),
        requestId: { type: 'string' },
        metadata: { type: 'object', additionalProperties: true },
        createdAt: dateTime,
      }),
      PaginationMeta: {
        ...object({
          page: { type: 'integer', minimum: 1, maximum: 10000 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          total: { type: 'integer', minimum: 0 },
          totalPages: { type: 'integer', minimum: 0 },
          hasNext: { type: 'boolean' },
          hasPrevious: { type: 'boolean' },
        }),
        example: {
          page: 1,
          limit: 20,
          total: 21,
          totalPages: 2,
          hasNext: true,
          hasPrevious: false,
        },
      },
      ErrorDetail: object({ field: { type: 'string' }, message: { type: 'string' } }),
      Error: object({
        success: { type: 'boolean', const: false },
        error: object(
          {
            code: { type: 'string' },
            message: { type: 'string' },
            details: {
              description: 'Validation errors are an array of field/message objects.',
              anyOf: [array(ref('ErrorDetail')), { type: 'object', additionalProperties: true }],
            },
          },
          ['code', 'message'],
        ),
        requestId: { type: 'string' },
      }),
    },
    responses: Object.fromEntries(
      [
        [
          400,
          'Malformed JSON, a missing required body/header, or an ambiguous request.',
          'INVALID_JSON',
        ],
        [401, 'Missing, invalid, expired, or revoked credentials.', 'INVALID_CREDENTIALS'],
        [403, 'Insufficient role/scope, disallowed origin, or disabled registration.', 'FORBIDDEN'],
        [404, 'Resource or route missing. An unowned resource also returns 404.', 'NOT_FOUND'],
        [
          409,
          'Conflicting email, too many active API keys, or a related resource changed during a write.',
          'EMAIL_IN_USE',
        ],
        [413, 'The request exceeds the configured size limit.', 'PAYLOAD_TOO_LARGE'],
        [415, 'Unsupported Content-Type.', 'UNSUPPORTED_MEDIA_TYPE'],
        [
          422,
          'Strict input validation failed, including unknown fields or invalid query parameters.',
          'VALIDATION_ERROR',
        ],
        [429, 'Rate limit reached. Wait according to Retry-After before retrying.', 'RATE_LIMITED'],
        [500, 'Unexpected server error. Internal details are never exposed.', 'INTERNAL_ERROR'],
        [
          503,
          'Required configuration or storage dependency is unavailable.',
          'SERVICE_UNAVAILABLE',
        ],
      ].map(([status, description, code]) => [
        `Error${status}`,
        {
          ...jsonResponse(String(description), ref('Error'), {
            success: false,
            error: {
              code,
              message: String(description),
              ...(status === 422 ? { details: [{ field: 'name', message: 'Required' }] } : {}),
            },
            requestId,
          }),
          ...(status === 429
            ? {
                headers: {
                  'Retry-After': {
                    schema: { type: 'integer', minimum: 1 },
                    description: 'Seconds to wait before a retry.',
                  },
                  'X-Request-ID': { schema: { type: 'string' } },
                },
              }
            : {}),
        },
      ]),
    ),
  },
} as const;
