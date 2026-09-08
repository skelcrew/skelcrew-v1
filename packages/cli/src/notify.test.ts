import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify, selectNotifier } from "./notify";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skc-notify-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A directory holding executables (or non-executables) by name, to put on a fake PATH. */
function binDir(name: string, files: Record<string, number>): string {
  const bin = join(dir, name);
  mkdirSync(bin);
  for (const [file, mode] of Object.entries(files)) {
    writeFileSync(join(bin, file), "#!/bin/sh\nexit 0\n", { mode });
  }
  return bin;
}

test("SKELCREW_NOTIFY wins on every platform and receives title and text as arguments", () => {
  const bin = binDir("with-osascript", { osascript: 0o755 });
  for (const platform of ["darwin", "linux"]) {
    const notifier = selectNotifier({ SKELCREW_NOTIFY: "/x/record.sh", PATH: bin }, platform);
    expect(notifier.name).toBe("custom");
    expect(notifier.argv?.("skelcrew", "#1 T: note")).toEqual([
      "/x/record.sh",
      "skelcrew",
      "#1 T: note",
    ]);
  }
});

test("on macOS osascript on PATH is selected, with the text and title escaped into AppleScript", () => {
  const bin = binDir("mac", { osascript: 0o755 });
  const notifier = selectNotifier({ PATH: `${dir}/nowhere:${bin}` }, "darwin");
  expect(notifier.name).toBe("osascript");
  expect(notifier.argv?.("skelcrew", 'a "quoted" \\ note')).toEqual([
    join(bin, "osascript"),
    "-e",
    'display notification "a \\"quoted\\" \\\\ note" with title "skelcrew"',
  ]);
});

test("notify-send on PATH is selected where osascript is not the platform's", () => {
  const bin = binDir("linux", { "notify-send": 0o755, osascript: 0o755 });
  const notifier = selectNotifier({ PATH: bin }, "linux");
  expect(notifier.name).toBe("notify-send");
  expect(notifier.argv?.("skelcrew", "text")).toEqual([
    join(bin, "notify-send"),
    "skelcrew",
    "text",
  ]);
});

test("on macOS without osascript, notify-send is used if present", () => {
  const bin = binDir("mac-nosend", { "notify-send": 0o755 });
  expect(selectNotifier({ PATH: bin }, "darwin").name).toBe("notify-send");
});

test("with neither present, or nothing executable, or no PATH, the notifier prints", () => {
  const empty = binDir("empty", {});
  expect(selectNotifier({ PATH: empty }, "darwin").name).toBe("print");
  expect(selectNotifier({ PATH: empty }, "linux").name).toBe("print");
  const notExecutable = binDir("plain", { osascript: 0o644, "notify-send": 0o644 });
  expect(selectNotifier({ PATH: notExecutable }, "darwin").name).toBe("print");
  expect(selectNotifier({}, "darwin").name).toBe("print");
  expect(selectNotifier({ PATH: "" }, "linux").name).toBe("print");
  expect(selectNotifier({ SKELCREW_NOTIFY: "", PATH: empty }, "darwin").name).toBe("print");
});

test("the print notifier writes one marked line carrying the title and text, and runs nothing", async () => {
  const printed: string[] = [];
  const notifier = selectNotifier({ PATH: binDir("none", {}) }, "linux");
  await notify(notifier, "skelcrew", "#1 Title: note", (line) => printed.push(line));
  expect(printed).toHaveLength(1);
  expect(printed[0]).toContain("skelcrew");
  expect(printed[0]).toContain("#1 Title: note");
  expect(printed[0]?.startsWith("#1")).toBe(false);
});
