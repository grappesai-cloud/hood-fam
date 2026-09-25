/// One line, one timestamp, one loop name. Everything the keeper says goes through here so the
/// container log can be grepped by loop.
export function log(loop: string, message: string) {
  console.log(`${new Date().toISOString()} [${loop}] ${message}`);
}

export function logError(loop: string, message: string) {
  console.error(`${new Date().toISOString()} [${loop}] ${message}`);
}

/// A heartbeat is the counts a loop iteration produced, in one line.
export function heartbeat(loop: string, ms: number, counts: Record<string, number | string | undefined>) {
  const parts = Object.entries(counts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  log(loop, `heartbeat ${parts.join(" ")} ${ms}ms`);
}
