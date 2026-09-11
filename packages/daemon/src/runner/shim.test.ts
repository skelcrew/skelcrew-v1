import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { VERSION } from "@skelcrew/shared";
import { agentEnvironment, shimDir, writeShim } from "./shim";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "skr-shim-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("the shim is written executable under <data dir>/bin and runs with no bun on PATH", async () => {
  const path = writeShim(dir);
  expect(path).toBe(join(shimDir(dir), "skelcrew"));
  expect(statSync(path).mode & 0o111).toBe(0o111);

  // A PATH with nothing on it: the shim must reach this daemon's own runtime by itself.
  const empty = join(dir, "empty");
  mkdirSync(empty);
  const proc = Bun.spawn([path, "--version"], {
    env: { PATH: empty, HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  expect([code, err]).toEqual([0, ""]);
  expect(out.trim()).toBe(`skelcrew ${VERSION}`);
});

test("writing the shim twice leaves one working shim", async () => {
  writeShim(dir);
  const path = writeShim(dir);
  const proc = Bun.spawn([path, "--version"], { env: { PATH: "", HOME: dir }, stdout: "pipe" });
  expect(await proc.exited).toBe(0);
});

test("the spawned environment is exactly PATH, HOME, SKELCREW_AS and SKELCREW_DIR", () => {
  const env = agentEnvironment(
    { PATH: "/usr/bin", HOME: "/home/simon", SECRET: "s", SKELCREW_AS: "someone" },
    dir,
    "crew",
  );
  expect(env).toEqual({
    PATH: `${shimDir(dir)}${delimiter}/usr/bin`,
    HOME: "/home/simon",
    SKELCREW_AS: "crew",
    SKELCREW_DIR: dir,
  });
});

test("with no PATH to inherit the shim's directory is the whole PATH, and an absent HOME is not invented", () => {
  expect(agentEnvironment({}, dir, "crew")).toEqual({
    PATH: shimDir(dir),
    SKELCREW_AS: "crew",
    SKELCREW_DIR: dir,
  });
});

/**
 * 016: the agent speaks as a member of its own, so the name is the caller's to choose rather
 * than this module's to know — and what it is for is that the claim's holder and the agent's
 * identity are two members.
 */
test("the member the agent speaks as is the one it was given", () => {
  expect(agentEnvironment({}, dir, "someone-else").SKELCREW_AS).toBe("someone-else");
});
