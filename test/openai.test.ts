import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ClaudeCodeBackend } from "../src/agent/claude-code.js";
import { createOpenAIServer } from "../src/server/openai.js";

const fakeClaude = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

async function withServer(
  opts: { apiKey?: string },
  fn: (base: string, backend: ClaudeCodeBackend) => Promise<void>,
): Promise<void> {
  const backend = new ClaudeCodeBackend({ claudeBin: fakeClaude });
  const server = createOpenAIServer({ backend, cwd: process.cwd(), model: "claude", apiKey: opts.apiKey });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, backend);
  } finally {
    server.close();
    await backend.dispose();
  }
}

test("non-streaming completion returns OpenAI shape with the reply", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].message.role, "assistant");
    assert.equal(json.choices[0].message.content, "echo:hi (turn 1)");
    assert.equal(json.choices[0].finish_reason, "stop");
  });
});

test("the user field resumes the same Claude session across requests", async () => {
  await withServer({}, async (base) => {
    const call = async (): Promise<string> => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }], user: "wx-alice" }),
      });
      return ((await res.json()) as any).choices[0].message.content;
    };
    assert.equal(await call(), "echo:x (turn 1)");
    // "turn 2" proves the second request resumed the same resident session.
    assert.equal(await call(), "echo:x (turn 2)");
  });
});

test("streaming yields SSE chunks ending in [DONE]", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const body = await res.text();
    const datas = body
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    assert.equal(datas.at(-1), "[DONE]");
    const content = datas
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d).choices[0].delta.content ?? "")
      .join("");
    assert.equal(content, "echo:hi");
    const last = JSON.parse(datas.at(-2)!);
    assert.equal(last.choices[0].finish_reason, "stop");
  });
});

test("content parts (array) are flattened to text", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "parts" }] }] }),
    });
    const json = (await res.json()) as any;
    assert.equal(json.choices[0].message.content, "echo:parts (turn 1)");
  });
});

test("a bearer key is required when configured", async () => {
  await withServer({ apiKey: "secret" }, async (base) => {
    const unauth = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(unauth.status, 401);
    const ok = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(ok.status, 200);
  });
});

test("GET /v1/models lists the model", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/v1/models`);
    const json = (await res.json()) as any;
    assert.equal(json.data[0].id, "claude");
  });
});
