# codex-claude — Architecture

A chat-channel bridge for Claude Code: talk to an agent running on your own
machine, from whatever messaging app you already use.

This document is the design rationale. It is written against a working
predecessor (a WeChat↔Codex bridge that was retrofitted to drive Claude Code by
spawning CLI processes), and every decision below names the specific problem in
that design it exists to fix.

---

## 1. What was wrong with the retrofit

The predecessor spawned `claude -p` as a child process and scraped its output.
Measured on a real workload, a trivial message cost **~9.3s**: ~3.9s of process
startup (hooks, plugin sync, MCP connection, CLAUDE.md discovery) and ~5.4s of
API time. Keeping the process resident between turns cut that to **~4.1s**, but
that fix cost ~400 lines of process-pool code — spawn, LRU eviction, idle
reaping, stdin framing, stdout line parsing, orphan cleanup — and each resident
process holds ~370MB.

That entire layer is **accidental complexity**. It exists only because the
bridge talks to Claude Code through a terminal interface designed for humans.

Four structural problems, in the order they hurt:

| # | Problem | Root cause |
|---|---|---|
| 1 | Process lifecycle is the application's biggest subsystem | Driving a CLI instead of a library |
| 2 | Session history read by globbing `~/.claude/projects/*/<id>.jsonl` | No supported read API at the CLI layer |
| 3 | Provider concepts leak everywhere — types named `Codex*`, config keys named `codexBin` | Retrofit instead of an interface |
| 4 | One hardcoded chat channel | Channel logic interleaved with agent logic |

---

## 2. The core decision: SDK, not subprocess

`@anthropic-ai/claude-agent-sdk` exposes Claude Code as a library. Every piece
of the process-pool layer maps to something the SDK already does:

| Hand-rolled in the retrofit | Agent SDK equivalent |
|---|---|
| Resident process pool keyed by session | `query({ prompt: AsyncIterable })` — streaming input mode |
| `--resume <id>` + respawn on model change | `options.resume` / `options.forkSession` |
| Idle reaper + LRU cap over ~370MB processes | `startup()` pre-warm; one query object per conversation |
| Globbing `~/.claude/projects/*/*.jsonl` | `getSessionMessages()`, `listSessions()` |
| Killing the process to cancel a turn | `query.interrupt()` |
| Respawn to change model or permission mode | `query.setModel()`, `query.setPermissionMode()` |
| `--strict-mcp-config` flag plumbing | `options.strictMcpConfig`, `query.toggleMcpServer()` |
| Parsing `stream-json` lines off stdout | Typed `SDKMessage` async iteration |

**This deletes a subsystem rather than optimizing one.** Mid-conversation model
switching stops being a process restart. Cancelling a turn stops being a
`SIGKILL`. Reading history stops being a filesystem race against a file the
agent is still appending to.

### What we give up, honestly

- The SDK is a Node dependency; the CLI approach is language-agnostic. Accepted
  — the bridge is already TypeScript.
- Each conversation still holds a live agent in-process, so memory is bounded by
  concurrent conversations, not total conversations. **The LRU cap and idle
  reaper survive** — they move from "manage OS processes" to "manage query
  objects", which is where the accidental complexity ends and the real
  constraint begins.

---

## 3. Layering

The retrofit's deepest flaw was structural: WeChat vocabulary and Codex
vocabulary were interleaved through every file. Four layers, each depending only
downward:

```
   ┌──────────────────────────────────────────────────┐
   │  channels/       Channel adapters                │
   │                  (one directory per messaging    │
   │                   platform; no agent concepts)   │
   └────────────────────────┬─────────────────────────┘
                            │  ChannelAdapter
   ┌────────────────────────┴─────────────────────────┐
   │  bridge/         Routing, access control,        │
   │                  attachments, reply chunking     │
   └────────────────────────┬─────────────────────────┘
                            │  AgentBackend
   ┌────────────────────────┴─────────────────────────┐
   │  agents/         Backend implementations         │
   │                  (claude-code via Agent SDK)     │
   └────────────────────────┬─────────────────────────┘
                            │
   ┌────────────────────────┴─────────────────────────┐
   │  core/           Session store, config, policy   │
   └──────────────────────────────────────────────────┘
```

### The two interfaces that matter

Everything above hangs off these. Both are provider-neutral and
channel-neutral — no `Codex*` types, no `weixin` in a signature.

```ts
/** A messaging platform. Knows nothing about agents. */
export interface ChannelAdapter {
  readonly id: string;
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(to: Recipient, message: OutboundMessage): Promise<void>;
  /** Optional: edit-in-place for streaming. Absent → the bridge batches. */
  edit?(ref: MessageRef, message: OutboundMessage): Promise<void>;
}

/** An agent runtime. Knows nothing about chat platforms. */
export interface AgentBackend {
  readonly id: string;
  run(input: AgentTurn): AsyncIterable<AgentEvent>;
  interrupt(conversationId: string): Promise<void>;
  history(conversationId: string): Promise<AgentMessage[]>;
  capabilities(): BackendCapabilities;
  dispose(): Promise<void>;
}
```

`run` returns an **async iterable of events**, not a promise of a final string.
The retrofit's callback pair (`onDelta`, `onProgress`) forced every caller to
reimplement ordering and back-pressure; an async iterable gets both from the
language.

`capabilities()` is what keeps the abstraction honest: rather than pretending
every backend supports interruption and mid-turn model switching, a backend
declares what it has and the bridge degrades gracefully. This is the check that
stops `AgentBackend` from silently becoming "whatever Claude Code does".

---

## 4. Design decisions

### 4.1 Streaming replies: adaptive, not a boolean

The retrofit had `streamReplies: true|false`. Neither setting is right: token
deltas are useless on a platform without message editing (hundreds of messages),
and batching feels dead on one that has it.

Reply strategy is derived from the channel's declared capability:

| Channel supports | Strategy |
|---|---|
| `edit()` | Post once, edit at a coalescing interval |
| Send only | Buffer; flush on paragraph boundary or idle timeout |
| Neither, high-latency | Tool-use progress only, then the final answer |

### 4.2 Permission model: policy, not a flag

The retrofit mapped a Codex sandbox string onto `--permission-mode` and
defaulted to full access. That is the wrong default for an agent reachable from
a chat app.

```
default:  read-only tools auto-approved; writes/exec require confirmation
          via a reply in the chat thread
```

The SDK's `canUseTool` callback is the hook: it turns a permission request into
an outbound chat message and awaits the reply. This is the one feature the CLI
approach genuinely could not do — a subprocess has nowhere to ask.

`bypassPermissions` stays available per workspace, opt-in, never the default.

### 4.3 Workspace isolation

Each conversation is pinned to a workspace declared in config. Path containment
is enforced in `core/` — resolve, then verify the result is inside an allowed
root — not left to the agent's own sandbox. Two independent layers.

### 4.4 Config

One namespace, no legacy keys. Backend and channel config are nested under their
own IDs so adding either does not touch the root schema. Secrets come from the
environment, never the config file.

---

## 5. Non-goals

- **Not a hosted service.** Binds loopback only. Anything else is the user's
  reverse proxy and their threat model.
- **Not multi-tenant.** One operator, their machine, their workspaces.
- **Not a Claude Code reimplementation.** Skills, subagents, and MCP are the
  SDK's job; the bridge only routes.

---

## 6. Why this is worth building rather than patching

The retrofit can be made fast — it was, and the numbers are in §1. What it
cannot be made is *small*. Its process pool, its JSONL globbing, and its
`Codex`-named types are all load-bearing consequences of driving a CLI, and each
one is a place where the next Claude Code release can break the bridge silently.

Building on the SDK deletes that surface instead of maintaining it.
