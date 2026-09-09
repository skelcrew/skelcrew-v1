import type { Core } from "./core/core";

/**
 * One tick of the daemon's claim sweep. An exception inside a timer callback would take
 * the process down without its shutdown path (Bun 1.3.14 exits 1, leaving the socket
 * file behind), so the failure is reported on stderr and the timer keeps running.
 */
export function sweepTick(core: Pick<Core, "sweepClaims">, warn: (line: string) => void): void {
  try {
    core.sweepClaims();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`skelcrew daemon: sweep failed: ${message}`);
  }
}
