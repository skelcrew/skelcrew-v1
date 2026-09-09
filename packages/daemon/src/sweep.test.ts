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
