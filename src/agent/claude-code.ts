import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { AsyncQueue } from "./async-queue.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentMessage,
  AgentTurn,
  BackendCapabilities,
} from "./types.js";

export type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";

export interface ClaudeCodeOptions {
  /** Path or name of the Claude Code CLI. Default: "claude". */
  claudeBin?: string;
  /** Coarse permission mode. Default: "acceptEdits". */
  permissionMode?: PermissionMode;
  /** Reap an idle session process after this long. 0 = never. Default 10 min. */
  idleTimeoutMs?: number;
  /** Hard cap on resident processes (~370MB each). 0 = unlimited. Default 4. */
  maxResident?: number;
  /** Per-turn wall-clock timeout. Default 10 min. */
  turnTimeoutMs?: number;
  /** MCP servers are off by default — unreachable from a chat thread. */
  enableMcpServers?: boolean;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_RESIDENT = 4;
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * Drives the Claude Code CLI as a resident process per conversation.
 *
 * Why resident: a cold `claude -p` pays ~4s of startup (hooks, plugin sync, MCP
 * connect, CLAUDE.md discovery). Keeping the process alive between turns
 * amortizes that to a ~250ms re-init. The transcript on disk is the source of
 * truth, so an idle process can be reaped and the next turn resumes it.
 */
export class ClaudeCodeBackend implements AgentBackend {
  readonly id = "claude-code";
  private readonly sessions = new Map<string, ResidentSession>();
  private clock = 0;

  constructor(private readonly options: ClaudeCodeOptions = {}) {}

  get residentCount(): number {
    return this.sessions.size;
  }

  capabilities(): BackendCapabilities {
    // ponytail: per-tool confirm-via-chat needs a permission-prompt MCP server
    // (ARCHITECTURE §4.2 mechanism 2), not built yet — coarse mode only for now.
    return { interrupt: true, history: true, perToolPermission: false };
  }

  run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const self = this;
    async function* gen(): AsyncIterator<AgentEvent> {
      let session: ResidentSession;
      try {
        session = self.acquire(turn);
      } catch (error) {
        yield { type: "error", message: errorText(error) };
        return;
      }
      const queue = new AsyncQueue<AgentEvent>();
      const started = session.turnChain
        .catch(() => undefined)
        .then(() => self.beginTurn(session, turn, queue));
      session.turnChain = started.catch(() => undefined);
      await started;
      yield* queue;
    }
    return { [Symbol.asyncIterator]: gen };
  }

  async interrupt(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (session) this.destroy(session, new Error("turn interrupted by request"));
  }

  async history(_conversationId: string, sessionId: string): Promise<AgentMessage[]> {
    const transcript = findTranscriptPath(sessionId);
    if (!transcript) return [];
    return parseTranscript(fs.readFileSync(transcript, "utf8"));
  }

  async dispose(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      this.destroy(session, new Error("backend disposed"));
    }
  }

  // --- internals ---

  private acquire(turn: AgentTurn): ResidentSession {
    const cwd = path.resolve(turn.cwd);
    const existing = this.sessions.get(turn.conversationId);
    if (existing && !existing.closed) {
      // --model is a startup flag; a change needs a fresh process.
      if (existing.cwd === cwd && existing.model === turn.model) return existing;
      this.destroy(existing, new Error("session restarted with new settings"));
    }
    return this.spawnSession(turn, cwd);
  }

  private spawnSession(turn: AgentTurn, cwd: string): ResidentSession {
    const command = resolveClaudeCommand(this.options.claudeBin ?? "claude");
    const args = buildArgs({
      sessionId: turn.sessionId,
      model: turn.model,
      permissionMode: this.options.permissionMode ?? "acceptEdits",
      enableMcpServers: this.options.enableMcpServers ?? false,
    });
    const child = spawn(command.command, [...command.argsPrefix, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const session: ResidentSession = {
      conversationId: turn.conversationId,
      child,
      cwd,
      model: turn.model,
      sessionId: turn.sessionId,
      stderr: [],
      turnChain: Promise.resolve(),
      lastUsedAt: this.clock++,
      closed: false,
    };
    this.sessions.set(turn.conversationId, session);

    const reader = readline.createInterface({ input: child.stdout! });
    reader.on("line", (line) => this.handleLine(session, line));
    child.stderr?.on("data", (chunk: Buffer) => {
      session.stderr.push(chunk.toString("utf8"));
      if (session.stderr.length > 50) session.stderr.shift();
    });
    child.on("error", (error) => this.destroy(session, error));
    child.on("close", (code) => {
      const detail = session.stderr.join("").trim();
      this.destroy(session, formatFailure(code, detail || "process exited"));
    });

    this.evictIfOverCapacity();
    return session;
  }

  private beginTurn(session: ResidentSession, turn: AgentTurn, queue: AsyncQueue<AgentEvent>): void {
    if (session.closed) {
      queue.push({ type: "error", message: "session process is not running" });
      queue.close();
      return;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    session.lastUsedAt = this.clock++;

    const timeoutMs = this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    session.pending = {
      queue,
      state: createStreamState(),
      timer: setTimeout(() => {
        this.destroy(session, new Error(`turn timed out after ${timeoutMs}ms`));
      }, timeoutMs),
    };
    session.child.stdin?.write(encodeUserTurn(turn.prompt), "utf8");
  }

  private handleLine(session: ResidentSession, line: string): void {
    if (!line.trim()) return;
    const pending = session.pending;
    if (!pending) return;

    for (const event of consumeStreamLine(pending.state, line)) {
      pending.queue.push(event);
    }
    if (pending.state.threadId && session.sessionId !== pending.state.threadId) {
      session.sessionId = pending.state.threadId;
    }
    if (pending.state.settled) this.finishTurn(session);
  }

  private finishTurn(session: ResidentSession): void {
    const pending = session.pending;
    if (!pending) return;
    session.pending = undefined;
    clearTimeout(pending.timer);

    const { state } = pending;
    if (state.isError) {
      pending.queue.push({
        type: "error",
        message: state.text || state.errorText || "unknown error",
      });
    } else {
      pending.queue.push({
        type: "done",
        text: state.text || state.deltaText,
        sessionId: state.threadId,
      });
    }
    pending.queue.close();
    this.scheduleIdleShutdown(session);
  }

  private scheduleIdleShutdown(session: ResidentSession): void {
    const idleMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (idleMs <= 0 || !Number.isFinite(idleMs)) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.destroy(session, new Error("session reaped after idle timeout"));
    }, idleMs);
    session.idleTimer.unref?.();
  }

  private evictIfOverCapacity(): void {
    const max = this.options.maxResident ?? DEFAULT_MAX_RESIDENT;
    if (max <= 0) return;
    while (this.sessions.size > max) {
      const victim = [...this.sessions.values()]
        .filter((s) => !s.pending)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!victim) return; // all mid-turn; let them finish
      this.destroy(victim, new Error("session evicted to stay under the resident cap"));
    }
  }

  private destroy(session: ResidentSession, reason: Error): void {
    if (session.closed) return;
    session.closed = true;
    if (this.sessions.get(session.conversationId) === session) {
      this.sessions.delete(session.conversationId);
    }
    if (session.idleTimer) clearTimeout(session.idleTimer);

    const pending = session.pending;
    session.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.queue.push({ type: "error", message: reason.message });
      pending.queue.close();
    }
    session.child.stdin?.end();
    session.child.kill();
  }
}

// --- argv / command resolution ---

interface ResidentSession {
  conversationId: string;
  child: ChildProcess;
  cwd: string;
  model?: string;
  sessionId?: string;
  stderr: string[];
  turnChain: Promise<unknown>;
  pending?: PendingTurn;
  idleTimer?: NodeJS.Timeout;
  lastUsedAt: number;
  closed: boolean;
}

interface PendingTurn {
  queue: AsyncQueue<AgentEvent>;
  state: StreamState;
  timer: NodeJS.Timeout;
}

export function buildArgs(input: {
  sessionId?: string;
  model?: string;
  permissionMode: PermissionMode;
  enableMcpServers: boolean;
}): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    input.permissionMode,
  ];
  if (input.permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }
  if (!input.enableMcpServers) args.push("--strict-mcp-config");
  if (input.sessionId) args.push("--resume", input.sessionId);
  if (input.model) args.push("--model", input.model);
  return args;
}

/** One turn written to a resident process's stdin, as one stream-json line. */
export function encodeUserTurn(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  })}\n`;
}

export interface ResolvedCommand {
  command: string;
  argsPrefix: string[];
}

export function resolveClaudeCommand(
  claudeBin: string,
  options: {
    execPath?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    existsSync?: (p: string) => boolean;
  } = {},
): ResolvedCommand {
  const execPath = options.execPath ?? process.execPath;
  if (/\.(?:js|mjs|cjs)$/i.test(claudeBin)) {
    return { command: execPath, argsPrefix: [claudeBin] };
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  if (platform !== "win32") return { command: claudeBin, argsPrefix: [] };

  // npm installs Claude Code as a .cmd shim that spawn() can't run without a
  // shell. Prefer the native binary when present.
  if (claudeBin === "claude") {
    const home = env.USERPROFILE ?? env.HOME;
    const nativeBin = home ? path.win32.join(home, ".local", "bin", "claude.exe") : "";
    if (nativeBin && existsSync(nativeBin)) return { command: nativeBin, argsPrefix: [] };
  }
  if (/\.(?:cmd|bat)$/i.test(claudeBin)) {
    return { command: env.ComSpec ?? "cmd.exe", argsPrefix: ["/d", "/s", "/c", claudeBin] };
  }
  return { command: claudeBin, argsPrefix: [] };
}

export function formatFailure(code: number | null, detail: string): Error {
  const base = `claude exited with code ${code ?? "unknown"}: ${detail}`;
  if (/not logged in|authentication|invalid api key|unauthori/i.test(detail)) {
    return new Error(`${base}\nRun \`claude auth\` (or \`claude setup-token\`) as this user, then retry.`);
  }
  if (/ENOENT/i.test(detail)) {
    return new Error(`${base}\nClaude Code was not found — install it, or set claudeBin to its full path.`);
  }
  return new Error(base);
}

// --- stream-json parsing ---

export interface StreamState {
  threadId?: string;
  model?: string;
  text: string;
  deltaText: string;
  errorText: string;
  isError: boolean;
  settled: boolean;
}

export function createStreamState(): StreamState {
  return { text: "", deltaText: "", errorText: "", isError: false, settled: false };
}

/** Fold one `claude --output-format stream-json` line into `state`; emit events. */
export function consumeStreamLine(state: StreamState, line: string): AgentEvent[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (typeof event.session_id === "string" && !state.threadId) {
    state.threadId = event.session_id;
  }
  const type = String(event.type ?? "");

  if (type === "stream_event") {
    const inner = event.event as Record<string, unknown> | undefined;
    if (inner?.type === "content_block_delta") {
      const delta = inner.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        state.deltaText += delta.text;
        return [{ type: "delta", text: delta.text }];
      }
    }
    if (inner?.type === "message_start") {
      const message = inner.message as Record<string, unknown> | undefined;
      if (typeof message?.model === "string") state.model = message.model;
    }
    return [];
  }

  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    if (typeof message?.model === "string") state.model = message.model;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content
      .filter(
        (block): block is { type: string; name?: string } =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use",
      )
      .map((block) => ({ type: "tool" as const, name: block.name ?? "tool" }));
  }

  if (type === "result") {
    if (typeof event.result === "string") state.text = event.result;
    if (event.is_error === true) state.isError = true;
    if (typeof event.error === "string") state.errorText = event.error;
    state.settled = true;
  }
  return [];
}

// --- transcript reading ---

export function claudeProjectsDir(home = os.homedir()): string {
  return path.join(home, ".claude", "projects");
}

/**
 * Claude Code stores each session at
 * ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl. The caller has the
 * session id but not the slug, so scan the project dirs for it.
 */
export function findTranscriptPath(sessionId: string, home = os.homedir()): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  const root = claudeProjectsDir(home);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function parseTranscript(raw: string): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = entry.type;
    if (role !== "user" && role !== "assistant") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    const text = extractText(message?.content);
    if (!text) continue;
    messages.push({
      id: String(entry.uuid ?? `${role}-${messages.length}`),
      role,
      text,
      ...(typeof entry.timestamp === "string" ? { createdAt: entry.timestamp } : {}),
    });
  }
  return messages;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "text",
    )
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
