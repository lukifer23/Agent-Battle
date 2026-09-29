import type { DatabaseSync } from "node:sqlite";

/**
 * DDL for the durable store.
 *
 * `record_json` is the lossless canonical record. Scalar columns and child
 * tables are projections for indexing. A checkpoint writes one match, never
 * the archive. Columns are added only by an explicit migration.
 */

const QUARANTINE_V1_TABLE = `
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  error TEXT,
  payload_json TEXT NOT NULL
);
`;

const QUARANTINE_V2_TABLE = `
CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  error TEXT,
  payload_json TEXT NOT NULL,
  record_id TEXT
);
`;

/** Schema 1, kept so a migration test can build a pre-v2 database. */
export const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  game_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  series_id TEXT,
  slot_id TEXT,
  condition_id TEXT,
  block_id TEXT,
  plan_hash TEXT,
  result_kind TEXT,
  result_winner_id TEXT,
  qualified INTEGER,
  action_count INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_created_at ON matches(created_at DESC);
CREATE INDEX IF NOT EXISTS matches_game ON matches(game_id, game_version);
CREATE INDEX IF NOT EXISTS matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS matches_series ON matches(series_id);
CREATE INDEX IF NOT EXISTS matches_result ON matches(result_kind);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT,
  resolved_model TEXT,
  PRIMARY KEY (match_id, idx)
);
CREATE INDEX IF NOT EXISTS participants_model ON match_participants(provider, model);
CREATE INDEX IF NOT EXISTS participants_resolved ON match_participants(resolved_model);

CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  player_id TEXT,
  payload_json TEXT,
  durable INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (match_id, sequence)
);
CREATE INDEX IF NOT EXISTS events_match_type ON match_events(match_id, type);

CREATE TABLE IF NOT EXISTS invocations (
  invocation_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  turn_id TEXT,
  attempt INTEGER,
  reserved_at TEXT NOT NULL,
  deadline_at TEXT,
  state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invocations_match ON invocations(match_id);
CREATE INDEX IF NOT EXISTS invocations_state ON invocations(state);

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  plan_hash TEXT,
  research INTEGER NOT NULL DEFAULT 0,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS series_status ON series(status);
CREATE INDEX IF NOT EXISTS series_created_at ON series(created_at DESC);

CREATE TABLE IF NOT EXISTS series_slots (
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  game_version TEXT,
  condition_id TEXT,
  block_id TEXT,
  replicate INTEGER,
  challenge_id TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  roles_json TEXT NOT NULL,
  match_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (series_id, slot_id)
);
CREATE INDEX IF NOT EXISTS slots_series_ordinal ON series_slots(series_id, ordinal);

CREATE TABLE IF NOT EXISTS series_attempts (
  series_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  match_id TEXT NOT NULL,
  state TEXT NOT NULL,
  execution_order INTEGER,
  overlapped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (series_id, slot_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS attempts_match ON series_attempts(match_id);
CREATE INDEX IF NOT EXISTS attempts_series ON series_attempts(series_id, state);

CREATE TABLE IF NOT EXISTS scheduler_commands (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot_id TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS commands_series ON scheduler_commands(series_id, state);

${QUARANTINE_V1_TABLE}
`;

const SCHEMA_V2_TABLES = `
CREATE TABLE IF NOT EXISTS provider_sessions (
  session_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  invocation_id TEXT NOT NULL,
  player_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_sessions_match ON provider_sessions(match_id);
CREATE INDEX IF NOT EXISTS provider_sessions_invocation ON provider_sessions(invocation_id);

CREATE TABLE IF NOT EXISTS legacy_imports (
  source_path TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  store_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  match_count INTEGER NOT NULL,
  series_count INTEGER NOT NULL,
  quarantined INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_profiles (
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  agent_index INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  PRIMARY KEY (series_id, agent_index)
);

CREATE UNIQUE INDEX IF NOT EXISTS quarantine_source_record ON quarantine(source, record_id) WHERE record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS matches_load_status ON matches(load_status, status);
`;

/** Current schema. New databases are created from this script, never by altering a future file. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  game_version TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  series_id TEXT,
  slot_id TEXT,
  condition_id TEXT,
  block_id TEXT,
  plan_hash TEXT,
  result_kind TEXT,
  result_winner_id TEXT,
  qualified INTEGER,
  action_count INTEGER NOT NULL DEFAULT 0,
  load_status TEXT NOT NULL DEFAULT 'accepted',
  load_error TEXT,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_created_at ON matches(created_at DESC);
CREATE INDEX IF NOT EXISTS matches_game ON matches(game_id, game_version);
CREATE INDEX IF NOT EXISTS matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS matches_series ON matches(series_id);
CREATE INDEX IF NOT EXISTS matches_result ON matches(result_kind);

CREATE TABLE IF NOT EXISTS match_participants (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT,
  resolved_model TEXT,
  PRIMARY KEY (match_id, idx)
);
CREATE INDEX IF NOT EXISTS participants_model ON match_participants(provider, model);
CREATE INDEX IF NOT EXISTS participants_resolved ON match_participants(resolved_model);

CREATE TABLE IF NOT EXISTS match_events (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  player_id TEXT,
  payload_json TEXT,
  durable INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (match_id, sequence)
);
CREATE INDEX IF NOT EXISTS events_match_type ON match_events(match_id, type);

CREATE TABLE IF NOT EXISTS invocations (
  invocation_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  turn_id TEXT,
  attempt INTEGER,
  reserved_at TEXT NOT NULL,
  deadline_at TEXT,
  state TEXT NOT NULL,
  billing TEXT NOT NULL DEFAULT 'unknown',
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS invocations_match ON invocations(match_id);
CREATE INDEX IF NOT EXISTS invocations_state ON invocations(state);

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  plan_hash TEXT,
  research INTEGER NOT NULL DEFAULT 0,
  load_status TEXT NOT NULL DEFAULT 'accepted',
  load_error TEXT,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS series_status ON series(status);
CREATE INDEX IF NOT EXISTS series_created_at ON series(created_at DESC);

CREATE TABLE IF NOT EXISTS series_slots (
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  game_version TEXT,
  condition_id TEXT,
  block_id TEXT,
  replicate INTEGER,
  challenge_id TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  roles_json TEXT NOT NULL,
  match_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (series_id, slot_id)
);
CREATE INDEX IF NOT EXISTS slots_series_ordinal ON series_slots(series_id, ordinal);

CREATE TABLE IF NOT EXISTS series_attempts (
  series_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  match_id TEXT NOT NULL,
  state TEXT NOT NULL,
  execution_order INTEGER,
  overlapped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (series_id, slot_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS attempts_match ON series_attempts(match_id);
CREATE INDEX IF NOT EXISTS attempts_series ON series_attempts(series_id, state);

CREATE TABLE IF NOT EXISTS scheduler_commands (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  slot_id TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS commands_series ON scheduler_commands(series_id, state);

${QUARANTINE_V2_TABLE}
${SCHEMA_V2_TABLES}
`;

export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}

export function applyV1Schema(db: DatabaseSync): void {
  db.exec(SCHEMA_V1_SQL);
}

/**
 * Forward migration from schema 1 to schema 2. Additive only: record_json is
 * not rewritten. Caller must already know the database is schema 1.
 */
export function migrateV1ToV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      ALTER TABLE matches ADD COLUMN load_status TEXT NOT NULL DEFAULT 'accepted';
      ALTER TABLE matches ADD COLUMN load_error TEXT;
      ALTER TABLE series ADD COLUMN load_status TEXT NOT NULL DEFAULT 'accepted';
      ALTER TABLE series ADD COLUMN load_error TEXT;
      ALTER TABLE invocations ADD COLUMN billing TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE invocations ADD COLUMN detail_json TEXT;
      ALTER TABLE scheduler_commands ADD COLUMN payload_json TEXT;
      ALTER TABLE quarantine ADD COLUMN record_id TEXT;
    `);
    db.exec(SCHEMA_V2_TABLES);
    db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run();
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* The transaction may already be aborted. */ }
    throw error;
  }
}
