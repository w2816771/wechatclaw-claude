# wechatclaw-claude

Talk to [Claude Code](https://code.claude.com) running on your own machine, from
a chat app — on your **existing Claude Code subscription**, not a metered API
bill.

```
   your chat app  ──►  wechatclaw-claude  ──►  Claude Code  ──►  your files
                        (localhost)             (your login)
```

Nothing is hosted. The service binds to loopback, your files stay on your
machine, and it runs on the Claude Code login you already have.

## Status

**v0.1 — runnable core.** The agent backend, the bridge, config, the setup
wizard, and a **terminal channel** all work today and are covered by tests. The
**WeChat channel is a stub** — see [Why WeChat is a stub](#why-wechat-is-a-stub).

## Quickstart

Requires Node ≥ 22 and Claude Code installed and logged in (`claude auth`).

```bash
npm install
npm run build
node dist/cli.js init     # set workspace, allowlist, permissions
node dist/cli.js start    # then type at the prompt
```

`init` walks you through the choices that have **no safe default** — which
directory the agent may touch, and who is allowed to message it — and writes a
config you can hand-edit. It never re-asks on upgrade.

`start` with the terminal channel drops you at a `you ›` prompt; replies stream
back as `claude ›`. That is the whole pipe — channel → bridge → agent → back —
running end to end with no external account.

## How it's built

It drives the `claude` CLI (`-p`), **not** the Agent SDK — deliberately, because
the CLI runs on your **subscription** while the SDK would force every user onto
metered **API** billing. This tool is for individuals who already pay for a
subscription. See
[ARCHITECTURE §2](docs/ARCHITECTURE.md#2-the-core-decision-subprocess-deliberately).

Two interfaces carry the whole system, so a new chat platform or a future
API-key backend drops in without touching anything else:

- **`AgentBackend`** — an agent runtime. Knows nothing about chat platforms.
  The shipped one keeps a resident `claude` process per conversation (a cold
  turn pays ~4s of Claude Code startup; a warm one ~250ms).
- **`ChannelAdapter`** — a messaging platform. Knows nothing about agents.

```
src/
  agent/        AgentBackend interface + the claude-code resident-pool backend
  channel/      ChannelAdapter interface + terminal channel + wechat stub
  config.ts     schema, validation, workspace containment check
  bridge.ts     routing, access control, adaptive reply streaming
  cli.ts        init wizard + start
```

## Design principles

1. **Billing model decides the mechanism.** CLI subprocess rides your
   subscription; the SDK bills per token. Individual users, so: subprocess.
2. **The subprocess is encapsulated, never exposed.** Exactly one backend knows
   about processes, PIDs, and session files. The bridge sees only events.
3. **Permissions are a policy, not a flag.** Default is `acceptEdits` (edit
   files in the workspace); read-only `plan` and full-access `bypassPermissions`
   are opt-in — the latter needs a typed confirmation in the wizard.
4. **Channel-neutral core.** No platform's vocabulary in a shared signature.

## Why WeChat is a stub

Automating a personal WeChat account means driving reverse-engineered,
undocumented endpoints, and it violates Tencent's Terms of Service — it can get
the account banned. That integration is the operator's to supply, on their own
account and their own risk; this project does not ship or redistribute it.
[`src/channel/wechat.ts`](src/channel/wechat.ts) is the interface to implement;
everything above the `ChannelAdapter` seam already works, exercised by the
terminal channel.

## Security

- Loopback-bound; no inbound network port is opened.
- Sender allowlist is deny-by-default — an unknown sender is refused.
- Workspace paths are containment-checked in the bridge, independently of the
  agent's own sandboxing.
- Secrets are read from the environment, never written to the config file.

## Development

```bash
npm run typecheck
npm test          # 18 tests: backend, streaming, resident pool, config
npm run dev       # run the CLI from source via tsx
```

## License

MIT — see [LICENSE](LICENSE).
