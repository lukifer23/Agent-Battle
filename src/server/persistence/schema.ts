import type { DatabaseSync } from "node:sqlite";

/**
 * DDL for the durable store.
 *
 * Design notes:
 * - `record_json` is the lossless canonical record. Mapping every nested field
 *   into columns would invite silent field loss during a round trip; instead the
 *   record is stored whole and scalar columns are projected alongside it purely
 *   for indexing and querying. This is what makes the checkpoint cost O(one
 *   match) instead of O(the entire archive).
 * - `match_participants`, `match_events` and `invocations` are normalized so
 *   history/identity queries and the pre-spawn reservation ledger are indexed.
 * - No column is ever removed without a migration; `meta.schema_version` gates
 *   forward-only changes.
 */
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

CREATE TABLE IF NOT EXISTS quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  error TEXT,
  payload_json TEXT NOT NULL
);
`;

export function applySchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}
