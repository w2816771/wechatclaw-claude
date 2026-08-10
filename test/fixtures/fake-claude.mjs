#!/usr/bin/env node
// Resident mock of `claude -p --input-format stream-json --output-format stream-json`.
// Stays alive and answers one turn per stdin line.
import readline from "node:readline";

const argv = process.argv.slice(2);
const resumeAt = argv.indexOf("--resume");
const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : "aaaa1111-bbbb-2222-cccc-333344445555";
const emit = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);

if (process.env.FAKE_CLAUDE_EXIT === "1") {
  process.stderr.write("fake claude refused to start\n");
  process.exit(1);
}

let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const prompt = message.message.content.map((b) => b.text).join("");
  turn += 1;

  emit({ type: "system", subtype: "init", session_id: sessionId, argv, turn });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "message_start", message: { model: "claude-opus-5" } } });
  emit({ type: "assistant", session_id: sessionId, message: { model: "claude-opus-5", content: [{ type: "tool_use", name: "Read" }] } });
  for (const piece of ["echo:", prompt]) {
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
  }
  emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: `echo:${prompt} (turn ${turn})` });
});
