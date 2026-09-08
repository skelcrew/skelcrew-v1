/**
 * Running a coding agent. The daemon spawns `claude` as a subprocess — it never calls a
 * model API itself — and streams what the agent says back onto the card, because what an
 * agent does must be visible on the board.
 */
import { spawn } from "node:child_process";

export interface RunOptions {
  cwd: string;
  prompt: string;
  model?: string | undefined;
  permissionMode?: string | undefined;
  onText: (text: string) => void;
  onLog?: (line: string) => void;
}

export interface RunResult {
  code: number;
  error?: string;
}

/** Extract assistant prose from one `--output-format stream-json` NDJSON line. */
function assistantText(line: string): string | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const e = event as { type?: string; message?: { content?: unknown }; result?: unknown };
  if (e.type !== "assistant" || !e.message || !Array.isArray(e.message.content)) return null;

  const parts: string[] = [];
  for (const block of e.message.content as Array<{ type?: string; text?: string }>) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : null;
}

export function runClaude(options: RunOptions): Promise<RunResult> {
  const args = ["-p", options.prompt, "--output-format", "stream-json", "--verbose"];
  if (options.model) args.push("--model", options.model);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("claude", args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      resolve({ code: 127, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    let stdout = "";
    let stderrTail = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let index: number;
      while ((index = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        if (!line) continue;
        const text = assistantText(line);
        if (text) options.onText(text);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      options.onLog?.(chunk.trimEnd());
    });

    child.on("error", (err) => {
      resolve({ code: 127, error: `could not spawn "claude": ${err.message}` });
    });

    child.on("close", (code) => {
      const exit = code ?? 1;
      resolve(exit === 0 ? { code: 0 } : { code: exit, error: stderrTail.trim() || undefined });
    });
  });
}

/**
 * Forwards agent chatter to the card: at most one comment every ~5s, each truncated,
 * so the feed reads as progress rather than a transcript dump.
 */
export class Progress {
  private pending: string[] = [];
  private lastPostAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private posting = false;

  constructor(
    private readonly post: (text: string) => Promise<void>,
    private readonly intervalMs = 5000,
    private readonly maxChars = 500,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
  }

  push(text: string): void {
    const clean = text.replace(/\s+\n/g, "\n").trim();
    if (clean) this.pending.push(clean);
  }

  private async flush(): Promise<void> {
    if (this.posting || this.pending.length === 0) return;
    if (Date.now() - this.lastPostAt < this.intervalMs) return;

    const joined = this.pending.join("\n").trim();
    this.pending = [];
    this.lastPostAt = Date.now();
    const body =
      joined.length > this.maxChars ? `${joined.slice(0, this.maxChars - 1).trimEnd()}…` : joined;

    this.posting = true;
    try {
      await this.post(`🛠 ${body}`);
    } catch {
      /* a dropped progress note must never kill the run */
    } finally {
      this.posting = false;
    }
  }

  /** Post whatever is left, then stop. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastPostAt = 0;
    await this.flush();
  }
}
