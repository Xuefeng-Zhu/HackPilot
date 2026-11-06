import { runMigrations } from "@agent-native/core/db";

export default runMigrations(
  [
    {
      version: 1,
      name: "hackpilot-core",
      sql: `CREATE TABLE IF NOT EXISTS hackathons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT,
  tagline TEXT,
  deadline_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  prizes JSONB NOT NULL DEFAULT '[]'::jsonb,
  rubric JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  source_text TEXT,
  extraction TEXT NOT NULL DEFAULT 'manual',
  imported_at TEXT,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS hackathon_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (now()),
  notified_at TEXT
);
CREATE TABLE IF NOT EXISTS hackathon_ideas (
  id TEXT PRIMARY KEY,
  hackathon_id TEXT NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pitch TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  selected BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'user',
  owner_email TEXT NOT NULL,
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now())
);
CREATE TABLE IF NOT EXISTS hackathon_tasks (
  id TEXT PRIMARY KEY,
  hackathon_id TEXT NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  day TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'build',
  position INTEGER NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT false,
  source TEXT NOT NULL DEFAULT 'user',
  estimate_hours INTEGER,
  owner_email TEXT NOT NULL,
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now())
);
CREATE TABLE IF NOT EXISTS hackathon_submission_items (
  id TEXT PRIMARY KEY,
  hackathon_id TEXT NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
  link TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  owner_email TEXT NOT NULL,
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now())
);
CREATE INDEX IF NOT EXISTS hackathons_owner_org_idx ON hackathons (owner_email, org_id, updated_at);
CREATE INDEX IF NOT EXISTS hackathon_shares_resource_idx ON hackathon_shares (resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS hackathon_ideas_parent_idx ON hackathon_ideas (hackathon_id, position);
CREATE INDEX IF NOT EXISTS hackathon_tasks_parent_idx ON hackathon_tasks (hackathon_id, day, position);
CREATE INDEX IF NOT EXISTS hackathon_submission_items_parent_idx ON hackathon_submission_items (hackathon_id, position)`,
    },
  ],
  { table: "hackpilot_migrations" },
);
