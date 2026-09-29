import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentAttempt, FrozenExecutionProfile, MatchEvent, MatchRecord, PlayerSeat, SeriesRecord } from "../../shared.js";
import { comparisonEligibility } from "../../domain/comparison.js";
import { defaultGames } from "../../domain/defaultGames.js";
import { APP_VERSION, DATABASE_SCHEMA_VERSION } from "../../version.js";
import { crossMatchInvocationErrors, validateSeriesLinkage } from "../integrity.js";
import { validateMatchRecord, validateSeriesRecord } from "../schema.js";
import { readSchemaVersion, restrictOwnerPermissions } from "./db.js";

function seriesWithoutProfiles(record: SeriesRecord): SeriesRecord {
  if (!record.executionProfiles) return record;
  const stored = { ...record };
  delete stored.executionProfiles;
  return stored;
}

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

export interface SeriesSaveSide {
  command?: { kind: string; slotId?: string; payload?: unknown };
  consumeRetry?: { slotId: string; matchId: string };
}

export interface LegacyImportReceipt {
  sourcePath: string;
  sourceSha256: string;
  storeVersion: number;
  state: string;
  manifestPath: string;
  importedAt: string;
  matchCount: number;
  seriesCount: number;
  quarantined: number;
}

export interface InvocationRow {
  invocationId: string;
  matchId: string;
  turnId?: string;
  attempt?: number;
  state: string;
  billing: string;
}

interface InvocationProjection {
  invocationId: string;
  turnId: string;
  attempt: number;
  playerId: string;
  reservedAt: string;
  deadlineAt: string | null;
  state: string;
  billing: string;
  detail: string | null;
  sessionId?: string;
  claimSession: boolean;
}

interface StoredInvocation {
  match_id: string;
  turn_id: string | null;
  attempt: number | null;
  state: string;
  billing: string | null;
  detail_json: string | null;
}

const ACTIVE_MATCH = new Set(["ready", "running", "paused", "interrupted"]);
const ACTIVE_SERIES = new Set(["ready", "running", "paused"]);
const BILLING_RANK: Record<string, number> = { unknown: 0, uncertain: 1, likely: 2, observed: 3 };
const LEDGER_FROM_STATUS: Record<string, string> = {
  valid: "completed",
  invalid: "failed",
  error: "failed",
  timeout: "timed_out",
  cancelled: "cancelled",
  interrupted: "interrupted",
};
const LEDGER_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  reserved: new Set(["reserved", "spawned", "completed", "failed", "timed_out", "cancelled", "interrupted"]),
  spawned: new Set(["spawned", "completed", "failed", "timed_out", "cancelled", "interrupted"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  timed_out: new Set(["timed_out"]),
  cancelled: new Set(["cancelled"]),
  interrupted: new Set(["interrupted"]),
};

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

function usageReported(attempt: AgentAttempt): boolean {
  return attempt.usage.inputTokens !== null || attempt.usage.outputTokens !== null || attempt.usage.costUsd !== null;
}

function projectLedger(attempt: AgentAttempt): { state: string; billing: string } | undefined {
  const reported = usageReported(attempt);
  if (attempt.status === "started") {
    const spawned = attempt.ledgerState === "spawned";
    return { state: spawned ? "spawned" : "reserved", billing: spawned ? "likely" : "uncertain" };
  }
  const state = LEDGER_FROM_STATUS[attempt.status];
  if (!state) return undefined;
  if (attempt.status === "interrupted") return { state, billing: reported ? "observed" : attempt.ledgerState === "spawned" ? "likely" : "uncertain" };
  return { state, billing: reported ? "observed" : attempt.ledgerState === "spawned" ? "likely" : "unknown" };
}

function invocationProjections(record: MatchRecord): InvocationProjection[] {
  const rows: InvocationProjection[] = [];
  const consume = (turnId: string, playerId: string, attempt: AgentAttempt) => {
    if (!attempt.invocationId) return;
    const ledger = projectLedger(attempt);
    if (!ledger) return;
    rows.push({
      invocationId: attempt.invocationId,
      turnId,
      attempt: attempt.attempt,
      playerId,
      reservedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt ?? null,
      state: ledger.state,
      billing: ledger.billing,
      detail: attempt.ledgerDetail?.pid ? JSON.stringify({ pid: attempt.ledgerDetail.pid }) : null,
      ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
      claimSession: attempt.phase !== "qualification",
    });
  };
  for (const turn of record.history) for (const attempt of turn.attempts) consume(turn.turnId, turn.playerId, attempt);
  if (record.pendingTurn) for (const attempt of record.pendingTurn.attempts) consume(record.pendingTurn.turnId, record.pendingTurn.playerId, attempt);
  return rows;
}

function attemptStateFor(status: string | undefined, accepted: boolean): string {
  if (!accepted || !status) return "linked";
  if (status === "finished" || status === "forfeit") return "closed";
  if (status === "stopped" || status === "error") return "unscored";
  if (ACTIVE_MATCH.has(status)) return "active";
  return "linked";
}

/**
 * Transactional repository over the durable SQLite store.
 *
 * `record_json` is canonical. The invocation table is an indexed projection of
 * match attempts, written in the same checkpoint. A duplicate invocation id
 * bound to a different match or turn fails the checkpoint.
 */
export class PersistenceRepository {
  private transactionDepth = 0;

  constructor(private readonly db: DatabaseSync, readonly path: string) {
    const version = readSchemaVersion(db);
    if (version !== DATABASE_SCHEMA_VERSION) {
      throw new Error(`Database schema version ${version ?? "missing"} is not ready (expected ${DATABASE_SCHEMA_VERSION}).`);
    }
    if (!this.getMeta("app_version")) this.setMeta("app_version", APP_VERSION);
    restrictOwnerPermissions(path);
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

  private restrict(): void {
    if (this.transactionDepth === 0) restrictOwnerPermissions(this.path);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  hasMatches(): boolean {
    return this.countMatches() > 0;
  }

  countMatches(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM matches WHERE load_status = 'accepted'").get() as { count: number }).count;
  }

  countSeries(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM series WHERE load_status = 'accepted'").get() as { count: number }).count;
  }

  maxRevision(): number {
    const meta = Number(this.getMeta("max_match_revision") ?? 0);
    const row = this.db.prepare("SELECT MAX(revision) AS revision FROM matches").get() as { revision: number | null };
    return Math.max(Number.isFinite(meta) ? meta : 0, row.revision ?? 0);
  }

  upsertMatch(record: MatchRecord): void {
    this.transaction(() => {
      const scalars = matchScalars(record);
      this.db.prepare(`
        INSERT INTO matches (
          id, game_id, game_version, protocol_version, status, revision, created_at, updated_at,
          series_id, slot_id, condition_id, block_id, plan_hash, result_kind, result_winner_id,
          qualified, action_count, load_status, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)
        ON CONFLICT(id) DO UPDATE SET
          game_id = excluded.game_id, game_version = excluded.game_version,
          protocol_version = excluded.protocol_version, status = excluded.status,
          revision = excluded.revision, updated_at = excluded.updated_at,
          series_id = excluded.series_id, slot_id = excluded.slot_id,
          condition_id = excluded.condition_id, block_id = excluded.block_id, plan_hash = excluded.plan_hash,
          result_kind = excluded.result_kind, result_winner_id = excluded.result_winner_id,
          qualified = excluded.qualified, action_count = excluded.action_count,
          load_status = 'accepted', load_error = NULL, record_json = excluded.record_json
      `).run(
        scalars.id, scalars.gameId, scalars.gameVersion, scalars.protocolVersion, scalars.status, scalars.revision,
        scalars.createdAt, scalars.updatedAt, scalars.seriesId, scalars.slotId, scalars.conditionId, scalars.blockId,
        scalars.planHash, scalars.resultKind, scalars.resultWinnerId, scalars.qualified, scalars.actionCount,
        JSON.stringify(record),
      );
      const currentMax = Number(this.getMeta("max_match_revision") ?? 0);
      if (scalars.revision > currentMax) this.setMeta("max_match_revision", String(scalars.revision));
      this.replaceParticipants(record);
      this.appendEvents(record.id, record.events);
      this.syncInvocations(record);
    });
    this.restrict();
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
      if (sequence === undefined) continue;
      insert.run(matchId, sequence, event.at, event.type, event.text, event.playerId ?? null, event.payload ? JSON.stringify(event.payload) : null, 1);
    }
  }

  private syncInvocations(record: MatchRecord): void {
    const projections = invocationProjections(record);
    const seen = new Map<string, InvocationProjection>();
    for (const projection of projections) {
      const previous = seen.get(projection.invocationId);
      if (previous && (previous.turnId !== projection.turnId || previous.attempt !== projection.attempt)) {
        throw new Error(`Invocation ${projection.invocationId} is already bound to a different turn or attempt.`);
      }
      seen.set(projection.invocationId, projection);
    }
    const lookup = this.db.prepare("SELECT match_id, turn_id, attempt, state, billing, detail_json FROM invocations WHERE invocation_id = ?");
    const write = this.db.prepare(`
      INSERT INTO invocations (invocation_id, match_id, turn_id, attempt, reserved_at, deadline_at, state, billing, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(invocation_id) DO UPDATE SET
        state = excluded.state, billing = excluded.billing, deadline_at = excluded.deadline_at,
        turn_id = excluded.turn_id, attempt = excluded.attempt,
        detail_json = COALESCE(excluded.detail_json, invocations.detail_json)
    `);
    const sessionLookup = this.db.prepare("SELECT invocation_id, match_id FROM provider_sessions WHERE session_id = ?");
    const sessionInsert = this.db.prepare("INSERT INTO provider_sessions (session_id, match_id, invocation_id, player_id) VALUES (?, ?, ?, ?)");
    for (const projection of seen.values()) {
      const existing = lookup.get(projection.invocationId) as StoredInvocation | undefined;
      if (existing) {
        if (existing.match_id !== record.id) throw new Error(`Invocation ${projection.invocationId} is already bound to match ${existing.match_id}.`);
        if (existing.turn_id && existing.turn_id !== projection.turnId) throw new Error(`Invocation ${projection.invocationId} is already bound to a different turn.`);
        if (existing.attempt != null && existing.attempt !== projection.attempt) throw new Error(`Invocation ${projection.invocationId} is already bound to a different attempt.`);
        const allowed = LEDGER_TRANSITIONS[existing.state];
        if (!allowed?.has(projection.state)) throw new Error(`Illegal invocation transition for ${projection.invocationId}: ${existing.state} -> ${projection.state}.`);
      }
      const existingRank = BILLING_RANK[existing?.billing ?? "unknown"] ?? 0;
      const nextRank = BILLING_RANK[projection.billing] ?? 0;
      const billing = existing && existingRank > nextRank ? existing.billing ?? projection.billing : projection.billing;
      write.run(projection.invocationId, record.id, projection.turnId, projection.attempt, projection.reservedAt, projection.deadlineAt, projection.state, billing, projection.detail ?? existing?.detail_json ?? null);
      if (!projection.sessionId) continue;
      const owner = sessionLookup.get(projection.sessionId) as { invocation_id: string; match_id: string } | undefined;
      if (!owner) sessionInsert.run(projection.sessionId, record.id, projection.invocationId, projection.playerId);
      else if (owner.invocation_id !== projection.invocationId && projection.claimSession) {
        throw new Error(`Provider session ${projection.sessionId} is already claimed by invocation ${owner.invocation_id}.`);
      }
    }
    const ids = [...seen.keys()];
    if (ids.length === 0) {
      this.db.prepare("DELETE FROM provider_sessions WHERE match_id = ?").run(record.id);
      this.db.prepare("DELETE FROM invocations WHERE match_id = ?").run(record.id);
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`DELETE FROM provider_sessions WHERE match_id = ? AND invocation_id NOT IN (${placeholders})`).run(record.id, ...ids);
    this.db.prepare(`DELETE FROM invocations WHERE match_id = ? AND invocation_id NOT IN (${placeholders})`).run(record.id, ...ids);
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
    const row = this.db.prepare("SELECT record_json, load_status FROM matches WHERE id = ?").get(id) as { record_json?: string; load_status?: string } | undefined;
    if (!row?.record_json || row.load_status === "quarantined") return undefined;
    return this.acceptMatch(id, row.record_json);
  }

  private acceptMatch(id: string, recordJson: string): MatchRecord | undefined {
    let parsed: unknown;
    try { parsed = JSON.parse(recordJson); }
    catch {
      this.quarantineStored("matches", id, "record_json is not valid JSON", recordJson);
      return undefined;
    }
    const result = validateMatchRecord(parsed);
    const gameError = result.value ? defaultGames.validateRecord(result.value) : result.error;
    if (!result.value || gameError) {
      this.quarantineStored("matches", id, gameError ?? result.error ?? "Invalid match", parsed);
      return undefined;
    }
    return parsed as MatchRecord;
  }

  listMatches(): MatchRecord[] {
    const rows = this.db.prepare("SELECT id, record_json FROM matches WHERE load_status = 'accepted' ORDER BY created_at DESC").all() as Array<{ id: string; record_json: string }>;
    const matches: MatchRecord[] = [];
    for (const row of rows) {
      const match = this.acceptMatch(row.id, row.record_json);
      if (match) matches.push(match);
    }
    return matches;
  }

  /** Durable events are complete even when the stored record window is bounded. */
  getMatchWithFullEvents(id: string): MatchRecord | undefined {
    const record = this.getMatch(id);
    if (!record) return undefined;
    return { ...record, events: this.allEvents(id) };
  }

  deleteMatch(id: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM provider_sessions WHERE match_id = ?").run(id);
      this.db.prepare("DELETE FROM invocations WHERE match_id = ?").run(id);
      this.db.prepare("DELETE FROM matches WHERE id = ?").run(id);
    });
    this.restrict();
  }

  getInvocation(invocationId: string): InvocationRow | undefined {
    const row = this.db.prepare("SELECT invocation_id, match_id, turn_id, attempt, state, billing FROM invocations WHERE invocation_id = ?").get(invocationId) as
      { invocation_id: string; match_id: string; turn_id: string | null; attempt: number | null; state: string; billing: string } | undefined;
    if (!row) return undefined;
    return {
      invocationId: row.invocation_id,
      matchId: row.match_id,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      ...(row.attempt != null ? { attempt: row.attempt } : {}),
      state: row.state,
      billing: row.billing,
    };
  }

  sessionOwner(sessionId: string): { matchId: string; invocationId: string; playerId: string } | undefined {
    const row = this.db.prepare("SELECT match_id, invocation_id, player_id FROM provider_sessions WHERE session_id = ?").get(sessionId) as
      { match_id: string; invocation_id: string; player_id: string } | undefined;
    return row ? { matchId: row.match_id, invocationId: row.invocation_id, playerId: row.player_id } : undefined;
  }

  upsertSeries(record: SeriesRecord, side?: SeriesSaveSide): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO series (id, version, status, created_at, updated_at, plan_hash, research, load_status, record_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version, status = excluded.status, updated_at = excluded.updated_at,
          plan_hash = excluded.plan_hash, research = excluded.research,
          load_status = 'accepted', load_error = NULL, record_json = excluded.record_json
      `).run(record.id, record.version, record.status, record.createdAt, record.updatedAt, record.planHash ?? null, record.researchPlan ? 1 : 0, JSON.stringify(seriesWithoutProfiles(record)));

      this.db.prepare("DELETE FROM series_slots WHERE series_id = ?").run(record.id);
      const insertSlot = this.db.prepare(`
        INSERT INTO series_slots (series_id, slot_id, ordinal, game_id, game_version, condition_id, block_id, replicate, challenge_id, skipped, roles_json, match_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const slot of record.slots) {
        insertSlot.run(record.id, slot.id, slot.ordinal, slot.gameId, slot.gameVersion ?? null, slot.conditionId ?? null,
          slot.blockId ?? null, slot.replicate ?? null, slot.challengeId, slot.skipped ? 1 : 0, JSON.stringify(slot.roles), JSON.stringify(slot.matchIds));
      }

      const matchIds = record.slots.flatMap((slot) => slot.matchIds);
      if (matchIds.length === 0) this.db.prepare("DELETE FROM series_attempts WHERE series_id = ?").run(record.id);
      else this.db.prepare(`DELETE FROM series_attempts WHERE series_id = ? AND match_id NOT IN (${matchIds.map(() => "?").join(", ")})`).run(record.id, ...matchIds);
      const statusOf = this.db.prepare("SELECT status, load_status FROM matches WHERE id = ?");
      const insertAttempt = this.db.prepare(`
        INSERT INTO series_attempts (series_id, slot_id, attempt_no, match_id, state, execution_order, overlapped, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(series_id, slot_id, attempt_no) DO UPDATE SET match_id = excluded.match_id, state = excluded.state
      `);
      for (const slot of record.slots) {
        slot.matchIds.forEach((matchId, index) => {
          const row = statusOf.get(matchId) as { status?: string; load_status?: string } | undefined;
          insertAttempt.run(record.id, slot.id, index + 1, matchId, attemptStateFor(row?.status, row?.load_status === "accepted"), null, 0, record.updatedAt);
        });
      }
      if (side?.command) {
        this.db.prepare(`
          INSERT INTO scheduler_commands (id, series_id, kind, slot_id, state, created_at, payload_json)
          VALUES (?, ?, ?, ?, 'accepted', ?, ?)
        `).run(randomUUID(), record.id, side.command.kind, side.command.slotId ?? null, new Date().toISOString(), side.command.payload === undefined ? null : JSON.stringify(side.command.payload));
      }
      if (side?.consumeRetry) {
        this.db.prepare(`
          UPDATE scheduler_commands SET state = 'consumed', applied_at = ?, payload_json = ?
          WHERE series_id = ? AND slot_id = ? AND kind = 'retry' AND state = 'accepted'
        `).run(new Date().toISOString(), JSON.stringify({ matchId: side.consumeRetry.matchId }), record.id, side.consumeRetry.slotId);
      }
    });
    this.restrict();
  }

  hasAcceptedRetry(seriesId: string, slotId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM scheduler_commands WHERE series_id = ? AND slot_id = ? AND kind = 'retry' AND state = 'accepted' LIMIT 1").get(seriesId, slotId) as { present?: number } | undefined;
    return Boolean(row);
  }

  saveExecutionProfiles(seriesId: string, profiles: FrozenExecutionProfile[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM execution_profiles WHERE series_id = ?").run(seriesId);
      const insert = this.db.prepare("INSERT INTO execution_profiles (series_id, agent_index, profile_json) VALUES (?, ?, ?)");
      profiles.forEach((profile, index) => insert.run(seriesId, index, JSON.stringify(profile)));
    });
    this.restrict();
  }

  executionProfiles(seriesId: string): FrozenExecutionProfile[] {
    const rows = this.db.prepare("SELECT agent_index, profile_json FROM execution_profiles WHERE series_id = ? ORDER BY agent_index").all(seriesId) as Array<{ agent_index: number; profile_json: string }>;
    return rows.flatMap((row) => {
      try { return [JSON.parse(row.profile_json) as FrozenExecutionProfile]; }
      catch { return []; }
    });
  }

  private attachProfiles(record: SeriesRecord): SeriesRecord {
    const profiles = this.executionProfiles(record.id);
    if (!profiles.length) return record;
    return { ...record, executionProfiles: profiles };
  }

  getSeries(id: string): SeriesRecord | undefined {
    const row = this.db.prepare("SELECT record_json, load_status FROM series WHERE id = ?").get(id) as { record_json?: string; load_status?: string } | undefined;
    if (!row?.record_json || row.load_status === "quarantined") return undefined;
    try { return this.attachProfiles(JSON.parse(row.record_json) as SeriesRecord); }
    catch {
      this.quarantineStored("series", id, "record_json is not valid JSON", row.record_json);
      return undefined;
    }
  }

  listSeries(): SeriesRecord[] {
    const rows = this.db.prepare("SELECT id, record_json FROM series WHERE load_status = 'accepted' ORDER BY created_at DESC").all() as Array<{ id: string; record_json: string }>;
    const series: SeriesRecord[] = [];
    for (const row of rows) {
      try { series.push(this.attachProfiles(JSON.parse(row.record_json) as SeriesRecord)); }
      catch { this.quarantineStored("series", row.id, "record_json is not valid JSON", row.record_json); }
    }
    return series;
  }

  /**
   * Validates every accepted row. Malformed rows are quarantined in place:
   * `record_json` is not rewritten and startup continues. Only the recoverable
   * working set is returned.
   */
  validateResident(): { matches: MatchRecord[]; series: SeriesRecord[]; quarantined: number; warning?: string } {
    const matchRows = [...this.db.prepare("SELECT id, record_json, load_status FROM matches").iterate() as Iterable<{ id: string; record_json: string; load_status: string }>];
    const accepted = new Map<string, MatchRecord>();
    const quarantinedIds = new Set<string>();
    let quarantined = 0;
    const candidates: MatchRecord[] = [];
    for (const row of matchRows) {
      if (row.load_status === "quarantined") { quarantinedIds.add(row.id); continue; }
      const match = this.acceptMatch(row.id, row.record_json);
      if (!match) { quarantined += 1; quarantinedIds.add(row.id); continue; }
      candidates.push(match);
    }
    const conflicts = crossMatchInvocationErrors(candidates);
    for (const match of candidates) {
      const conflict = conflicts.get(match.id);
      if (conflict) {
        this.quarantineStored("matches", match.id, conflict, match);
        quarantined += 1;
        quarantinedIds.add(match.id);
        continue;
      }
      accepted.set(match.id, match);
    }

    const seriesRows = [...this.db.prepare("SELECT id, record_json, load_status FROM series").iterate() as Iterable<{ id: string; record_json: string; load_status: string }>];
    const residentSeries: SeriesRecord[] = [];
    const linkedIds = new Set<string>();
    for (const row of seriesRows) {
      if (row.load_status === "quarantined") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(row.record_json); }
      catch {
        this.quarantineStored("series", row.id, "record_json is not valid JSON", row.record_json);
        quarantined += 1;
        continue;
      }
      try { validateSeriesRecord(parsed); }
      catch (error) {
        this.quarantineStored("series", row.id, error instanceof Error ? error.message : "Invalid series", parsed);
        quarantined += 1;
        continue;
      }
      const series = parsed as SeriesRecord;
      const linkage = validateSeriesLinkage(series, accepted, quarantinedIds);
      if (linkage) {
        this.quarantineStored("series", row.id, linkage, parsed);
        quarantined += 1;
        continue;
      }
      if (ACTIVE_SERIES.has(series.status)) {
        residentSeries.push(series);
        for (const slot of series.slots) for (const matchId of slot.matchIds) linkedIds.add(matchId);
      }
    }

    const matches = [...accepted.values()].filter((match) => ACTIVE_MATCH.has(match.status) || linkedIds.has(match.id));
    matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const warning = quarantined > 0 ? `${quarantined} durable record(s) failed validation and were quarantined. record_json was not rewritten.` : undefined;
    return { matches, series: residentSeries, quarantined, ...(warning ? { warning } : {}) };
  }

  loadAll(): { matches: MatchRecord[]; series: SeriesRecord[] } {
    const resident = this.validateResident();
    return { matches: resident.matches, series: resident.series };
  }

  private quarantineStored(table: "matches" | "series", id: string, error: string, payload: unknown): void {
    const source = `sqlite:${table}`;
    this.transaction(() => {
      this.db.prepare(`UPDATE ${table} SET load_status = 'quarantined', load_error = ? WHERE id = ?`).run(error, id);
      this.db.prepare(`
        INSERT INTO quarantine (created_at, source, error, payload_json, record_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source, record_id) WHERE record_id IS NOT NULL DO NOTHING
      `).run(new Date().toISOString(), source, error, JSON.stringify(payload), id);
    });
    this.restrict();
  }

  addQuarantine(source: string, error: string | undefined, payload: unknown, recordId?: string): void {
    this.db.prepare(`
      INSERT INTO quarantine (created_at, source, error, payload_json, record_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, record_id) WHERE record_id IS NOT NULL DO NOTHING
    `).run(new Date().toISOString(), source, error ?? null, JSON.stringify(payload), recordId ?? null);
  }

  countQuarantine(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM quarantine").get() as { count: number }).count;
  }

  recordLegacyImport(receipt: LegacyImportReceipt): void {
    this.db.prepare(`
      INSERT INTO legacy_imports (source_path, source_sha256, store_version, state, manifest_path, imported_at, match_count, series_count, quarantined)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        source_sha256 = excluded.source_sha256, store_version = excluded.store_version, state = excluded.state,
        manifest_path = excluded.manifest_path, imported_at = excluded.imported_at,
        match_count = excluded.match_count, series_count = excluded.series_count, quarantined = excluded.quarantined
    `).run(receipt.sourcePath, receipt.sourceSha256, receipt.storeVersion, receipt.state, receipt.manifestPath, receipt.importedAt, receipt.matchCount, receipt.seriesCount, receipt.quarantined);
  }

  getLegacyImport(sourcePath: string): LegacyImportReceipt | undefined {
    const row = this.db.prepare("SELECT source_path, source_sha256, store_version, state, manifest_path, imported_at, match_count, series_count, quarantined FROM legacy_imports WHERE source_path = ?").get(sourcePath) as
      { source_path: string; source_sha256: string; store_version: number; state: string; manifest_path: string; imported_at: string; match_count: number; series_count: number; quarantined: number } | undefined;
    if (!row) return undefined;
    return {
      sourcePath: row.source_path, sourceSha256: row.source_sha256, storeVersion: row.store_version, state: row.state,
      manifestPath: row.manifest_path, importedAt: row.imported_at, matchCount: row.match_count, seriesCount: row.series_count, quarantined: row.quarantined,
    };
  }

  /** Bounded history query used by the history/experiment index. */
  queryMatches(filter: {
    gameId?: string; gameVersion?: string; status?: string; seriesId?: string; resultKind?: string;
    model?: string; provider?: string; qualified?: boolean; since?: string; until?: string; limit?: number; offset?: number;
  } = {}): { total: number; matches: MatchRecord[] } {
    const clauses: string[] = ["m.load_status = 'accepted'"];
    const params: Array<string | number> = [];
    if (filter.gameId) { clauses.push("m.game_id = ?"); params.push(filter.gameId); }
    if (filter.gameVersion) { clauses.push("m.game_version = ?"); params.push(filter.gameVersion); }
    if (filter.status) { clauses.push("m.status = ?"); params.push(filter.status); }
    if (filter.seriesId) { clauses.push("m.series_id = ?"); params.push(filter.seriesId); }
    if (filter.resultKind) { clauses.push("m.result_kind = ?"); params.push(filter.resultKind); }
    if (filter.since) { clauses.push("m.created_at >= ?"); params.push(filter.since); }
    if (filter.until) { clauses.push("m.created_at <= ?"); params.push(filter.until); }
    if (typeof filter.qualified === "boolean") { clauses.push("m.qualified = ?"); params.push(filter.qualified ? 1 : 0); }
    if (filter.model) { clauses.push("EXISTS (SELECT 1 FROM match_participants p WHERE p.match_id = m.id AND (p.model = ? OR p.resolved_model = ?))"); params.push(filter.model, filter.model); }
    if (filter.provider) { clauses.push("EXISTS (SELECT 1 FROM match_participants p WHERE p.match_id = m.id AND p.provider = ?)"); params.push(filter.provider); }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM matches m ${where}`).get(...params) as { count: number }).count;
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.db.prepare(`SELECT m.id, m.record_json FROM matches m ${where} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<{ id: string; record_json: string }>;
    return { total, matches: rows.flatMap((row) => { const match = this.acceptMatch(row.id, row.record_json); return match ? [match] : []; }) };
  }

  close(): void {
    this.db.close();
  }
}
