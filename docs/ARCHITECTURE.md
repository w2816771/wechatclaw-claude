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

But note what these problems are *about*: they are all about **structure** —
where code lives, how it is named, what depends on what. **None of them is about
using a subprocess.** The retrofit was messy because it was a retrofit, not
because it drove a CLI.

Four structural problems, in the order they hurt:

| # | Problem | Root cause |
|---|---|---|
| 1 | Process management is ad-hoc and tangled into the bridge | No encapsulation, not "a subprocess exists" |
| 2 | Session history read by globbing `~/.claude/projects/*/<id>.jsonl` | No read API at the CLI layer |
| 3 | Provider concepts leak everywhere — types named `Codex*`, config keys named `codexBin` | Retrofit instead of an interface |
| 4 | One hardcoded chat channel | Channel logic interleaved with agent logic |

---

## 2. The core decision: subprocess, deliberately

There are two ways to embed Claude Code. The choice is decided by **who pays**,
not by which is cleaner code.

| | Drive the `claude` CLI (`-p`) | `@anthropic-ai/claude-agent-sdk` |
|---|---|---|
| Auth | Uses the operator's **Claude Code subscription** login (`claude auth`) | **API key**, per Anthropic's SDK terms — subscription login is not permitted |
| Cost | Flat monthly fee | **Metered, per token** |
| Code | A resident-process pool to manage | Library calls; no process pool |

The SDK is the cleaner *code*. But this tool targets **individual users who
already pay for a Claude Code subscription** — the same kind of user as its
author. The SDK would force every one of them onto metered API billing for
something their subscription already covers. That is disqualifying.

**So codex-claude drives the CLI, and keeps the resident-process pool.** The
pool is not accidental complexity to be deleted — it is the necessary cost of
riding the subscription, and it is what makes the approach fast. A cold turn
pays ~4s of Claude Code startup (hooks, plugin sync, MCP, CLAUDE.md discovery);
a resident process amortizes that to ~250ms of re-init per turn. Measured on the
predecessor: **~9.3s cold, ~4.1s warm** for a trivial message.

What codex-claude fixes is **structure, not mechanism**. The process pool stays;
it just moves behind a clean interface, stops leaking provider vocabulary, and
stops being the only thing the bridge knows how to talk to.

### The pool, encapsulated

Everything the retrofit did ad-hoc becomes one job of one backend:

| Mechanism | Where it lives now |
|---|---|
| Resident process keyed by conversation | Inside the `claude-code` `AgentBackend`, nowhere else |
| `--resume <id>` on continue; respawn on model change | `AgentBackend.run` |
| Idle reaper + LRU cap over ~370MB processes | Backend-internal; tunable via config |
| Reading history from `~/.claude/projects/*/*.jsonl` | `AgentBackend.history` — the one place that knows the on-disk format |
| Killing the process to cancel a turn | `AgentBackend.interrupt` |
| `--strict-mcp-config` flag plumbing | Backend config, not root config |
| Parsing `stream-json` lines off stdout | Backend-internal; emits typed `AgentEvent`s upward |

The bridge above never sees a process, a PID, or a JSONL path. It sees an
`AgentBackend` emitting events. **That** is the difference from the retrofit —
not the absence of a subprocess, but the absence of a subprocess *everywhere*.

### Honest cost of this choice

- The SDK's `interrupt()`, `setModel()`, and `getSessionMessages()` are genuinely
  nicer than kill-and-respawn and JSONL-globbing. We reimplement them because the
  billing model matters more than the ergonomics. If the target user ever shifts
  to API-key users, the `AgentBackend` interface lets an SDK-backed
  implementation drop in without touching the bridge — that is partly why the
  interface exists.
- Per-tool permission confirmation is harder over the CLI than the SDK's
  `canUseTool` callback (see §4.2).

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
every backend supports interruption, mid-turn model switching, or per-tool
permission prompts, a backend declares what it has and the bridge degrades
gracefully (see §4.2 — the CLI backend's permission capability depends on whether
the MCP permission server is running). This is the check that stops
`AgentBackend` from silently becoming "whatever the CLI happens to do".

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

The intended policy:

```
default:  read-only tools auto-approved; writes/exec require confirmation
          via a reply in the chat thread
```

Over the CLI this is **harder than it would be with the SDK** and worth being
honest about. `claude -p` has no per-call callback like the SDK's `canUseTool`.
Two mechanisms are available, in increasing capability:

1. **Coarse, up-front** — set `--permission-mode` per conversation
   (`plan` / `default` / `acceptEdits`). Simple, but no per-tool prompt.
2. **Per-tool via a permission-prompt MCP tool** — `-p` accepts
   `--permission-prompt-tool mcp__<server>__<tool>`; Claude Code routes each
   permission request to that tool. The bridge runs a tiny local MCP server
   whose one tool turns the request into an outbound chat message and blocks on
   the reply.

Mechanism 2 is the real target; mechanism 1 is the fallback a backend reports
via `capabilities()` when the MCP permission server is not running.
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

The retrofit already works and is already fast — the warm-path numbers in §2 are
from it. So the case for a rewrite is not performance, and (given the billing
constraint in §2) it is not "use the SDK" either. It is **structure**.

In the retrofit, the process pool, the JSONL globbing, the `Codex`-named types,
and the single hardcoded channel are all tangled together. Adding a second chat
platform means touching agent code; changing the agent means touching channel
code; and every file carries a provider's vocabulary it should never have known.

codex-claude keeps the exact mechanism that makes the retrofit work — CLI
subprocess, resident pool, subscription billing — and puts a clean seam around
it. A new channel is one directory implementing `ChannelAdapter`. A future
API-key backend is one class implementing `AgentBackend`. Neither reaches across
the seam. That separation is the whole product; the subprocess underneath is
deliberately unchanged.
