import type { DatabaseSync } from "node:sqlite";
import type { MatchEvent, MatchRecord, PlayerSeat, SeriesRecord } from "../../shared.js";
import { comparisonEligibility } from "../../domain/comparison.js";
import { APP_VERSION, DATABASE_SCHEMA_VERSION } from "../../version.js";
import { applySchema } from "./schema.js";
import { readSchemaVersion, writeSchemaVersion } from "./db.js";

/** Scalars projected out of a match record for indexed querying. */
interface MatchScalars {
  id: string;
  gameId: string;
  gameVersion: string;
  protocolVersion: string;
  status: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  seriesId: string | null;
  slotId: string | null;
  conditionId: string | null;
  blockId: string | null;
  planHash: string | null;
  resultKind: string | null;
  resultWinnerId: string | null;
  qualified: number | null;
  actionCount: number;
}

function matchScalars(record: MatchRecord): MatchScalars {
  return {
    id: record.id,
    gameId: record.gameId,
    gameVersion: record.gameVersion,
    protocolVersion: record.protocolVersion,
    status: record.status,
    revision: record.revision ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    seriesId: record.series?.id ?? null,
    slotId: record.series?.slotId ?? null,
    conditionId: record.series?.conditionId ?? null,
    blockId: record.series?.blockId ?? null,
    planHash: record.series?.planHash ?? null,
    resultKind: record.result?.kind ?? null,
    resultWinnerId: record.result?.winnerId ?? null,
    qualified: comparisonEligibility(record).eligible ? 1 : 0,
    actionCount: record.history.filter((turn) => turn.valid).length,
  };
}

function parseJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

/**
 * Transactional repository over the durable SQLite store.
 *
 * `record_json` is the lossless canonical record; scalar columns and the
 * participant/event tables are derived for querying. A checkpoint touches one
 * match row and its bounded child rows, never the whole archive.
 */
export class PersistenceRepository {
  private transactionDepth = 0;

  constructor(private readonly db: DatabaseSync, readonly path: string) {
    applySchema(db);
    const version = readSchemaVersion(db);
    if (version !== undefined && version > DATABASE_SCHEMA_VERSION) {
      throw new Error(`The database schema version ${version} is newer than this build supports (${DATABASE_SCHEMA_VERSION}). Refusing to open it.`);
    }
    writeSchemaVersion(db);
    if (!this.getMeta("app_version")) this.setMeta("app_version", APP_VERSION);
  }

  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* The transaction may already be aborted. */ }
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  hasMatches(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM matches").get() as { count: number };
    return row.count > 0;
  }

  countMatches(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM matches").get() as { count: number }).count;
  }

  countSeries(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM series").get() as { count: number }).count;
  }

  upsertMatch(record: MatchRecord): void {
    this.transaction(() => {
      const scalars = matchScalars(record);
      this.db.prepare(`
        INSERT INTO matches (
          id, game_id, game_version, protocol_version, status, revision, created_at, updated_at,
          series_id, slot_id, condition_id, block_id, plan_hash, result_kind, result_winner_id,
          qualified, action_count, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          game_id = excluded.game_id, game_version = excluded.game_version,
          protocol_version = excluded.protocol_version, status = excluded.status,
          revision = excluded.revision, updated_at = excluded.updated_at,
          series_id = excluded.series_id, slot_id = excluded.slot_id,
          condition_id = excluded.condition_id, block_id = excluded.block_id, plan_hash = excluded.plan_hash,
          result_kind = excluded.result_kind, result_winner_id = excluded.result_winner_id,
          qualified = excluded.qualified, action_count = excluded.action_count, record_json = excluded.record_json
      `).run(
        scalars.id, scalars.gameId, scalars.gameVersion, scalars.protocolVersion, scalars.status, scalars.revision,
        scalars.createdAt, scalars.updatedAt, scalars.seriesId, scalars.slotId, scalars.conditionId, scalars.blockId,
        scalars.planHash, scalars.resultKind, scalars.resultWinnerId, scalars.qualified, scalars.actionCount,
        JSON.stringify(record),
      );
      this.replaceParticipants(record);
      this.appendEvents(record.id, record.events);
    });
  }

  private replaceParticipants(record: MatchRecord): void {
    this.db.prepare("DELETE FROM match_participants WHERE match_id = ?").run(record.id);
    const insert = this.db.prepare("INSERT INTO match_participants (match_id, idx, id, label, provider, model, reasoning, resolved_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    record.players.forEach((seat: PlayerSeat, index: number) => {
      insert.run(record.id, index, seat.id, seat.label, seat.agent.provider, seat.agent.model, seat.agent.reasoning ?? null, seat.agent.resolvedModel ?? null);
    });
  }

  /**
   * Appends durable events idempotently. The in-memory record keeps only a
   * bounded presentation window, so this must never delete rows outside that
   * window: the durable log is intentionally complete.
   */
  appendEvents(matchId: string, events: MatchEvent[]): void {
    if (events.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO match_events (match_id, sequence, at, type, text, player_id, payload_json, durable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id, sequence) DO UPDATE SET
        at = excluded.at, type = excluded.type, text = excluded.text,
        player_id = excluded.player_id, payload_json = excluded.payload_json
    `);
    for (const event of events) {
      const sequence = event.sequence;
      if (sequence === undefined) continue; // transient presentation events are not durable
      insert.run(matchId, sequence, event.at, event.type, event.text, event.playerId ?? null, event.payload ? JSON.stringify(event.payload) : null, 1);
    }
  }

  allEvents(matchId: string): MatchEvent[] {
    const rows = this.db.prepare("SELECT sequence, at, type, text, player_id, payload_json FROM match_events WHERE match_id = ? ORDER BY sequence ASC").all(matchId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      at: String(row.at),
      type: String(row.type),
      text: String(row.text),
      sequence: Number(row.sequence),
      ...(row.player_id ? { playerId: String(row.player_id) } : {}),
      ...(row.payload_json ? { payload: parseJson<Record<string, unknown>>(String(row.payload_json)) } : {}),
    }));
  }

  getMatch(id: string): MatchRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM matches WHERE id = ?").get(id) as { record_json?: string } | undefined;
    return row?.record_json ? JSON.parse(row.record_json) as MatchRecord : undefined;
  }

  listMatches(): MatchRecord[] {
    const rows = this.db.prepare("SELECT record_json FROM matches ORDER BY created_at DESC").all() as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as MatchRecord);
  }

  /** Durable events are complete even when the stored record window is bounded. */
  getMatchWithFullEvents(id: string): MatchRecord | undefined {
    const record = this.getMatch(id);
    if (!record) return undefined;
    return { ...record, events: this.allEvents(id) };
  }

  deleteMatch(id: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM invocations WHERE match_id = ?").run(id);
      this.db.prepare("DELETE FROM matches WHERE id = ?").run(id);
    });
  }

  recordInvocation(invocation: { invocationId: string; matchId: string; turnId?: string; attempt?: number; reservedAt: string; deadlineAt?: string; state: string }): void {
    this.db.prepare(`
      INSERT INTO invocations (invocation_id, match_id, turn_id, attempt, reserved_at, deadline_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(invocation_id) DO UPDATE SET state = excluded.state,
        deadline_at = excluded.deadline_at, turn_id = excluded.turn_id, attempt = excluded.attempt
    `).run(invocation.invocationId, invocation.matchId, invocation.turnId ?? null, invocation.attempt ?? null, invocation.reservedAt, invocation.deadlineAt ?? null, invocation.state);
  }

  getInvocation(invocationId: string): { invocationId: string; matchId: string; state: string } | undefined {
    const row = this.db.prepare("SELECT invocation_id, match_id, state FROM invocations WHERE invocation_id = ?").get(invocationId) as
      { invocation_id: string; match_id: string; state: string } | undefined;
    return row ? { invocationId: row.invocation_id, matchId: row.match_id, state: row.state } : undefined;
  }

  upsertSeries(record: SeriesRecord): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO series (id, version, status, created_at, updated_at, plan_hash, research, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version, status = excluded.status, updated_at = excluded.updated_at,
          plan_hash = excluded.plan_hash, research = excluded.research, record_json = excluded.record_json
      `).run(record.id, record.version, record.status, record.createdAt, record.updatedAt, record.planHash ?? null, record.researchPlan ? 1 : 0, JSON.stringify(record));

      this.db.prepare("DELETE FROM series_slots WHERE series_id = ?").run(record.id);
      const insertSlot = this.db.prepare(`
        INSERT INTO series_slots (series_id, slot_id, ordinal, game_id, game_version, condition_id, block_id, replicate, challenge_id, skipped, roles_json, match_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const slot of record.slots) {
        insertSlot.run(record.id, slot.id, slot.ordinal, slot.gameId, slot.gameVersion ?? null, slot.conditionId ?? null,
          slot.blockId ?? null, slot.replicate ?? null, slot.challengeId, slot.skipped ? 1 : 0, JSON.stringify(slot.roles), JSON.stringify(slot.matchIds));
      }

      // Backfill durable attempt records from the slot→match linkage. The
      // scheduler owns richer attempt state; this keeps imported/legacy data
      // queryable and is idempotent.
      const insertAttempt = this.db.prepare(`
        INSERT INTO series_attempts (series_id, slot_id, attempt_no, match_id, state, execution_order, overlapped, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(series_id, slot_id, attempt_no) DO UPDATE SET match_id = excluded.match_id, state = excluded.state
      `);
      for (const slot of record.slots) {
        slot.matchIds.forEach((matchId, index) => {
          insertAttempt.run(record.id, slot.id, index + 1, matchId, "recorded", null, 0, record.updatedAt);
        });
      }
    });
  }

  getSeries(id: string): SeriesRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM series WHERE id = ?").get(id) as { record_json?: string } | undefined;
    return row?.record_json ? JSON.parse(row.record_json) as SeriesRecord : undefined;
  }

  listSeries(): SeriesRecord[] {
    const rows = this.db.prepare("SELECT record_json FROM series ORDER BY created_at DESC").all() as Array<{ record_json: string }>;
    return rows.map((row) => JSON.parse(row.record_json) as SeriesRecord);
  }

  loadAll(): { matches: MatchRecord[]; series: SeriesRecord[] } {
    return { matches: this.listMatches(), series: this.listSeries() };
  }

  addQuarantine(source: string, error: string | undefined, payload: unknown): void {
    this.db.prepare("INSERT INTO quarantine (created_at, source, error, payload_json) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), source, error ?? null, JSON.stringify(payload));
  }

  countQuarantine(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM quarantine").get() as { count: number }).count;
  }

  /** Bounded history query used by the history/experiment index. */
  queryMatches(filter: {
    gameId?: string; gameVersion?: string; status?: string; seriesId?: string; resultKind?: string;
    model?: string; provider?: string; since?: string; until?: string; limit?: number; offset?: number;
  } = {}): { total: number; matches: MatchRecord[] } {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.gameId) { clauses.push("m.game_id = ?"); params.push(filter.gameId); }
    if (filter.gameVersion) { clauses.push("m.game_version = ?"); params.push(filter.gameVersion); }
    if (filter.status) { clauses.push("m.status = ?"); params.push(filter.status); }
    if (filter.seriesId) { clauses.push("m.series_id = ?"); params.push(filter.seriesId); }
    if (filter.resultKind) { clauses.push("m.result_kind = ?"); params.push(filter.resultKind); }
    if (filter.since) { clauses.push("m.created_at >= ?"); params.push(filter.since); }
    if (filter.until) { clauses.push("m.created_at <= ?"); params.push(filter.until); }
    if (filter.model) { clauses.push("EXISTS (SELECT 1 FROM match_participants p WHERE p.match_id = m.id AND (p.model = ? OR p.resolved_model = ?))"); params.push(filter.model, filter.model); }
    if (filter.provider) { clauses.push("EXISTS (SELECT 1 FROM match_participants p WHERE p.match_id = m.id AND p.provider = ?)"); params.push(filter.provider); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM matches m ${where}`).get(...params) as { count: number }).count;
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.db.prepare(`SELECT m.record_json FROM matches m ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{ record_json: string }>;
    return { total, matches: rows.map((row) => JSON.parse(row.record_json) as MatchRecord) };
  }

  close(): void {
    this.db.close();
  }
}
