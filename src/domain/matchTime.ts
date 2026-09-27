import type { MatchRecord } from "../shared.js";

/** Legacy records have no timer ledger and retain their original creation-age limit. */
export function elapsedMatchMs(match: MatchRecord, now = Date.now()): number {
  const timer = match.timeAccounting;
  if (!timer) return Math.max(0, now - Date.parse(match.createdAt));
  return timer.elapsedMs + (timer.runningSince ? Math.max(0, now - Date.parse(timer.runningSince)) : 0);
}

export function remainingMatchMs(match: MatchRecord, now = Date.now()): number {
  return match.settings.budgets.maxWallMinutes * 60_000 - elapsedMatchMs(match, now);
}

export function beginMatchTime(match: MatchRecord, now = Date.now()): void {
  if (match.timeAccounting && !match.timeAccounting.runningSince) {
    match.timeAccounting.runningSince = new Date(now).toISOString();
  }
}

export function endMatchTime(match: MatchRecord, now = Date.now()): void {
  const timer = match.timeAccounting;
  if (!timer?.runningSince) return;
  timer.elapsedMs = elapsedMatchMs(match, now);
  timer.runningSince = undefined;
}
