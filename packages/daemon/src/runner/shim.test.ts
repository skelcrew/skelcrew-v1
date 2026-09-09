import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { VERSION } from "@skelcrew/shared";
import { agentEnvironment, CLI_MAIN, shimDir, writeShim } from "./shim";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sks-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("the shim is written under <data dir>/bin, executable, running the CLI's main.ts with this daemon's own bun", () => {
  const path = writeShim(dataDir);
  expect(path).toBe(join(dataDir, "bin", "skelcrew"));
  expect(shimDir(dataDir)).toBe(join(dataDir, "bin"));
  expect(statSync(path).mode & 0o111).toBe(0o111);
  expect(existsSync(CLI_MAIN)).toBe(true);
  expect(CLI_MAIN.endsWith(join("packages", "cli", "src", "main.ts"))).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(
    `#!/bin/sh\nexec '${process.execPath}' '${CLI_MAIN}' "$@"\n`,
  );
});

test("written once: a second call leaves an identical shim untouched", () => {
  const path = writeShim(dataDir);
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
  const before = statSync(path).mtimeMs;
  expect(writeShim(dataDir)).toBe(path);
  expect(statSync(path).mtimeMs).toBe(before);
});

test("a shim pointing elsewhere is rewritten", () => {
  const path = writeShim(dataDir, "/elsewhere/main.ts");
  expect(readFileSync(path, "utf8")).toContain("/elsewhere/main.ts");
  writeShim(dataDir);
  expect(readFileSync(path, "utf8")).toContain(CLI_MAIN);
});

test("running the shim with --version prints the CLI's version, even with no bun on PATH", async () => {
  const path = writeShim(dataDir);
  const proc = Bun.spawn([path, "--version"], {
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  expect({ code, stderr, stdout }).toEqual({
    code: 0,
    stderr: "",
    stdout: `skelcrew ${VERSION}\n`,
  });
});

test("the agent's environment: shim first on PATH, speaking as runner, pointed at the data dir", () => {
  const env = agentEnvironment(
    { PATH: "/usr/bin:/bin", HOME: "/home/x", GONE: undefined },
    dataDir,
  );
  expect(env).toEqual({
    PATH: `${join(dataDir, "bin")}${delimiter}/usr/bin:/bin`,
    HOME: "/home/x",
    SKELCREW_AS: "runner",
    SKELCREW_DIR: dataDir,
  });
  expect(agentEnvironment({}, dataDir).PATH).toBe(join(dataDir, "bin"));
  // The runner's own variables win over whatever the daemon was started with.
  expect(agentEnvironment({ SKELCREW_AS: "me", SKELCREW_DIR: "/x" }, dataDir)).toMatchObject({
    SKELCREW_AS: "runner",
    SKELCREW_DIR: dataDir,
  });
});
