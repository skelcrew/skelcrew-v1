import { expect, test } from "bun:test";
import { sweepTick } from "./sweep";

test("a sweep that succeeds writes nothing", () => {
  const lines: string[] = [];
  let calls = 0;
  sweepTick(
    {
      sweepClaims() {
        calls += 1;
        return [];
      },
    },
    (line) => lines.push(line),
  );
  expect(calls).toBe(1);
  expect(lines).toEqual([]);
});

/**
 * 024: which member's claims are runs is the daemon's fact, not the core's, so the tick carries
 * the runner's id down to the sweep. A daemon with no runner passes nothing, and the sweep then
 * withdraws no request.
 */
test("a sweep passes the runner's member id on, and nothing when there is no runner", () => {
  const seen: (number | undefined)[] = [];
  const core = {
    sweepClaims(runnerId?: number): number[] {
      seen.push(runnerId);
      return [];
    },
  };
  sweepTick(core, () => {}, 7);
  sweepTick(core, () => {});
  expect(seen).toEqual([7, undefined]);
});

test("a sweep that throws does not propagate; the error is one line on stderr", () => {
  const lines: string[] = [];
  const core = {
    sweepClaims(): number[] {
      throw new Error("database is locked");
    },
  };
  expect(() => sweepTick(core, (line) => lines.push(line))).not.toThrow();
  expect(lines).toEqual(["skelcrew daemon: sweep failed: database is locked"]);

  // A non-Error throw is reported too, and the next tick still runs.
  const again = {
    sweepClaims(): number[] {
      throw "boom";
    },
  };
  sweepTick(again, (line) => lines.push(line));
  expect(lines).toEqual([
    "skelcrew daemon: sweep failed: database is locked",
    "skelcrew daemon: sweep failed: boom",
  ]);
});
