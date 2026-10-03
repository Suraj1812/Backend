/**
 * Browser client for a local frontend calling the live HTTPS Supabase API.
 * Pass only its public base URL (VITE_API_BASE_URL / NEXT_PUBLIC_API_BASE_URL).
 * Tokens stay in memory. Never embed API keys or server secrets in a frontend.
 * Pass http://localhost:8787 explicitly only for local backend development.
 */
export type Role = 'member' | 'admin';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}
export interface AuthTokens {
  user: User;
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  sessionExpiresAt: string;
}
export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}
export interface Page<T> {
  items: T[];
  meta: Pagination;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}
export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  projectId: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface UploadedFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
  downloadUrl: string;
}
export interface Session {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  current: boolean;
}
type ProjectInput = Pick<Project, 'name'> & Partial<Pick<Project, 'description' | 'status'>>;
type TaskInput = Pick<Task, 'title'> &
  Partial<Pick<Task, 'description' | 'status' | 'priority' | 'projectId' | 'dueDate'>>;
type ListQuery = { page?: number; limit?: number; q?: string; order?: 'asc' | 'desc' };
type Success<T> = { success: true; data: T; requestId: string; meta?: Pagination };
type Failure = {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
};
type Envelope<T> = Success<T> | Failure;

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
    public readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export class LearningApi {
  private tokens: AuthTokens | null = null;
  private refreshPromise: Promise<void> | null = null;
  private readonly baseUrl: URL;

  constructor(baseUrl: string) {
    if (!baseUrl?.trim())
      throw new Error('Configure the public API base URL in your frontend environment');
    this.baseUrl = new URL(baseUrl);
    if (
      this.baseUrl.username ||
      this.baseUrl.password ||
      !['http:', 'https:'].includes(this.baseUrl.protocol)
    )
      throw new Error('Use a normal HTTP(S) API URL');
    if (this.baseUrl.search || this.baseUrl.hash)
      throw new Error('Use the API base URL without a query string or fragment');
    if (
      this.baseUrl.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname)
    )
      throw new Error('Use HTTPS outside local development');
  }

  get currentUser(): User | null {
    return this.tokens?.user ?? null;
  }

  private async response(
    path: string,
    init: RequestInit = {},
    authenticated = true,
    retry = true,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (authenticated) {
      if (!this.tokens) throw new ApiClientError(401, 'UNAUTHORIZED', 'Sign in first');
      headers.set('Authorization', `Bearer ${this.tokens.accessToken}`);
    }
    const response = await fetch(new URL(this.baseUrl.toString().replace(/\/$/, '') + path), {
      ...init,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    // A 401 is returned before an authenticated handler runs, so one retry is safe.
    if (response.status === 401 && authenticated && retry) {
      await this.refresh();
      return this.response(path, init, true, false);
    }
    return response;
  }

  private async envelope<T>(response: Response): Promise<Success<T>> {
    let result: Envelope<T>;
    try {
      result = (await response.json()) as Envelope<T>;
    } catch {
      throw new ApiClientError(
        response.status,
        'INVALID_RESPONSE',
        'The API returned an unexpected response',
        response.headers.get('X-Request-ID') ?? undefined,
      );
    }
    if (
      !result ||
      typeof result !== 'object' ||
      typeof result.success !== 'boolean' ||
      typeof result.requestId !== 'string'
    )
      throw new ApiClientError(
        response.status,
        'INVALID_RESPONSE',
        'The API returned an invalid envelope',
      );
    if (!result.success) {
      if (
        !result.error ||
        typeof result.error.message !== 'string' ||
        typeof result.error.code !== 'string'
      )
        throw new ApiClientError(
          response.status,
          'INVALID_RESPONSE',
          'The API returned an invalid error envelope',
          result.requestId,
        );
      throw new ApiClientError(
        response.status,
        result.error.code,
        result.error.message,
        result.requestId,
        result.error.details,
        response.headers.get('Retry-After'),
      );
    }
    if (!response.ok || !('data' in result))
      throw new ApiClientError(
        response.status,
        'INVALID_RESPONSE',
        'HTTP status and envelope disagree',
        result.requestId,
      );
    return result;
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    return (await this.envelope<T>(await this.response(path, init, authenticated))).data;
  }

  private jsonBody(value: unknown): Pick<RequestInit, 'body' | 'headers'> {
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
  }

  private query(path: string, query: object): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== '') params.set(key, String(value));
    return params.size ? `${path}?${params}` : path;
  }

  private async page<T>(path: string, query: object, signal?: AbortSignal): Promise<Page<T>> {
    const result = await this.envelope<T[]>(
      await this.response(this.query(path, query), { signal }),
    );
    if (!result.meta)
      throw new ApiClientError(
        200,
        'INVALID_RESPONSE',
        'The API did not return pagination',
        result.requestId,
      );
    return { items: result.data, meta: result.meta };
  }

  async register(input: { email: string; name: string; password: string }): Promise<User> {
    this.tokens = await this.request<AuthTokens>(
      '/api/v1/auth/register',
      { method: 'POST', ...this.jsonBody(input) },
      false,
    );
    return this.tokens.user;
  }

  async login(email: string, password: string): Promise<User> {
    this.tokens = await this.request<AuthTokens>(
      '/api/v1/auth/login',
      { method: 'POST', ...this.jsonBody({ email, password }) },
      false,
    );
    return this.tokens.user;
  }

  private async refresh(): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        if (!this.tokens) throw new ApiClientError(401, 'UNAUTHORIZED', 'Sign in again');
        try {
          this.tokens = await this.request<AuthTokens>(
            '/api/v1/auth/refresh',
            { method: 'POST', ...this.jsonBody({ refreshToken: this.tokens.refreshToken }) },
            false,
          );
        } catch (error) {
          this.tokens = null;
          throw error;
        }
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  async logout(): Promise<void> {
    try {
      if (this.tokens) await this.request('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      this.tokens = null;
    }
  }

  me(): Promise<User> {
    return this.request('/api/v1/users/me');
  }
  async rename(name: string): Promise<User> {
    const user = await this.request<User>('/api/v1/users/me', {
      method: 'PATCH',
      ...this.jsonBody({ name }),
    });
    if (this.tokens) this.tokens.user = user;
    return user;
  }
  sessions(): Promise<{ sessions: Session[] }> {
    return this.request('/api/v1/auth/sessions');
  }
  revokeSession(id: string): Promise<{ revoked: true }> {
    return this.request(`/api/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  projects(
    query: ListQuery & {
      status?: Project['status'];
      sort?: 'createdAt' | 'updatedAt' | 'name';
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<Project>> {
    return this.page('/api/v1/projects', query, signal);
  }
  project(id: string): Promise<Project> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`);
  }
  createProject(input: ProjectInput): Promise<Project> {
    return this.request('/api/v1/projects', { method: 'POST', ...this.jsonBody(input) });
  }
  updateProject(id: string, input: Partial<ProjectInput>): Promise<Project> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...this.jsonBody(input),
    });
  }
  deleteProject(id: string): Promise<{ id: string; deleted: true }> {
    return this.request(`/api/v1/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  tasks(
    query: ListQuery & {
      status?: Task['status'];
      priority?: Task['priority'];
      projectId?: string;
      sort?: 'createdAt' | 'updatedAt' | 'title' | 'dueDate';
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<Task>> {
    return this.page('/api/v1/tasks', query, signal);
  }
  task(id: string): Promise<Task> {
    return this.request(`/api/v1/tasks/${encodeURIComponent(id)}`);
  }
  createTask(input: TaskInput): Promise<Task> {
    return this.request('/api/v1/tasks', { method: 'POST', ...this.jsonBody(input) });
  }
  updateTask(id: string, input: Partial<TaskInput>): Promise<Task> {
    return this.request(`/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...this.jsonBody(input),
    });
  }
  deleteTask(id: string): Promise<{ id: string; deleted: true }> {
    return this.request(`/api/v1/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  files(
    query: ListQuery & {
      contentType?: 'image/png' | 'image/jpeg' | 'image/webp';
      sort?: 'createdAt' | 'filename' | 'size';
    } = {},
    signal?: AbortSignal,
  ): Promise<Page<UploadedFile>> {
    return this.page('/api/v1/files', query, signal);
  }
  upload(file: File, signal?: AbortSignal): Promise<UploadedFile> {
    return this.request('/api/v1/files', {
      method: 'POST',
      headers: { 'Content-Type': file.type, 'X-File-Name': file.name },
      body: file,
      signal,
    });
  }
  async download(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.response(`/api/v1/files/${encodeURIComponent(id)}/content`, {
      signal,
    });
    if (!response.ok) await this.envelope(response);
    return response.blob();
  }
  deleteFile(id: string): Promise<{ id: string; deleted: true }> {
    return this.request(`/api/v1/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

/** Example use. Call from an explicit user action; this module runs no requests on import. */
export async function learnCrud(
  api: LearningApi,
  email: string,
  password: string,
): Promise<Page<Task>> {
  await api.login(email, password);
  const project = await api.createProject({ name: 'My first API project' });
  const task = await api.createTask({ title: 'Render API data safely', projectId: project.id });
  await api.updateTask(task.id, { status: 'done' });
  return api.tasks({ projectId: project.id, page: 1, limit: 10, order: 'desc' });
}
