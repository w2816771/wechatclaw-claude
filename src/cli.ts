#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import { ClaudeCodeBackend, resolveClaudeCommand, type PermissionMode } from "./agent/claude-code.js";
import { Bridge } from "./bridge.js";
import { TerminalChannel } from "./channel/terminal.js";
import { WeChatChannel } from "./channel/wechat.js";
import type { ChannelAdapter } from "./channel/types.js";
import { createOpenAIServer } from "./server/openai.js";
import {
  defaultConfig,
  defaultConfigPath,
  isWorkspaceAllowed,
  loadConfig,
  saveConfig,
  validateConfig,
  type Config,
} from "./config.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "-h" || command === "--help") return printHelp();
  if (command === "init") return void (await runInit());
  if (command === "serve") return void (await runServe());
  if (command === "start" || command === undefined) return void (await runStart());
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  process.stdout.write(
    [
      "wechatclaw-claude — talk to Claude Code from a chat app, on your subscription",
      "",
      "Usage:",
      "  wechatclaw-claude init     Set up config (workspace, allowlist, permissions)",
      "  wechatclaw-claude start    Start the bridge (default when config exists)",
      "  wechatclaw-claude serve    Start an OpenAI-compatible server (for OpenClaw etc.)",
      "  wechatclaw-claude --help    Show this help",
      "",
      "serve env vars: WCC_HOST (127.0.0.1), WCC_PORT (8760), WCC_API_KEY (optional)",
      `Config: ${defaultConfigPath()}`,
      "",
    ].join("\n"),
  );
}

async function runStart(): Promise<void> {
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    process.stdout.write("No config found — running setup first.\n\n");
    await runInit();
    return;
  }
  const config = loadConfig(configPath);
  const channel = buildChannel(config);
  const agent = new ClaudeCodeBackend({
    claudeBin: config.claudeBin,
    permissionMode: config.permissionMode,
    idleTimeoutMs: config.idleTimeoutMs,
    maxResident: config.maxResident,
    enableMcpServers: config.enableMcpServers,
  });
  const bridge = new Bridge(channel, agent, config);

  const shutdown = async (): Promise<void> => {
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  process.stdout.write(
    `Bridge up — channel: ${config.channel}, workspace: ${config.defaultWorkspace}\n` +
      (config.channel === "terminal" ? "Type a message. Ctrl+C to quit.\n" : ""),
  );
  await bridge.start();
}

function buildChannel(config: Config): ChannelAdapter {
  return config.channel === "wechat" ? new WeChatChannel() : new TerminalChannel();
}

async function runServe(): Promise<void> {
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    process.stdout.write("No config found — running setup first.\n\n");
    await runInit();
    return;
  }
  const config = loadConfig(configPath);
  const backend = new ClaudeCodeBackend({
    claudeBin: config.claudeBin,
    permissionMode: config.permissionMode,
    idleTimeoutMs: config.idleTimeoutMs,
    maxResident: config.maxResident,
    enableMcpServers: config.enableMcpServers,
  });

  const host = process.env.WCC_HOST ?? "127.0.0.1";
  const port = Number(process.env.WCC_PORT ?? "8760");
  const apiKey = process.env.WCC_API_KEY || undefined;

  const server = createOpenAIServer({
    backend,
    cwd: config.defaultWorkspace,
    model: config.model,
    apiKey,
    host,
    port,
  });

  const shutdown = (): void => {
    server.close();
    void backend.dispose().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, host, () => {
    process.stdout.write(
      `OpenAI-compatible server up at http://${host}:${port}/v1\n` +
        `  workspace: ${config.defaultWorkspace}\n` +
        `  auth:      ${apiKey ? "Bearer token required (WCC_API_KEY)" : "none (loopback only)"}\n` +
        "Point OpenClaw's model provider at this URL. Ctrl+C to quit.\n",
    );
  });
}

async function runInit(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def?: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(def ? `${q} [${def}] ` : `${q} `, (a) => resolve(a.trim() || def || ""));
    });

  try {
    process.stdout.write("wechatclaw-claude setup\n\n");

    // Pre-flight: the whole subscription-billing premise depends on this.
    await preflight();

    const existing = readExisting();

    // No safe default: workspace root.
    let workspace = "";
    while (!workspace) {
      const answer = await ask(
        "Workspace directory the agent may read/write:",
        existing?.defaultWorkspace ?? process.cwd(),
      );
      const resolved = path.resolve(answer);
      if (!fs.existsSync(resolved)) {
        process.stdout.write(`  ${resolved} does not exist — pick an existing directory.\n`);
        continue;
      }
      workspace = resolved;
    }

    // No safe default: who may talk to it. Terminal defaults to "operator".
    const sendersInput = await ask(
      "Allowed sender ids (comma-separated):",
      existing?.allowedSenders.join(",") ?? "operator",
    );
    const allowedSenders = sendersInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Safe default: permission policy.
    process.stdout.write(
      "\nPermission mode:\n" +
        "  plan            read-only (safest)\n" +
        "  acceptEdits     edit files in the workspace (default)\n" +
        "  bypassPermissions  full access incl. shell (opt-in)\n",
    );
    const permissionMode = await pickPermissionMode(ask, workspace, existing?.permissionMode ?? "acceptEdits");

    const config: Config = {
      ...defaultConfig(workspace),
      workspaceRoots: [workspace],
      defaultWorkspace: workspace,
      allowedSenders,
      permissionMode,
      channel: "terminal",
    };
    validateConfig(config); // fail loudly before writing

    const configPath = defaultConfigPath();
    saveConfig(config, configPath);

    process.stdout.write(
      `\nWrote ${configPath}\n` +
        `  workspace:   ${workspace}\n` +
        `  senders:     ${allowedSenders.join(", ") || "(none — nobody can talk to it!)"}\n` +
        `  permission:  ${permissionMode}\n` +
        `  channel:     terminal\n\n` +
        "Edit that file to change anything, or re-run `wechatclaw-claude init`.\n" +
        "Start with: wechatclaw-claude start\n",
    );
  } finally {
    rl.close();
  }
}

async function pickPermissionMode(
  ask: (q: string, def?: string) => Promise<string>,
  workspace: string,
  def: PermissionMode,
): Promise<PermissionMode> {
  const answer = (await ask("Choose:", def)) as PermissionMode;
  const mode: PermissionMode =
    answer === "plan" || answer === "acceptEdits" || answer === "bypassPermissions" ? answer : def;
  if (mode !== "bypassPermissions") return mode;

  // Unrestricted access from a chat app should cost a deliberate keystroke.
  const confirm = await ask(`\nbypassPermissions gives full disk access. Retype the workspace path to confirm:`);
  if (path.resolve(confirm) !== path.resolve(workspace)) {
    process.stdout.write("  Did not match — falling back to acceptEdits.\n");
    return "acceptEdits";
  }
  return "bypassPermissions";
}

function readExisting(): Config | undefined {
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) return undefined;
  try {
    return loadConfig(configPath);
  } catch {
    return undefined;
  }
}

async function preflight(): Promise<void> {
  const cmd = resolveClaudeCommand("claude");
  try {
    const { stdout } = await execFileAsync(cmd.command, [...cmd.argsPrefix, "--version"], {
      timeout: 10_000,
      windowsHide: true,
    });
    process.stdout.write(`Found Claude Code: ${stdout.trim()}\n`);
    process.stdout.write("Make sure you are logged in (`claude auth`) — the bridge uses your subscription.\n\n");
  } catch {
    process.stdout.write(
      "WARNING: could not run `claude --version`. Install Claude Code and log in first,\n" +
        "or the bridge will fail on the first message.\n\n",
    );
  }
}

void main();
