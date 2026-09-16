import { expect, test } from "bun:test";
import { nothingNeedsTheDaemon } from "./idle";

test("nothing needs the daemon once a client has been and gone, with no run left", () => {
  expect(nothingNeedsTheDaemon({ clients: 0, clientsEver: 1, runs: 0 })).toBe(true);
  // A client is looking at it.
  expect(nothingNeedsTheDaemon({ clients: 1, clientsEver: 1, runs: 0 })).toBe(false);
  // The screen closed over a run in flight: the run is what it is still here for.
  expect(nothingNeedsTheDaemon({ clients: 0, clientsEver: 1, runs: 1 })).toBe(false);
  expect(nothingNeedsTheDaemon({ clients: 2, clientsEver: 5, runs: 3 })).toBe(false);
});

/**
 * A daemon still coming up must not decide nothing needs it: the screen starts one and then
 * waits for it to answer, so a client is on its way. Until it arrives — and whatever the daemon
 * did in the meantime, including a run it took from the queue and finished — the daemon stays.
 */
test("a daemon no client has reached yet is needed, even with nothing running", () => {
  expect(nothingNeedsTheDaemon({ clients: 0, clientsEver: 0, runs: 0 })).toBe(false);
  expect(nothingNeedsTheDaemon({ clients: 0, clientsEver: 0, runs: 1 })).toBe(false);
});
