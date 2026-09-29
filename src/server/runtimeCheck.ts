const MINIMUM: readonly number[] = [22, 13, 0];

/** True when `version` is Node.js 22.13.0 or newer. */
export function runtimeSatisfies(version: string): boolean {
  const parts = version.split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < MINIMUM.length; index += 1) {
    const actual = parts[index] ?? 0;
    const required = MINIMUM[index] ?? 0;
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
}

export function assertSupportedRuntime(): void {
  if (runtimeSatisfies(process.versions.node)) return;
  console.error(`Agent Battle requires Node.js 22.13.0 or newer because it uses the built-in node:sqlite module. This process is Node.js ${process.versions.node}.`);
  process.exit(1);
}
