import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildArgs,
  ClaudeCodeBackend,
  consumeStreamLine,
  createStreamState,
  encodeUserTurn,
  findTranscriptPath,
  parseTranscript,
  resolveClaudeCommand,
} from "../src/agent/claude-code.js";
import type { AgentEvent } from "../src/agent/types.js";

const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test("buildArgs opens a resident stream-json process with MCP off", () => {
  assert.deepEqual(buildArgs({ permissionMode: "acceptEdits", enableMcpServers: false }), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "acceptEdits",
    "--strict-mcp-config",
  ]);
});

test("buildArgs adds --dangerously-skip-permissions only for bypass", () => {
  assert.ok(buildArgs({ permissionMode: "bypassPermissions", enableMcpServers: false }).includes("--dangerously-skip-permissions"));
  assert.ok(!buildArgs({ permissionMode: "plan", enableMcpServers: false }).includes("--dangerously-skip-permissions"));
});

test("buildArgs resumes and forwards the model, and keeps MCP when enabled", () => {
  const args = buildArgs({ sessionId: "abc", model: "opus", permissionMode: "plan", enableMcpServers: true });
  assert.ok(args.includes("--resume") && args[args.indexOf("--resume") + 1] === "abc");
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "opus");
  assert.ok(!args.includes("--strict-mcp-config"));
});

test("encodeUserTurn writes one stream-json user message per line", () => {
  const line = encodeUserTurn("hi\nthere");
  assert.ok(line.endsWith("\n"));
  assert.equal(line.trimEnd().includes("\n"), false);
  assert.deepEqual(JSON.parse(line), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi\nthere" }] },
  });
});

test("consumeStreamLine yields delta, tool, and result events", () => {
  const state = createStreamState();
  assert.deepEqual(consumeStreamLine(state, JSON.stringify({ type: "system", subtype: "init", session_id: "s1" })), []);
  assert.equal(state.threadId, "s1");
  assert.deepEqual(
    consumeStreamLine(state, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } })),
    [{ type: "tool", name: "Read" }],
  );
  assert.deepEqual(
    consumeStreamLine(state, JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hey" } } })),
    [{ type: "delta", text: "hey" }],
  );
  consumeStreamLine(state, JSON.stringify({ type: "result", is_error: false, result: "final" }));
  assert.equal(state.settled, true);
  assert.equal(state.text, "final");
});

test("resolveClaudeCommand routes .js via node and .cmd via cmd.exe", () => {
  assert.deepEqual(resolveClaudeCommand("/tmp/claude.mjs", { execPath: "/usr/bin/node" }), {
    command: "/usr/bin/node",
    argsPrefix: ["/tmp/claude.mjs"],
  });
  assert.deepEqual(
    resolveClaudeCommand("C:\\npm\\claude.cmd", { platform: "win32", env: { ComSpec: "C:\\cmd.exe" }, existsSync: () => false }),
    { command: "C:\\cmd.exe", argsPrefix: ["/d", "/s", "/c", "C:\\npm\\claude.cmd"] },
  );
});

test("resolveClaudeCommand prefers the native Windows binary", () => {
  const native = "C:\\Users\\demo\\.local\\bin\\claude.exe";
  assert.deepEqual(
    resolveClaudeCommand("claude", { platform: "win32", env: { USERPROFILE: "C:\\Users\\demo" }, existsSync: (p) => p === native }),
    { command: native, argsPrefix: [] },
  );
});

test("backend streams deltas + tool progress and ends with done", async () => {
  const backend = new ClaudeCodeBackend({ claudeBin: fakeClaude });
  const events = await collect(backend.run({ conversationId: "c1", prompt: "hello", cwd: process.cwd() }));
  assert.deepEqual(events, [
    { type: "tool", name: "Read" },
    { type: "delta", text: "echo:" },
    { type: "delta", text: "hello" },
    { type: "done", text: "echo:hello (turn 1)", sessionId: "aaaa1111-bbbb-2222-cccc-333344445555" },
  ]);
  assert.equal(backend.residentCount, 1);
  await backend.dispose();
});

test("warm() pre-spawns a process that the first turn reuses, with no junk turn", async () => {
  const backend = new ClaudeCodeBackend({ claudeBin: fakeClaude });
  backend.warm("default", process.cwd());
  assert.equal(backend.residentCount, 1);

  const events = await collect(backend.run({ conversationId: "default", prompt: "hi", cwd: process.cwd() }));
  const done = events.at(-1);
  // "turn 1" proves the warmed process carried no prior (junk) turn.
  assert.equal(done?.type === "done" ? done.text : "", "echo:hi (turn 1)");
  assert.equal(backend.residentCount, 1);
  await backend.dispose();
});

test("a second turn reuses the resident process", async () => {
  const backend = new ClaudeCodeBackend({ claudeBin: fakeClaude });
  const first = await collect(backend.run({ conversationId: "c1", prompt: "one", cwd: process.cwd() }));
  const firstDone = first.at(-1);
  const sessionId = firstDone?.type === "done" ? firstDone.sessionId : undefined;

  const second = await collect(backend.run({ conversationId: "c1", prompt: "two", cwd: process.cwd(), sessionId }));
  const done = second.at(-1);
  assert.equal(done?.type, "done");
  // "turn 2" can only come from the same live process; a respawn restarts at 1.
  assert.equal(done?.type === "done" ? done.text : "", "echo:two (turn 2)");
  assert.equal(backend.residentCount, 1);
  await backend.dispose();
});

test("the resident cap evicts the least recently used conversation", async () => {
  const backend = new ClaudeCodeBackend({ claudeBin: fakeClaude, maxResident: 2 });
  await collect(backend.run({ conversationId: "a", prompt: "x", cwd: process.cwd() }));
  await collect(backend.run({ conversationId: "b", prompt: "x", cwd: process.cwd() }));
  assert.equal(backend.residentCount, 2);
  await collect(backend.run({ conversationId: "c", prompt: "x", cwd: process.cwd() }));
  assert.equal(backend.residentCount, 2);
  await backend.dispose();
});

test("a process that dies on startup surfaces its stderr", async () => {
  process.env.FAKE_CLAUDE_EXIT = "1";
  try {
    const backend = new ClaudeCodeBackend({ claudeBin: fakeClaude });
    const events = await collect(backend.run({ conversationId: "c1", prompt: "hi", cwd: process.cwd() }));
    const err = events.find((e) => e.type === "error");
    assert.ok(err && err.type === "error" && /refused to start/.test(err.message));
    await backend.dispose();
  } finally {
    delete process.env.FAKE_CLAUDE_EXIT;
  }
});

test("findTranscriptPath locates a session jsonl and rejects traversal", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wcc-home-"));
  const dir = path.join(home, ".claude", "projects", "D--demo");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "sess-1.jsonl");
  fs.writeFileSync(file, "");
  assert.equal(findTranscriptPath("sess-1", home), file);
  assert.equal(findTranscriptPath("missing", home), undefined);
  assert.equal(findTranscriptPath("../../escape", home), undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseTranscript keeps user and assistant text in order", () => {
  const raw = [
    JSON.stringify({ type: "user", uuid: "u1", message: { content: "q?" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "thinking", thinking: "h" }, { type: "text", text: "a." }] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", name: "Read" }] } }),
  ].join("\n");
  assert.deepEqual(parseTranscript(raw), [
    { id: "u1", role: "user", text: "q?" },
    { id: "a1", role: "assistant", text: "a." },
  ]);
});
