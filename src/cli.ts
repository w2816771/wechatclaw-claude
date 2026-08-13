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
  console.error(`未知命令:${command}`);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  process.stdout.write(
    [
      "wechatclaw-claude —— 从聊天应用连你自己电脑上的 Claude Code,用你的订阅",
      "",
      "用法:",
      "  wechatclaw-claude init     初始化配置(工作目录、白名单、权限)",
      "  wechatclaw-claude start    启动桥接(有配置时的默认命令)",
      "  wechatclaw-claude serve    启动 OpenAI 兼容服务(给 OpenClaw 等用)",
      "  wechatclaw-claude --help    显示本帮助",
      "",
      "serve 环境变量:WCC_HOST(127.0.0.1)、WCC_PORT(8760)、WCC_API_KEY(可选)",
      `配置文件:${defaultConfigPath()}`,
      "",
    ].join("\n"),
  );
}

async function runStart(): Promise<void> {
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    process.stdout.write("没找到配置 —— 先跑一遍初始化。\n\n");
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
    `桥接已启动 —— 渠道:${config.channel},工作目录:${config.defaultWorkspace}\n` +
      (config.channel === "terminal" ? "直接打字发消息。Ctrl+C 退出。\n" : ""),
  );
  await bridge.start();
}

function buildChannel(config: Config): ChannelAdapter {
  return config.channel === "wechat" ? new WeChatChannel() : new TerminalChannel();
}

async function runServe(): Promise<void> {
  const configPath = defaultConfigPath();
  if (!fs.existsSync(configPath)) {
    process.stdout.write("没找到配置 —— 先跑一遍初始化。\n\n");
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
      `OpenAI 兼容服务已启动:http://${host}:${port}/v1\n` +
        `  工作目录:${config.defaultWorkspace}\n` +
        `  鉴权:    ${apiKey ? "需要 Bearer 令牌(WCC_API_KEY)" : "无(仅限本地回环)"}\n` +
        "把 OpenClaw 的模型提供方指向这个地址。Ctrl+C 退出。\n",
    );
    // 预热默认会话,让第一条消息跳过 Claude 约 3.5 秒的冷启动。
    // 设 WCC_NO_PREWARM=1 可关闭。
    if (process.env.WCC_NO_PREWARM !== "1") {
      process.stdout.write("正在预热 Claude Code(约 6 秒)—— 等它热好再发第一条消息,回复才快。\n");
      backend.warm("default", config.defaultWorkspace, config.model);
    }
  });
}

async function runInit(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def?: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(def ? `${q} [${def}] ` : `${q} `, (a) => resolve(a.trim() || def || ""));
    });

  try {
    process.stdout.write("wechatclaw-claude 初始化\n\n");

    // 预检:整个「用订阅计费」的前提全靠这一步。
    await preflight();

    const existing = readExisting();

    // 没有安全默认值:工作目录。
    let workspace = "";
    while (!workspace) {
      const answer = await ask(
        "允许 agent 读写的工作目录:",
        existing?.defaultWorkspace ?? process.cwd(),
      );
      const resolved = path.resolve(answer);
      if (!fs.existsSync(resolved)) {
        process.stdout.write(`  ${resolved} 不存在 —— 请选一个已有的目录。\n`);
        continue;
      }
      workspace = resolved;
    }

    // 没有安全默认值:谁能跟它说话。终端渠道默认 "operator"。
    const sendersInput = await ask(
      "允许的发送者 id(逗号分隔):",
      existing?.allowedSenders.join(",") ?? "operator",
    );
    const allowedSenders = sendersInput
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // 有安全默认值:权限策略。
    process.stdout.write(
      "\n权限模式:\n" +
        "  plan               只读(最安全)\n" +
        "  acceptEdits        可改工作目录内的文件(默认)\n" +
        "  bypassPermissions  完全权限,含执行命令(需手动选)\n",
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
    validateConfig(config); // 写盘前先大声报错

    const configPath = defaultConfigPath();
    saveConfig(config, configPath);

    process.stdout.write(
      `\n已写入 ${configPath}\n` +
        `  工作目录:  ${workspace}\n` +
        `  发送者:    ${allowedSenders.join(", ") || "(空 —— 没人能跟它说话!)"}\n` +
        `  权限:      ${permissionMode}\n` +
        `  渠道:      terminal\n\n` +
        "想改什么直接编辑那个文件,或重新跑 `wechatclaw-claude init`。\n" +
        "启动:wechatclaw-claude start\n",
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
  const answer = (await ask("选一个:", def)) as PermissionMode;
  const mode: PermissionMode =
    answer === "plan" || answer === "acceptEdits" || answer === "bypassPermissions" ? answer : def;
  if (mode !== "bypassPermissions") return mode;

  // 从聊天应用来的无限制访问,该花一次刻意的击键。
  const confirm = await ask(`\nbypassPermissions 给的是整个磁盘的完全权限。重新输入一遍工作目录路径来确认:`);
  if (path.resolve(confirm) !== path.resolve(workspace)) {
    process.stdout.write("  不匹配 —— 退回到 acceptEdits。\n");
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
    process.stdout.write(`找到 Claude Code:${stdout.trim()}\n`);
    process.stdout.write("确认你已经登录(`claude auth`)—— 桥接用的是你的订阅。\n\n");
  } catch {
    process.stdout.write(
      "警告:跑不了 `claude --version`。请先装好 Claude Code 并登录,\n" +
        "否则第一条消息就会失败。\n\n",
    );
  }
}

void main();
