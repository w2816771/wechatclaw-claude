import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig, isWorkspaceAllowed, validateConfig } from "../src/config.js";

const root = path.resolve(os.tmpdir(), "wcc-ws");

test("isWorkspaceAllowed enforces containment and rejects escapes", () => {
  assert.equal(isWorkspaceAllowed(root, [root]), true);
  assert.equal(isWorkspaceAllowed(path.join(root, "sub", "deep"), [root]), true);
  assert.equal(isWorkspaceAllowed(path.join(root, "..", "elsewhere"), [root]), false);
  assert.equal(isWorkspaceAllowed("/etc", [root]), false);
});

test("defaultConfig is valid and deny-by-default-ish", () => {
  const config = validateConfig(defaultConfig(root));
  assert.equal(config.channel, "terminal");
  assert.deepEqual(config.workspaceRoots, [root]);
  assert.equal(config.permissionMode, "acceptEdits");
  assert.equal(config.enableMcpServers, false);
});

test("validateConfig rejects an empty workspaceRoots", () => {
  assert.throws(() => validateConfig({ workspaceRoots: [], allowedSenders: [], permissionMode: "plan" }), /workspaceRoots/);
});

test("validateConfig rejects a defaultWorkspace outside the roots", () => {
  assert.throws(
    () =>
      validateConfig({
        workspaceRoots: [root],
        defaultWorkspace: path.join(root, "..", "nope"),
        allowedSenders: [],
        permissionMode: "plan",
      }),
    /defaultWorkspace/,
  );
});

test("validateConfig rejects an unknown permission mode", () => {
  assert.throws(
    () => validateConfig({ workspaceRoots: [root], allowedSenders: [], permissionMode: "yolo" }),
    /permissionMode/,
  );
});
