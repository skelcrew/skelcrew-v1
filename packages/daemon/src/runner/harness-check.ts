/**
 * `bun run check:harness`: every command the playbooks instruct, put through the harness that
 * runs them — the pinned binary itself, not `allowlist.ts`'s model of it — to answer the one
 * question a model cannot be trusted with: does this command stop to ask?
 *
 * Review round 1 of 014 found the Code playbook prescribing a command the harness asks about
 * outright, and nothing in the repository could have caught it: the model in `allowlist.ts` is
 * deliberately *looser* than the harness about compound commands, and "this runs unprompted" is
 * exactly the claim a loose model cannot make. This runs the claim.
 *
 * **It calls no model.** A `Bun.serve` on `127.0.0.1` plays the Messages API: it answers the
 * harness's prompt with one `Bash` tool call carrying the command under test, and ends the turn
 * when the tool result comes back. The harness is pointed at it with `ANTHROPIC_BASE_URL` and a
 * dummy key, under an empty `HOME`, with `settingSources: []` and non-essential traffic off, so
 * the owner's login is not in reach and no request has anywhere to go but the stub. Every
 * command word lands on a stub executable that exits 0 and prints nothing: what is under test
 * is whether a command *would ask*, never what it would do.
 *
 * Not part of `bun run check` — the trigger is a playbook change or the SDK version pin
 * failing — and not collected by `bun test`, which is what the file name is for.
 *
 * The SDK warns on stderr once per session that `canUseTool` will not be invoked for the bare
 * entries on the list (`Read`, `Glob`, `Grep`, `Agent`, `TodoWrite`) because a bare name
 * auto-approves the whole tool. That is the divergence `allowlist.ts` records rather than news,
 * and it is left on the output: silencing the harness's own warnings in the one check that
 * exists to hear them would be the wrong trade.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunOptions } from "./agent";
import { allowlistFor } from "./allowlist";
import { buildSdkOptions } from "./claude";
import { createGit } from "./git";
import { instructedCommands } from "./playbook-commands";
import { loadPlaybooks, PLAYBOOK_PHASES } from "./playbooks";
import { agentEnvironment } from "./shim";

/**
 * The command that must ask, on every run. 013 names it as the example of what the owner's own
 * gate holds back, and it is on no list. A check that cannot fail is decoration; this is how
 * this one proves its teeth each time it runs.
 */
export const CONTROL_COMMAND = "git push origin HEAD:main";

/**
 * The command the temporary repository's `AGENTS.md` fences, and so the one the scan pre-allows.
 * It is under test with the playbooks' own commands because the scanned entry is built by a
 * different rule from the fixed list — the grant is the *target repository's* — and nothing else
 * here would exercise it.
 */
const SCANNED_COMMAND = "bun run check";

/** The key the harness is given. Not a credential — the stub accepts anything. */
export const STUB_API_KEY = "skelcrew-harness-check-not-a-real-key";

/** The system directories the shell needs, and nothing from the owner's environment. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);

/** How long one session may take before the check gives up on it. */
const SESSION_TIMEOUT_MS = 120_000;

export interface StubRequest {
  method: string;
  path: string;
  /** The credential the harness presented, if any: what proves whose key it used. */
  apiKey?: string;
}

export interface StubModel {
  /** `http://127.0.0.1:<port>`, and nothing is listening anywhere else. */
  url: string;
  /** Every request the stub received, in order. */
  requests: StubRequest[];
  stop(): void;
}

/** One SSE frame, in the shape the Messages API streams them. */
function frame(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

function messageStart(id: string, model: string): string {
  return frame("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

function messageEnd(stopReason: string): string {
  return (
    frame("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    }) + frame("message_stop", {})
  );
}

/** The turn that puts the command under test in front of the harness. */
function toolUseTurn(model: string, command: string): string {
  return (
    messageStart("msg_harness_check_tool_use", model) +
    frame("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: "toolu_harness_check", name: "Bash", input: {} },
    }) +
    frame("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) },
    }) +
    frame("content_block_stop", { index: 0 }) +
    messageEnd("tool_use")
  );
}

/** The turn that ends the session once the harness has said what it did with the command. */
function textTurn(model: string): string {
  return (
    messageStart("msg_harness_check_text", model) +
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }) +
    frame("content_block_stop", { index: 0 }) +
    messageEnd("end_turn")
  );
}

/**
 * The stub that plays the model for one command: a prompt gets the command as a `Bash` call,
 * and a turn carrying a tool result gets a plain text end. Bound to the loopback address with
 * an ephemeral port, and it records every request, so a harness that reached something other
 * than this is visible as a session the stub never saw.
 */
export function startStubModel(command: string): StubModel {
  const requests: StubRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      const apiKey = request.headers.get("x-api-key") ?? undefined;
      requests.push(
        apiKey === undefined
          ? { method: request.method, path: url.pathname }
          : { method: request.method, path: url.pathname, apiKey },
      );
      if (url.pathname !== "/v1/messages") {
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }
      const model = (JSON.parse(body) as { model?: string }).model ?? "stub-model";
      const answered = body.includes('"tool_result"')
        ? textTurn(model)
        : toolUseTurn(model, command);
      return new Response(answered, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => {
      server.stop(true);
    },
  };
}

/**
 * An executable for every command word, exiting 0 and printing nothing. The question the check
 * asks is "would this ask", not "what would this do": the command's effect is not under test
 * and must not happen — so `git push` pushes nothing, `gh pr create` opens nothing, and
 * `skelcrew mv` reaches no daemon. Returns the words it wrote, which is the set the commands
 * begin with.
 */
export function writeStubExecutables(dir: string, commands: readonly string[]): string[] {
  mkdirSync(dir, { recursive: true });
  const words = [...new Set(commands.map((command) => command.trim().split(/\s+/)[0] as string))];
  for (const word of words) {
    writeFileSync(join(dir, word), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return words;
}

export interface CommandOutcome {
  command: string;
  /** The command reached a tool result: the harness let it run. */
  executed: boolean;
  /** What the harness denied, from the result's `permission_denials`, with its own reason. */
  denials: Array<{ tool: string; reason: string }>;
  /** How many requests the stub saw during this session. Zero is a failed check. */
  requests: number;
  /** How many times `canUseTool` was reached. Any is a failed check. */
  canUseToolCalls: number;
  /** Every credential the harness presented to the stub. Anything but the dummy is a failure. */
  credentials: string[];
}

/**
 * What is wrong with a run of the check, one line each; empty means it passed. Every condition
 * here is a way the check could otherwise pass while proving nothing — a command denied, the
 * control command *not* denied, a session that never reached the stub, a `canUseTool` call
 * (under `dontAsk` a prompt is a denial, so reaching the callback means the mode was not
 * honoured), or a session that neither ran the command nor denied it.
 */
export function problemsIn(outcomes: readonly CommandOutcome[]): string[] {
  const problems: string[] = [];
  const control = outcomes.find((outcome) => outcome.command === CONTROL_COMMAND);
  for (const outcome of outcomes) {
    const at = `\`${outcome.command}\``;
    if (outcome.requests === 0) {
      problems.push(`${at}: the stub saw no request — the harness reached something else`);
      continue;
    }
    if (outcome.canUseToolCalls > 0) {
      problems.push(`${at}: reached canUseTool ${outcome.canUseToolCalls} time(s) under dontAsk`);
      continue;
    }
    const foreign = outcome.credentials.filter((key) => key !== STUB_API_KEY).length;
    if (foreign > 0) {
      // Never the key itself: the check's output is not where a credential belongs.
      problems.push(`${at}: the harness presented ${foreign} credential(s) that are not the dummy`);
      continue;
    }
    if (outcome === control) continue;
    if (outcome.denials.length > 0) {
      const reasons = outcome.denials.map((denial) => `${denial.tool}: ${denial.reason}`);
      problems.push(`${at} is denied by the harness — ${reasons.join("; ")}`);
      continue;
    }
    if (!outcome.executed) problems.push(`${at}: the harness neither ran it nor denied it`);
  }
  if (control === undefined) {
    problems.push(
      `the control command \`${CONTROL_COMMAND}\` was not run: the check proves nothing`,
    );
  } else if (control.denials.length === 0) {
    problems.push(
      `the control command \`${CONTROL_COMMAND}\` was not denied: the check cannot fail, so it proves nothing`,
    );
  }
  return problems;
}

/** The harness's own words for why it refused, by the tool call it refused. */
type Reasons = Map<string, string>;

function reasonFor(reasons: Reasons, toolUseId: string): string {
  return reasons.get(toolUseId) ?? "no reason reported";
}

/** One user message, then nothing: the session ends on its result, not on its input. */
async function* onePrompt(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    message: { role: "user", content: "Run the command." },
    parent_tool_use_id: null,
  };
  await new Promise<never>(() => {});
}

interface RunContext {
  cwd: string;
  env: Record<string, string>;
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * One harness session for one command, through the run's own option builder. Four things are
 * overridden and no more, exactly as 017 names them: `permissionMode` is `dontAsk`, `env` gains
 * the stub's `ANTHROPIC_BASE_URL` and a dummy `ANTHROPIC_API_KEY`, `HOME` is a temporary
 * directory and `PATH` begins with the stub executables — the last three are in `context.env`,
 * built once by `main`. Everything else is what a real run is given.
 */
async function runCommand(command: string, context: RunContext): Promise<CommandOutcome> {
  const stub = startStubModel(command);
  let canUseToolCalls = 0;
  let executed = false;
  const reasons: Reasons = new Map();
  const denials: CommandOutcome["denials"] = [];
  const options: AgentRunOptions = {
    cwd: context.cwd,
    env: { ...context.env, ANTHROPIC_BASE_URL: stub.url },
    systemPrompt: "Run the command you are given.",
    allowedTools: context.allowedTools,
    disallowedTools: context.disallowedTools,
    canUseTool: async () => {
      canUseToolCalls += 1;
      return { behavior: "deny", message: "canUseTool must not be reached under dontAsk" };
    },
    // The driver's three, which the option builder does not read: the prompt is passed to
    // `query` below, and nothing here is logged or aborted from outside.
    input: (async function* () {})(),
    log: () => {},
    signal: new AbortController().signal,
  };
  const { sdkOptions, abortController } = buildSdkOptions(options);
  const session = query({
    prompt: onePrompt(),
    options: { ...sdkOptions, permissionMode: "dontAsk" },
  });
  const timer = setTimeout(() => {
    abortController.abort();
    session.close();
  }, SESSION_TIMEOUT_MS);
  try {
    for await (const message of session as AsyncIterable<SDKMessage>) {
      if (message.type === "system" && message.subtype === "permission_denied") {
        reasons.set(message.tool_use_id, message.decision_reason ?? message.message);
      }
      if (message.type === "user") {
        const content = (message.message as { content?: unknown }).content;
        if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) {
          executed = true;
        }
      }
      if (message.type === "result") {
        for (const denial of message.permission_denials) {
          denials.push({ tool: denial.tool_name, reason: reasonFor(reasons, denial.tool_use_id) });
        }
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    session.close();
    stub.stop();
  }
  const credentials = [
    ...new Set(
      stub.requests
        .map((request) => request.apiKey)
        .filter((apiKey): apiKey is string => apiKey !== undefined),
    ),
  ];
  return {
    command,
    executed,
    denials,
    requests: stub.requests.length,
    canUseToolCalls,
    credentials,
  };
}

/** `git` in a directory, for the temporary repository this check builds. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
}

/**
 * A repository the scanned entry can be exercised against: one commit, an `AGENTS.md` fencing
 * `bun run check`, and the remote-tracking head the scan reads from.
 */
async function temporaryRepository(root: string): Promise<void> {
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "harness-check@skelcrew.invalid");
  await git(root, "config", "user.name", "harness check");
  writeFileSync(
    join(root, "AGENTS.md"),
    `# A repository\n\nRun the checks with:\n\n\`\`\`\n${SCANNED_COMMAND}\n\`\`\`\n`,
  );
  await git(root, "add", "AGENTS.md");
  await git(root, "commit", "-m", "the repository's own instructions");
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
}

async function main(): Promise<number> {
  const playbooks = loadPlaybooks();
  const prescribedCommands = [
    ...new Set([
      ...PLAYBOOK_PHASES.flatMap((phase) => instructedCommands(playbooks[phase])),
      SCANNED_COMMAND,
    ]),
  ];
  const commands = [...prescribedCommands, CONTROL_COMMAND];

  const scratch = mkdtempSync(join(tmpdir(), "skelcrew-harness-check-"));
  const repoRoot = join(scratch, "repo");
  const worktree = join(scratch, "worktree");
  const home = join(scratch, "home");
  const dataDir = join(scratch, "data");
  const binDir = join(scratch, "bin");
  for (const dir of [repoRoot, home, dataDir]) mkdirSync(dir, { recursive: true });

  try {
    await temporaryRepository(repoRoot);
    await git(repoRoot, "branch", "card-1", "main");
    await git(repoRoot, "worktree", "add", worktree, "card-1");
    const allowlist = await allowlistFor(createGit(), repoRoot, "main", worktree);
    const words = writeStubExecutables(binDir, commands);

    // The run's own environment, with the three overrides that are environment: `HOME` is this
    // temporary directory, `PATH` begins with the stub executables, and the harness is pointed
    // at the stub with a dummy key. The owner's environment contributes nothing — `env` replaces
    // `process.env` for the spawned harness rather than extending it.
    const env = agentEnvironment({ PATH: SYSTEM_PATH, HOME: home }, dataDir, "crew");
    env.PATH = `${binDir}${delimiter}${env.PATH}`;
    env.ANTHROPIC_API_KEY = STUB_API_KEY;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

    console.log(`playbooks: ${PLAYBOOK_PHASES.join(", ")}`);
    console.log(
      `commands: ${prescribedCommands.length} prescribed (the playbooks' own, and the ` +
        `repository's fenced \`${SCANNED_COMMAND}\`), plus the control command`,
    );
    console.log(`allowlist: ${allowlist.scanned}`);
    console.log(`stub executables: ${words.join(", ")}`);
    console.log(`PATH: ${env.PATH}`);
    console.log(`HOME: ${home}, holding ${readdirSync(home).length} files`);
    console.log(
      `the harness's environment: ${Object.keys(env).toSorted().join(", ")}, and the stub's ` +
        "ANTHROPIC_BASE_URL, which is a fresh loopback port per session",
    );
    console.log(
      `ANTHROPIC_API_KEY: the dummy key; the owner's is ${
        process.env.ANTHROPIC_API_KEY === undefined ? "unset here" : "set here and not passed on"
      }`,
    );
    console.log("");

    const outcomes: CommandOutcome[] = [];
    for (const command of commands) {
      const outcome = await runCommand(command, {
        cwd: worktree,
        env,
        allowedTools: allowlist.tools,
        disallowedTools: allowlist.denied,
      });
      outcomes.push(outcome);
      // The harness's own words for a refusal, on the line that reports it: a denial with no
      // reason behind it would otherwise look the same as one the harness explained.
      const said = outcome.denials.map((denial) => denial.reason.split(".")[0]).join("; ");
      console.log(
        outcome.denials.length > 0 ? `DENIED  ${command} — ${said}` : `ran     ${command}`,
      );
    }

    const problems = problemsIn(outcomes);
    const changed = [
      ...(await git(worktree, "status", "--porcelain")).split("\n"),
      ...(await git(repoRoot, "status", "--porcelain")).split("\n"),
    ].filter((line) => line.trim().length > 0);
    if (changed.length > 0) {
      problems.push(`the temporary repository changed: ${changed.join(", ")}`);
    }

    console.log("");
    if (problems.length === 0) {
      console.log(
        `every one of the ${prescribedCommands.length} commands under test runs unprompted in ` +
          `the harness, \`${CONTROL_COMMAND}\` is denied, and the repository is unchanged`,
      );
      return 0;
    }
    for (const problem of problems) console.log(`FAIL ${problem}`);
    return 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main());
