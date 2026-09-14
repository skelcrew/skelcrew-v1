/**
 * `bun run check:harness`: every command the playbooks instruct, one representative command per
 * `Bash(...)` entry of the allowlist it runs under, and the fenced command a repository's own
 * instructions contribute — each put through the harness that runs them, the pinned binary itself
 * rather than `allowlist.ts`'s model of it, to answer the one question a model cannot be trusted
 * with: does this command stop to ask?
 *
 * **There are two lists and a command is only evidence about the one it ran under** (019). The
 * two claimable phases are spawned with the Code list; a review run is spawned with a list of its
 * own and deny rules of its own. So every session carries its list, and coverage — an entry with
 * no representative, a representative never run — is counted per list. See `LISTS_UNDER_TEST`.
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
 * Not part of `bun run check` — the trigger is a change to a playbook or to the fixed list, or the
 * SDK version pin failing — and not collected by `bun test`, which is what the file name is for.
 *
 * **An interrupt is a path this has to handle, not an accident.** `SIGINT` and `SIGTERM` end the
 * live session, wait for the harness to go down, and remove the scratch directory — which holds
 * the temporary repository, its registered worktree, `HOME` and the stub `PATH`. Without that, a
 * Ctrl-C left a `claude` running and a registered worktree in a temporary directory nobody would
 * look in again.
 *
 * The SDK warns on stderr once per session that `canUseTool` will not be invoked for the bare
 * entries on the list (`Read`, `Glob`, `Grep`, `Agent`, `TodoWrite`) because a bare name
 * auto-approves the whole tool. That is the divergence `allowlist.ts` records rather than news,
 * and it is left on the output: silencing the harness's own warnings in the one check that
 * exists to hear them would be the wrong trade.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunOptions } from "./agent";
import { allowlistFor, baseBranchGrants, FIXED_ALLOWLIST, REVIEW_ALLOWLIST } from "./allowlist";
import { buildSdkOptions } from "./claude";
import { createGit } from "./git";
import { FILLED_BASE, instructedCommands } from "./playbook-commands";
import { loadPlaybooks, PLAYBOOK_PHASES, type PlaybookKind, type Playbooks } from "./playbooks";
import { agentEnvironment } from "./shim";

/**
 * The command that must ask, on every run. 013 names it as the example of what the owner's own
 * gate holds back, and it is on no list. A check that cannot fail is decoration; this is how
 * this one proves its teeth each time it runs.
 *
 * It is appended to **every** list under test, not to one of them: a denial under the Code list
 * is evidence about the Code list, and a review-list session that allowed everything would
 * otherwise still pass (019, review round 2).
 */
export const CONTROL_COMMAND = "git push origin HEAD:main";

/**
 * The command the temporary repository's `AGENTS.md` fences, and so the one the scan pre-allows.
 * It is under test with the playbooks' own commands because the scanned entry is built by a
 * different rule from the fixed list — the grant is the *target repository's* — and nothing else
 * here would exercise it.
 */
const SCANNED_COMMAND = "bun run check";

/**
 * The default branch of the temporary repository, and so the name the two base-branch entries
 * are composed from (020). It is `FILLED_BASE` — the name the playbooks' `<base>` fills with —
 * and it has to be: those entries are exact, so an instructed `git fetch origin <base>` is only
 * the command the entry covers when the two names are the same string.
 */
const BASE_BRANCH = FILLED_BASE;

/**
 * One command per `Bash(...)` entry of the fixed list: a representative argument for a wildcard
 * entry, the command itself for an exact one.
 *
 * The playbooks instruct most of these in prose alone, inside the paragraph that advertises what
 * runs unprompted — which `instructedCommands()` excludes, because a test checked against a
 * *model* built from that same list would only be proving the list matches its own restatement.
 * That argument is false here, where the binary answers: `git add`, `git commit`, `gh pr create`,
 * `gh pr diff`, `gh pr comment` and `gh repo view` are what a Code run's artefact contract
 * depends on, and until review round 1 of this spec none of them was ever evaluated.
 *
 * They are arguments a playbook's agent would plausibly write, and nothing here has an effect:
 * every command word is a stub executable that exits 0.
 *
 * The last two are **exact** entries rather than wildcards (020), so their representative is the
 * entry itself — there is no argument to choose — and it is the same string the Code playbook
 * instructs once `<base>` is filled. One session covers both roles.
 */
export const FIXED_LIST_REPRESENTATIVES: readonly string[] = [
  "skelcrew show 1",
  'skelcrew comment 1 "a comment"',
  "skelcrew body 1 --file a-spec.md",
  "skelcrew refs 1 --pr https://example.invalid/pull/1",
  'skelcrew attention 1 "a question"',
  "git add -A",
  'git commit -m "a message"',
  "git push -u origin HEAD",
  "git push",
  'gh pr create --title "a title" --body "a body"',
  "gh pr view --json url --jq .url",
  "gh pr diff --name-only",
  'gh pr comment 1 --body "a comment"',
  "gh repo view --json defaultBranchRef",
  `git fetch origin ${BASE_BRANCH}`,
  `git merge --no-edit refs/remotes/origin/${BASE_BRANCH}`,
];

/**
 * The same, for the review run's list (019). A review run is spawned with a different list and
 * with deny rules of its own, so its entries are exercised in their own sessions under their
 * own list — a command checked against the Code run's grants says nothing about this one.
 *
 * The `skelcrew review` representative carries a **backtick inside single quotes**, which is the
 * shape the review playbook prescribes its findings in. Review round 2 measured the alternative:
 * the same backtick inside *double* quotes is a command substitution and the harness asks about
 * it outright, which would burn a whole review round on a question nobody answers overnight. The
 * playbook's own template fills to a bare `'PLACEHOLDER'` with no metacharacter in it, so this
 * entry is the only thing here that would notice the harness starting to ask about that form.
 */
export const REVIEW_LIST_REPRESENTATIVES: readonly string[] = [
  "skelcrew show 1",
  'skelcrew comment 1 "a comment"',
  'skelcrew attention 1 "a question"',
  "skelcrew review 1 changes-requested 'Critical: runner.ts:480 calls `endRun()` too late'",
  "gh pr view --json url --jq .url",
  "gh pr diff --name-only",
  "gh repo view --json defaultBranchRef",
];

/** A list the check puts through the harness, with the runs whose commands belong to it. */
export interface ListUnderTest {
  /** How a problem line names it. */
  name: string;
  /** The run kind whose grants these are: what `allowlistFor` is asked for. */
  kind: PlaybookKind;
  /** The fixed part of the list, whose `Bash(...)` entries each need a representative. */
  list: readonly string[];
  representatives: readonly string[];
  /** The playbooks whose instructed commands run under this list. */
  playbooks: readonly PlaybookKind[];
}

/**
 * Both lists, and which playbooks run under each: the two claimable phases are spawned with the
 * Code list, and the review run with its own. A command is only evidence about the list it was
 * run under, so each session carries its list and the coverage is counted per list.
 */
export const LISTS_UNDER_TEST: readonly ListUnderTest[] = [
  {
    name: "the Code list",
    kind: "code",
    // What a Code run is spawned with: the fixed list, and the two entries `allowlistFor`
    // composes from the base branch's name (020). The file-tool entry and the scan's are not
    // here for the same reason they never were — this is the part every run shares, and the
    // session below is given the whole list `allowlistFor` returns.
    list: [...FIXED_ALLOWLIST, ...baseBranchGrants(BASE_BRANCH)],
    representatives: FIXED_LIST_REPRESENTATIVES,
    playbooks: PLAYBOOK_PHASES,
  },
  {
    name: "the review list",
    kind: "review",
    list: REVIEW_ALLOWLIST,
    representatives: REVIEW_LIST_REPRESENTATIVES,
    playbooks: ["review"],
  },
];

/**
 * The fixed list's `Bash(...)` entries that no representative covers, so an entry added to the
 * list without one fails the check instead of going unchecked. It reads an entry's own shape — a
 * trailing ` *` is a prefix, anything else is the whole command — rather than asking `allowsTool`,
 * for two reasons, neither of them that the model is wrong here (review round 2 ran `allowsTool`
 * per entry over all 196 entry–representative pairs and found it agreeing with this exactly):
 *
 * - **Independence.** This check exists because a model of the harness cannot be trusted to answer
 *   "would this ask". Using that same model to decide *which commands to ask the harness about*
 *   would put it back in the one place the answer is supposed to come from.
 * - **`allowsTool` answers a different question.** It asks whether the *whole list* permits a
 *   command, not which entry it stands for: `gh pr view --json url --jq .url` is `false` against
 *   `["Bash(gh pr create *)"]` and `true` against `FIXED_ALLOWLIST`, so per-entry coverage read
 *   off the full list would call every entry covered as soon as any one of them was — and an
 *   entry would silently lose its representative. (Both runs executed.)
 *
 * What this does *not* claim is that the model widens an entry: `allowsTool("Bash", {command:
 * "xargs git add -A"})` is `false`, against the fixed list and against `["Bash(git add *)"]` alone.
 * The widening is the **harness's**, which retries a wildcard pattern with `xargs ` in front of it
 * — see the divergence recorded at `entryMatches` in `allowlist.ts` — which is a reason the
 * harness would be no better an oracle for "stands for" than the model is: it would call
 * `xargs git add -A` a representative of `Bash(git add *)`, and this list is meant to hold the
 * command a playbook's agent would actually write.
 */
export function unrepresentedEntries(
  representatives: readonly string[] = FIXED_LIST_REPRESENTATIVES,
  list: readonly string[] = FIXED_ALLOWLIST,
): string[] {
  const covers = (entry: string, command: string): boolean => {
    const content = /^Bash\((.*)\)$/.exec(entry)?.[1];
    if (content === undefined) return false;
    if (!content.endsWith(" *")) return command === content;
    const prefix = content.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  };
  return list.filter(
    (entry) =>
      entry.startsWith("Bash(") && !representatives.some((command) => covers(entry, command)),
  );
}

/** What a run of the check is holding at any moment, and so what an interrupt has to let go of. */
export interface RunState {
  /** Ends the session that is running now and closes its stub; absent between commands. */
  interrupt?: () => void;
  /** The directory holding the temporary repository, its worktree, `HOME` and the stub `PATH`. */
  scratch?: string;
}

/**
 * Lets go of everything a run is holding, in the order that matters: the session first, so the
 * spawned harness is asked to stop before the directory it is working in disappears, then the
 * scratch directory — which is where the temporary repository's worktree registration lives too,
 * so removing it leaves no worktree registered anywhere.
 */
export function letGo(state: RunState): void {
  state.interrupt?.();
  state.interrupt = undefined;
  if (state.scratch !== undefined) {
    rmSync(state.scratch, { recursive: true, force: true });
    state.scratch = undefined;
  }
}

/** The key the harness is given. Not a credential — the stub accepts anything. */
export const STUB_API_KEY = "skelcrew-harness-check-not-a-real-key";

/** The system directories the shell needs, and nothing from the owner's environment. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);

/** How long one session may take before the check gives up on it. */
const SESSION_TIMEOUT_MS = 120_000;

/**
 * How long an interrupt gives the harness to go down before the directory under it is removed.
 * Measured rather than guessed: a killed harness writes its own session transcript under the
 * temporary `HOME` as it exits, and at 750ms the removal raced it and left that tree behind. At
 * this value, repeated interrupts leave nothing at all.
 */
const INTERRUPT_GRACE_MS = 2500;

/** The stub's one tool call, named so its result can be told from any other tool's. */
const TOOL_USE_ID = "toolu_harness_check";

export interface StubRequest {
  method: string;
  path: string;
  /** Every credential the harness presented: what proves whose key it used. */
  credentials: string[];
}

/**
 * Three headers a credential could arrive in: the one the pinned binary uses — `x-api-key`, and
 * nothing else, from a logged full run — and the two obvious proxies. **Not an exhaustive list**,
 * and not where the containment lives: what keeps the owner's login out of reach is the
 * environment the harness is given (no `ANTHROPIC_*` but the dummy), the empty `HOME` and
 * `settingSources: []`. This is a tripwire on top of that, so a future binary that authenticates
 * some other way is *likely* to be noticed rather than certain to be.
 */
const CREDENTIAL_HEADERS = ["x-api-key", "authorization", "proxy-authorization"];

/** What the header carries, with the scheme word off: a token presented as a bearer is the token. */
function credentialsIn(headers: Headers): string[] {
  return CREDENTIAL_HEADERS.map((name) => headers.get(name))
    .filter((value): value is string => value !== null && value.trim().length > 0)
    .map((value) => value.replace(/^[Bb]earer /, "").trim());
}

export interface StubModel {
  /** Where it is listening, read back off the server rather than from the literal it was given. */
  hostname: string;
  port: number;
  /** `http://<hostname>:<port>`, and nothing is listening anywhere else. */
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
      content_block: { type: "tool_use", id: TOOL_USE_ID, name: "Bash", input: {} },
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
      requests.push({
        method: request.method,
        path: url.pathname,
        credentials: credentialsIn(request.headers),
      });
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
  // Read back off the server rather than repeated from the literal above: a `url` composed from
  // what the stub *meant* to bind says nothing about where it is listening, which is what
  // criterion 6 is about. A server with no address at all is a failure, not a default.
  const { hostname, port } = server;
  if (hostname === undefined || port === undefined) {
    server.stop(true);
    throw new Error("the stub model is not listening on an address");
  }
  return {
    hostname,
    port,
    url: `http://${hostname}:${port}`,
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
  /** Which list this session was spawned with, by name: coverage is counted per list. */
  list: string;
  /**
   * This is the control session, tagged where the control is appended — not inferred from the
   * command's text. A playbook that prescribed `git push origin HEAD:main` would otherwise have
   * its denial read as the control's, and the run would pass on the strength of the one denial
   * the check exists to require.
   */
  control: boolean;
  /**
   * The command's own tool call came back as a result that is not an error: the harness let it
   * run, and it ran. A denial is a tool result too, so this is not "a result arrived".
   */
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
 * control command *not* denied under some list, a session that never reached the stub, a
 * `canUseTool` call (under `dontAsk` a prompt is a denial, so reaching the callback means the
 * mode was not honoured), a session that neither ran the command nor denied it, a fixed-list
 * entry with no representative, and a representative this run did not put through the harness.
 *
 * Coverage *and* the control are counted per list, for the one reason: a command is only
 * evidence about the list it ran under.
 */
export function problemsIn(
  outcomes: readonly CommandOutcome[],
  lists: readonly ListUnderTest[] = LISTS_UNDER_TEST,
): string[] {
  const problems: string[] = [];
  for (const outcome of outcomes) {
    const at = `\`${outcome.command}\` under ${outcome.list}`;
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
    if (outcome.control) continue;
    // A prescribed command that *is* the control is a defect in the playbooks, not a control
    // session: it would stop an unattended run on the owner's own gate. Named as itself, before
    // the denial branch, because "this asks" is the ordinary reading and this is the sharper one.
    if (outcome.command === CONTROL_COMMAND) {
      problems.push(
        `${at}: a playbook prescribes the control command, which must ask — an unattended run stops here`,
      );
      continue;
    }
    if (outcome.denials.length > 0) {
      const reasons = outcome.denials.map((denial) => `${denial.tool}: ${denial.reason}`);
      problems.push(`${at} is denied by the harness — ${reasons.join("; ")}`);
      continue;
    }
    if (!outcome.executed) problems.push(`${at}: the harness neither ran it nor denied it`);
  }
  for (const { name, list, representatives } of lists) {
    for (const entry of unrepresentedEntries(representatives, list)) {
      problems.push(`the entry ${entry} of ${name} has no representative command: it is never run`);
    }
    for (const command of representatives) {
      if (!outcomes.some((outcome) => outcome.command === command && outcome.list === name)) {
        problems.push(`\`${command}\` is a representative of ${name} that this run never ran`);
      }
    }
    // Per list, because a denial under one list says nothing about another's grants — the same
    // reason coverage is counted per list. A list with no control of its own could allow
    // everything and still pass on the strength of another list's one denial.
    const controls = outcomes.filter((outcome) => outcome.control && outcome.list === name);
    const control = controls[0];
    if (controls.length > 1) {
      problems.push(
        `${controls.length} sessions of ${name} are tagged as the control \`${CONTROL_COMMAND}\`: it is appended once per list, so this run is not the one it describes`,
      );
    } else if (control === undefined) {
      problems.push(
        `the control command \`${CONTROL_COMMAND}\` was not run under ${name}: the check proves nothing about that list`,
      );
    } else if (control.denials.length === 0) {
      problems.push(
        `the control command \`${CONTROL_COMMAND}\` was not denied under ${name}: the check cannot fail there, so it proves nothing about that list`,
      );
    }
  }
  return problems;
}

/**
 * Whether this message is the command under test having *run*: a tool result for the stub's own
 * tool call that is not an error. A denied call produces a tool result too — the refusal, marked
 * as an error — so "a tool result arrived" was the wrong reading of it, and criterion 3 asks for
 * a result that is not an error.
 */
export function ranTheCommand(message: unknown, toolUseId: string): boolean {
  const shape = message as { type?: string; message?: { content?: unknown } };
  if (shape.type !== "user") return false;
  const content = shape.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      block?.type === "tool_result" && block.tool_use_id === toolUseId && block.is_error !== true,
  );
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
  /** The name of the list those two came from, which the outcome carries. */
  list: string;
}

/**
 * One harness session for one command, through the run's own option builder. Five things are
 * overridden and no more, exactly as 017 names them: `permissionMode` is `dontAsk`, `env` gains
 * the stub's `ANTHROPIC_BASE_URL` and a dummy `ANTHROPIC_API_KEY`, `HOME` is a temporary
 * directory, `PATH` begins with the stub executables, and
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set — which no real run sets, and is the one
 * override that adds rather than substitutes. The last four are in `context.env`, built once by
 * `main`. Everything else is what a real run is given.
 *
 * While the session is live, `state.interrupt` is what ends it — and it is cleared when the
 * session is over, so an interrupt between commands finds no session to end rather than a stale
 * one.
 */
async function runCommand(
  command: string,
  isControl: boolean,
  context: RunContext,
  state: RunState,
): Promise<CommandOutcome> {
  let canUseToolCalls = 0;
  let executed = false;
  const reasons: Reasons = new Map();
  const denials: CommandOutcome["denials"] = [];
  // Started immediately before the `try` whose `finally` stops it — so nothing is left listening
  // if anything below throws, `query` included. (Inside the `try` it would need a nullable
  // binding for no gain: `startStubModel` stops its own server on the one path it can fail.)
  const stub = startStubModel(command);
  try {
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
    const end = (): void => {
      abortController.abort();
      session.close();
      stub.stop();
    };
    state.interrupt = end;
    const timer = setTimeout(end, SESSION_TIMEOUT_MS);
    try {
      for await (const message of session as AsyncIterable<SDKMessage>) {
        if (message.type === "system" && message.subtype === "permission_denied") {
          reasons.set(message.tool_use_id, message.decision_reason ?? message.message);
        }
        if (ranTheCommand(message, TOOL_USE_ID)) executed = true;
        if (message.type === "result") {
          for (const denial of message.permission_denials) {
            denials.push({
              tool: denial.tool_name,
              reason: reasonFor(reasons, denial.tool_use_id),
            });
          }
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      session.close();
    }
  } finally {
    state.interrupt = undefined;
    stub.stop();
  }
  const credentials = [...new Set(stub.requests.flatMap((request) => request.credentials))];
  return {
    command,
    list: context.list,
    control: isControl,
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
  await git(root, "init", "-b", BASE_BRANCH);
  await git(root, "config", "user.email", "harness-check@skelcrew.invalid");
  await git(root, "config", "user.name", "harness check");
  writeFileSync(
    join(root, "AGENTS.md"),
    `# A repository\n\nRun the checks with:\n\n\`\`\`\n${SCANNED_COMMAND}\n\`\`\`\n`,
  );
  await git(root, "add", "AGENTS.md");
  await git(root, "commit", "-m", "the repository's own instructions");
  await git(root, "update-ref", `refs/remotes/origin/${BASE_BRANCH}`, "HEAD");
}

/** What one list contributes to the run: its own commands, each under its own grants. */
function commandsFor(list: ListUnderTest, playbooks: Playbooks): string[] {
  return [
    ...new Set([
      ...list.playbooks.flatMap((kind) => instructedCommands(playbooks[kind])),
      ...list.representatives,
      // The repository's fenced command is added to both lists by the scan, and both kinds of
      // run are told to run it, so it is under test under each.
      SCANNED_COMMAND,
    ]),
  ];
}

async function main(): Promise<number> {
  const playbooks = loadPlaybooks();
  const perList = LISTS_UNDER_TEST.map((list) => ({
    list,
    commands: commandsFor(list, playbooks),
  }));
  const prescribedCount = perList.reduce((total, each) => total + each.commands.length, 0);

  // Resolved, the way `runner.ts` resolves its worktrees directory: `editsIn` spells the anchor
  // rule with the path's real name, and a `cwd` spelled the other way would have the harness
  // judging a *different* text against that rule. Bash rules do not read `cwd` today, so this is
  // ahead of the need — the `Write`-emitting stub the spec names as the next step would meet it.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "skelcrew-harness-check-")));
  const repoRoot = join(scratch, "repo");
  const worktree = join(scratch, "worktree");
  const home = join(scratch, "home");
  const dataDir = join(scratch, "data");
  const binDir = join(scratch, "bin");
  for (const dir of [repoRoot, home, dataDir]) mkdirSync(dir, { recursive: true });

  // What an interrupt has to let go of, updated as the run proceeds. Without this, a SIGTERM
  // mid-check left the spawned harness alive, the stub listening and a registered git worktree in
  // a scratch directory nobody would look in again.
  const state: RunState = { scratch };
  const interrupted = (signal: string): void => {
    console.log(`\n${signal}: ending the live session and removing ${scratch}`);
    // The session first and the directory *after a grace period*, not together: a harness killed
    // with the session still writes its own transcript under the temporary `HOME` as it goes
    // down, and a removal that raced it left that tree behind — observed, by hand, before this
    // was split in two.
    state.interrupt?.();
    state.interrupt = undefined;
    setTimeout(() => {
      letGo(state);
      process.exit(signal === "SIGINT" ? 130 : 143);
    }, INTERRUPT_GRACE_MS);
  };
  const onInterrupt = new Map<string, () => void>(
    ["SIGINT", "SIGTERM"].map((signal) => [signal, () => interrupted(signal)]),
  );
  for (const [signal, handler] of onInterrupt) process.on(signal, handler);

  try {
    await temporaryRepository(repoRoot);
    await git(repoRoot, "branch", "card-1", BASE_BRANCH);
    await git(repoRoot, "worktree", "add", worktree, "card-1");
    // One session per command per list, each with that list's own grants — and the control
    // appended to each list, tagged here rather than recognised by its text later: a playbook
    // that prescribed it would otherwise have its denial counted as the control's own.
    const sessions: Array<{ command: string; control: boolean; context: RunContext }> = [];
    const scannedNotes: string[] = [];
    for (const { list, commands } of perList) {
      const allowlist = await allowlistFor(createGit(), repoRoot, BASE_BRANCH, worktree, list.kind);
      scannedNotes.push(`${list.name}: ${allowlist.scanned}`);
      const context = {
        cwd: worktree,
        env: {} as Record<string, string>,
        allowedTools: allowlist.tools,
        disallowedTools: allowlist.denied,
        list: list.name,
      };
      for (const command of commands) sessions.push({ command, control: false, context });
      sessions.push({ command: CONTROL_COMMAND, control: true, context });
    }
    const words = writeStubExecutables(
      binDir,
      sessions.map((each) => each.command),
    );

    // The run's own environment, with the four overrides that are environment: `HOME` is this
    // temporary directory, `PATH` begins with the stub executables, the harness is pointed at the
    // stub with a dummy key, and non-essential traffic is off — the last of those is the one
    // override no real run makes, and it is here because "nothing leaves the machine" asks for it.
    // The owner's environment contributes nothing — `env` replaces `process.env` for the spawned
    // harness rather than extending it.
    const env = agentEnvironment({ PATH: SYSTEM_PATH, HOME: home }, dataDir, "crew");
    env.PATH = `${binDir}${delimiter}${env.PATH}`;
    env.ANTHROPIC_API_KEY = STUB_API_KEY;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    for (const session of sessions) session.context.env = env;

    for (const { list, commands } of perList) {
      console.log(
        `${list.name} (${list.playbooks.join(", ")}): ${commands.length} commands — those ` +
          `playbooks' own instructions, one representative per entry, and the repository's ` +
          `fenced \`${SCANNED_COMMAND}\``,
      );
    }
    console.log(
      `commands: ${prescribedCount} in all, plus the control command under each of the ` +
        `${perList.length} lists`,
    );
    for (const note of scannedNotes) console.log(`allowlist: ${note}`);
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
    for (const { command, control, context } of sessions) {
      const outcome = await runCommand(command, control, context, state);
      outcomes.push(outcome);
      // The harness's own words for a refusal, on the line that reports it: a denial with no
      // reason behind it would otherwise look the same as one the harness explained.
      const said = outcome.denials.map((denial) => denial.reason.split(".")[0]).join("; ");
      const at = `${command} [${context.list}]`;
      console.log(outcome.denials.length > 0 ? `DENIED  ${at} — ${said}` : `ran     ${at}`);
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
        `every one of the ${prescribedCount} commands under test runs unprompted in ` +
          `the harness under its own list, \`${CONTROL_COMMAND}\` is denied under each list, ` +
          `and the repository is unchanged`,
      );
      return 0;
    }
    for (const problem of problems) console.log(`FAIL ${problem}`);
    return 1;
  } finally {
    for (const [signal, handler] of onInterrupt) process.off(signal, handler);
    letGo(state);
  }
}

if (import.meta.main) process.exit(await main());
