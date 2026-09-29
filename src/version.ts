/**
 * Single source of truth for every durable protocol and format version.
 *
 * Documentation previously drifted because the same value was written in more
 * than one place (for example "adapter-v6" in code but "Adapter v5" in the
 * protocol document). Import these constants instead of repeating literals.
 */
export const APP_VERSION = "0.1.0";

/** Version of the legacy JSON envelope at `data/matches.json`. Read-only import source. */
export const JSON_STORE_VERSION = 7;

/** Version of the SQLite schema owned by `src/server/persistence`. */
export const DATABASE_SCHEMA_VERSION = 1;

/** Version of the SQLite file name inside the configured data directory. */
export const DATABASE_FILE_NAME = "agent-battle.sqlite";

export const ADAPTER_VERSION = "agent-battle/adapter-v6";
export const OBSERVATION_PROTOCOL_VERSION = "observation-contract-v3";
export const ACTION_PROTOCOL_VERSION = "game-action-v1";
export const EXECUTION_EVIDENCE_VERSION = "execution-evidence-1";
