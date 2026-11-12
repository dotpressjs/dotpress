-- Applied at startup: every statement is idempotent. A real app would use
-- migrations instead (one file per change of the schema).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE, -- lowercase: the username of the login
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  locale TEXT NOT NULL, -- language of the emails
  created_at TEXT NOT NULL
);

-- Refresh tokens of @dotpress/auth: only their SHA-256 hash is stored.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  jwt_id TEXT NOT NULL,
  family_id TEXT NOT NULL, -- the session
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_id ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id ON refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user_id ON project_members (user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo', 'doing', 'done')),
  assignee_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_project_id ON tasks (project_id);

-- Event messages already handled by a listener: queues deliver a message at
-- least once, and a message delivered twice must not send two emails.
CREATE TABLE IF NOT EXISTS handled_messages (
  id TEXT PRIMARY KEY, -- the id of the message, the same for every attempt
  handled_at TEXT NOT NULL
);
