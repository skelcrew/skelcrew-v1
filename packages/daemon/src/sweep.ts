import type { Core } from "./core/core";

/**
 * One tick of the daemon's claim sweep. An exception inside a timer callback would take
 * the process down without its shutdown path (Bun 1.3.14 exits 1, leaving the socket
 * file behind), so the failure is reported on stderr and the timer keeps running.
 *
 * `runnerId` is the member whose claims are runs, so that the sweep can take a lapsed run's own
 * question with it; a daemon with no runner passes nothing and no request is ever withdrawn.
 */
export function sweepTick(
  core: Pick<Core, "sweepClaims">,
  warn: (line: string) => void,
  runnerId?: number,
): void {
  try {
    core.sweepClaims(runnerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`skelcrew daemon: sweep failed: ${message}`);
  }
}
