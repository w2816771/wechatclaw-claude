import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PermissionMode } from "./agent/claude-code.js";

export interface Config {
  channel: "terminal" | "wechat";
  /** Absolute directories the agent may read/write. Containment is enforced against these. */
  workspaceRoots: string[];
  /** Where a conversation runs. Must resolve inside a workspace root. */
  defaultWorkspace: string;
  /** Deny-by-default allowlist of sender ids. Empty = nobody is allowed. */
  allowedSenders: string[];
  permissionMode: PermissionMode;
  model?: string;
  claudeBin: string;
  idleTimeoutMs: number;
  maxResident: number;
  enableMcpServers: boolean;
}

export function defaultConfigDir(home = os.homedir()): string {
  return path.join(home, ".wechatclaw-claude");
}

export function defaultConfigPath(home = os.homedir()): string {
  return path.join(defaultConfigDir(home), "config.json");
}

export function defaultConfig(workspace: string): Config {
  const resolved = path.resolve(workspace);
  return {
    channel: "terminal",
    workspaceRoots: [resolved],
    defaultWorkspace: resolved,
    allowedSenders: ["operator"],
    permissionMode: "acceptEdits",
    claudeBin: "claude",
    idleTimeoutMs: 10 * 60_000,
    maxResident: 4,
    enableMcpServers: false,
  };
}

/**
 * True when `target` resolves to a path inside one of `roots`. The one guard
 * that keeps a conversation from escaping its workspace, independent of the
 * agent's own sandbox (ARCHITECTURE §4.3).
 */
export function isWorkspaceAllowed(target: string, roots: string[]): boolean {
  const resolved = path.resolve(target);
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), resolved);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

export function loadConfig(configPath = defaultConfigPath()): Config {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validateConfig(parsed);
}

export function saveConfig(config: Config, configPath = defaultConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Fail fast with a clear message — this is a trust boundary, not internal data. */
export function validateConfig(value: unknown): Config {
  if (typeof value !== "object" || value === null) {
    throw new Error("config must be a JSON object");
  }
  const c = value as Record<string, unknown>;

  const roots = c.workspaceRoots;
  if (!Array.isArray(roots) || roots.length === 0 || !roots.every((r) => typeof r === "string")) {
    throw new Error("config.workspaceRoots must be a non-empty array of paths");
  }
  const absoluteRoots = roots.map((r) => path.resolve(r as string));

  const defaultWorkspace =
    typeof c.defaultWorkspace === "string" ? path.resolve(c.defaultWorkspace) : absoluteRoots[0];
  if (!isWorkspaceAllowed(defaultWorkspace, absoluteRoots)) {
    throw new Error("config.defaultWorkspace must be inside a workspaceRoots entry");
  }

  const senders = c.allowedSenders;
  if (!Array.isArray(senders) || !senders.every((s) => typeof s === "string")) {
    throw new Error("config.allowedSenders must be an array of strings");
  }

  const permissionMode = c.permissionMode;
  if (permissionMode !== "plan" && permissionMode !== "acceptEdits" && permissionMode !== "bypassPermissions") {
    throw new Error('config.permissionMode must be "plan", "acceptEdits", or "bypassPermissions"');
  }

  const channel = c.channel === "wechat" ? "wechat" : "terminal";

  return {
    channel,
    workspaceRoots: absoluteRoots,
    defaultWorkspace,
    allowedSenders: senders as string[],
    permissionMode,
    model: typeof c.model === "string" ? c.model : undefined,
    claudeBin: typeof c.claudeBin === "string" ? c.claudeBin : "claude",
    idleTimeoutMs: nonNegative(c.idleTimeoutMs, 10 * 60_000),
    maxResident: nonNegative(c.maxResident, 4),
    enableMcpServers: c.enableMcpServers === true,
  };
}

function nonNegative(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
