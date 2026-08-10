import http from "node:http";

import type { AgentBackend } from "../agent/types.js";

export interface OpenAIServerOptions {
  backend: AgentBackend;
  /** Workspace the agent runs turns in. */
  cwd: string;
  model?: string;
  /** If set, require `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  host?: string;
  port?: number;
}

/**
 * An OpenAI-compatible /v1/chat/completions server that runs Claude Code.
 *
 * This is how OpenClaw (or any OpenAI-compatible frontend) uses your Claude
 * subscription as its "model": OpenClaw owns the WeChat channel and, for each
 * inbound message, calls this endpoint; we run Claude Code and stream the reply
 * back in OpenAI's wire format.
 *
 * Conversation continuity uses the request's `user` field as the key — OpenAI
 * chat completions is otherwise stateless. With a stable `user`, each turn
 * resumes the same Claude session; without one, every request is a fresh turn.
 */
export function createOpenAIServer(options: OpenAIServerOptions): http.Server {
  const model = options.model ?? "claude";
  const sessions = new Map<string, string>(); // conversationId -> claude session id

  return http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      sendJson(res, 500, { error: { message: errorText(error), type: "internal_error" } });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "";
    if (req.method === "GET" && (url === "/health" || url === "/")) {
      return sendJson(res, 200, { status: "ok" });
    }
    if (req.method === "GET" && url.startsWith("/v1/models")) {
      return sendJson(res, 200, { object: "list", data: [{ id: model, object: "model", owned_by: "wechatclaw-claude" }] });
    }
    if (req.method !== "POST" || !url.startsWith("/v1/chat/completions")) {
      return sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
    }
    if (!authorized(req, options.apiKey)) {
      return sendJson(res, 401, { error: { message: "invalid api key", type: "authentication_error" } });
    }

    const body = (await readJson(req)) as ChatRequest;
    const prompt = lastUserText(body.messages);
    if (!prompt) {
      return sendJson(res, 400, { error: { message: "no user message", type: "invalid_request_error" } });
    }

    const conversationId = typeof body.user === "string" && body.user ? body.user : "default";
    const turn = {
      conversationId,
      prompt,
      cwd: options.cwd,
      sessionId: sessions.get(conversationId),
      model: options.model,
    };
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${created}${Math.floor(Math.random() * 1e6)}`;

    if (body.stream) {
      return streamReply(res, options.backend.run(turn), { id, created, model, conversationId, sessions });
    }
    return batchReply(res, options.backend.run(turn), { id, created, model, conversationId, sessions });
  }
}

interface ChatRequest {
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  user?: string;
}

interface ReplyContext {
  id: string;
  created: number;
  model: string;
  conversationId: string;
  sessions: Map<string, string>;
}

async function batchReply(
  res: http.ServerResponse,
  events: AsyncIterable<import("../agent/types.js").AgentEvent>,
  ctx: ReplyContext,
): Promise<void> {
  let text = "";
  let error: string | undefined;
  for await (const event of events) {
    if (event.type === "delta") text += event.text;
    else if (event.type === "done") {
      if (event.text) text = event.text;
      if (event.sessionId) ctx.sessions.set(ctx.conversationId, event.sessionId);
    } else if (event.type === "error") error = event.message;
  }
  if (error) {
    return sendJson(res, 502, { error: { message: error, type: "upstream_error" } });
  }
  sendJson(res, 200, {
    id: ctx.id,
    object: "chat.completion",
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  });
}

async function streamReply(
  res: http.ServerResponse,
  events: AsyncIterable<import("../agent/types.js").AgentEvent>,
  ctx: ReplyContext,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const chunk = (delta: Record<string, unknown>, finish: string | null): void => {
    res.write(
      `data: ${JSON.stringify({
        id: ctx.id,
        object: "chat.completion.chunk",
        created: ctx.created,
        model: ctx.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  };

  chunk({ role: "assistant" }, null);
  let sawText = false;
  for await (const event of events) {
    if (event.type === "delta") {
      sawText = true;
      chunk({ content: event.text }, null);
    } else if (event.type === "done") {
      if (event.sessionId) ctx.sessions.set(ctx.conversationId, event.sessionId);
      if (!sawText && event.text) chunk({ content: event.text }, null);
    } else if (event.type === "error") {
      chunk({ content: `\n[error] ${event.message}` }, null);
    }
  }
  chunk({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

function lastUserText(messages: ChatRequest["messages"] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return contentToText(messages[i].content);
  }
  return "";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
        ? String((part as { text?: string }).text ?? "")
        : "",
    )
    .join("")
    .trim();
}

function authorized(req: http.IncomingMessage, apiKey?: string): boolean {
  if (!apiKey) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${apiKey}`;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
