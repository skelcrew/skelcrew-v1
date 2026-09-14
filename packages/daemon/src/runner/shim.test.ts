import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { VERSION } from "@skelcrew/shared";
import { agentEnvironment, INHERITED_VARIABLES, shimDir, writeShim } from "./shim";

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

/**
 * 021 supersedes criterion 13 of 012, which read "the spawned agent's environment is exactly
 * `PATH` (with the shim's directory first), `HOME`, `SKELCREW_AS` and `SKELCREW_DIR`" — and
 * this case pinned that sentence. It was too narrow to log in with: on macOS the harness reads
 * its `claude login` out of the Keychain under the user's name, so a run with `HOME` alone ended
 * at `Not logged in · Please run /login`, and an owner authenticating with a key in their shell
 * had no path at all. The environment is still a fixed short list rather than a passthrough:
 * `INHERITED_VARIABLES` is copied verbatim when the daemon has it, and everything else — a
 * `SECRET`, an `AWS_PROFILE`, an exported `SKELCREW_AS` — is dropped as before.
 */
test("the spawned environment is PATH, HOME, the inherited login variables, and the two skelcrew ones", () => {
  const login = {
    USER: "simon",
    LOGNAME: "simon",
    ANTHROPIC_API_KEY: "sk-ant-key",
    ANTHROPIC_AUTH_TOKEN: "token",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    ANTHROPIC_BASE_URL: "https://proxy.invalid",
    CLAUDE_CONFIG_DIR: "/home/simon/elsewhere",
  };
  expect(Object.keys(login).toSorted()).toEqual([...INHERITED_VARIABLES].toSorted());
  const env = agentEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/home/simon",
      ...login,
      SECRET: "s",
      AWS_PROFILE: "work",
      SKELCREW_AS: "someone",
    },
    dir,
    "crew",
  );
  expect(env).toEqual({
    PATH: `${shimDir(dir)}${delimiter}/usr/bin`,
    HOME: "/home/simon",
    ...login,
    SKELCREW_AS: "crew",
    SKELCREW_DIR: dir,
  });
});

/** A variable the daemon does not have is absent from the agent's, not invented as empty. */
test("a login variable the daemon's environment lacks is not passed on as an empty string", () => {
  const env = agentEnvironment({ PATH: "/usr/bin", HOME: "/home/simon" }, dir, "crew");
  for (const name of INHERITED_VARIABLES) expect([name, name in env]).toEqual([name, false]);
  expect(env).toEqual({
    PATH: `${shimDir(dir)}${delimiter}/usr/bin`,
    HOME: "/home/simon",
    SKELCREW_AS: "crew",
    SKELCREW_DIR: dir,
  });
});

/**
 * Review round 1, Minor 2. An exported-but-empty variable is the same thing as an unset one for
 * a login: `ANTHROPIC_API_KEY=` left in a shell profile is not a key, and handing the harness an
 * empty one is handing it a login that cannot work while looking like a login that could. `PATH`
 * has always read `""` as absent; the copied variables read it the same way.
 */
test("a login variable the daemon exported empty is absent too, not passed on as an empty string", () => {
  const env = agentEnvironment(
    { PATH: "/usr/bin", HOME: "/home/simon", ANTHROPIC_API_KEY: "", USER: "" },
    dir,
    "crew",
  );
  expect([...INHERITED_VARIABLES].filter((name) => name in env)).toEqual([]);
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
