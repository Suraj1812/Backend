
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK(email = lower(email)),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_users_created ON users(created_at DESC, id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id, created_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  replacement_hash TEXT
);
CREATE INDEX idx_refresh_session ON refresh_tokens(session_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK(jsonb_typeof(scopes::jsonb) = 'array'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id, created_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=2000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id, owner_id)
);
CREATE INDEX idx_projects_owner_created ON projects(owner_id, created_at DESC, id);
CREATE INDEX idx_projects_owner_status ON projects(owner_id, status, created_at DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description)<=4000),
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
  project_id TEXT,
  due_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, owner_id) REFERENCES projects(id, owner_id)
);
CREATE INDEX idx_tasks_owner_created ON tasks(owner_id, created_at DESC, id);
CREATE INDEX idx_tasks_owner_status ON tasks(owner_id, status, created_at DESC);
CREATE INDEX idx_tasks_owner_project ON tasks(owner_id, project_id, created_at DESC);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
  size INTEGER NOT NULL CHECK(size > 0),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','deleting'))
);
CREATE INDEX idx_files_owner_created ON files(owner_id, created_at DESC, id);
CREATE INDEX idx_files_status ON files(status);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  request_id TEXT NOT NULL,
  ip_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata::jsonb) = 'object'),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC, id);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at DESC);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL, key_hash TEXT NOT NULL, window_start BIGINT NOT NULL,
  hits INTEGER NOT NULL CHECK(hits > 0), PRIMARY KEY(bucket,key_hash,window_start)
);
CREATE INDEX idx_rate_limits_expiry ON rate_limits(window_start);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Custom sessions are authorized exclusively by the Edge Function. Native
-- Data API clients have no table policies or privileges, including anon users.
DO $migration$
DECLARE t text; r text;
BEGIN
 FOREACH t IN ARRAY ARRAY['users','sessions','refresh_tokens','api_keys','projects','tasks','files','audit_logs','rate_limits','app_settings'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = r) THEN
    EXECUTE format('REVOKE ALL ON public.%I FROM %I',t,r);
   END IF;
  END LOOP;
 END LOOP;
END $migration$;
