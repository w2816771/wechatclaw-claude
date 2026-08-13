# wechatclaw-claude

**English** · [中文](README.zh-CN.md)

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
wizard, a **terminal channel**, and an **OpenAI-compatible `serve` endpoint** all
work today and are covered by tests. WeChat runs through OpenClaw pointed at that
endpoint — see [WeChat via OpenClaw](#wechat-via-openclaw).

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
  server/       OpenAI-compatible endpoint (for OpenClaw etc.)
  config.ts     schema, validation, workspace containment check
  bridge.ts     routing, access control, adaptive reply streaming
  cli.ts        init wizard + start + serve
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

## WeChat via OpenClaw

WeChat goes through [OpenClaw](https://github.com/openclaw/openclaw) — a local
gateway that owns the chat channels — with wechatclaw-claude as the **model**
behind it. OpenClaw handles WeChat through Tencent's **official** Weixin plugin
(in WeChat: 我 → 设置 → 插件 → ClawBot, OAuth QR — no reverse-engineering, no ban
risk); for each message it calls this project's OpenAI-compatible endpoint, which
runs Claude Code on your subscription and streams the reply back.

```
WeChat ──► OpenClaw (official Weixin plugin) ──► wechatclaw-claude serve ──► Claude Code
```

The same `serve` endpoint works for any OpenAI-compatible frontend, so this also
gets you Claude-on-subscription for OpenClaw's other 30+ channels (Telegram,
Slack, …).

**Setup:**

```bash
# 1. Start the model endpoint (this project) — verified working
node dist/cli.js serve                    # → http://127.0.0.1:8760/v1

# 2. Install OpenClaw + the official WeChat plugin, then scan the QR (your phone)
npm install -g openclaw
openclaw onboard --install-daemon
npx -y @tencent-weixin/openclaw-weixin-cli install
openclaw channels login --channel openclaw-weixin

# 3. Point OpenClaw's model provider at the serve endpoint (base URL above,
#    OpenAI-compatible). Confirm the exact provider-config fields for your
#    OpenClaw version in its model-provider docs.
```

Step 1 is tested end-to-end (streaming + multi-turn) against Claude Code. Steps
2–3 run on your machine — the QR scan is yours to do, and the OpenClaw
provider-config field names should be confirmed against your installed version.

> Note: OpenClaw is a gateway that routes each channel message to a model, so the
> integration point is this OpenAI endpoint — not a `ChannelAdapter`.
> [`src/channel/wechat.ts`](src/channel/wechat.ts) stays only as a stub for a
> hypothetical *direct* WeChat adapter, which is not the recommended path.

## Security

- Loopback-bound; no inbound network port is opened.
- Sender allowlist is deny-by-default — an unknown sender is refused.
- Workspace paths are containment-checked in the bridge, independently of the
  agent's own sandboxing.
- Secrets are read from the environment, never written to the config file.

## Performance notes

- **First message after `serve` starts** pays Claude Code's cold boot (hooks,
  plugin sync, CLAUDE.md scan). `serve` pre-warms a process at startup, so as
  long as your first message lands a few seconds after boot, it skips the cold
  start (~7s → ~4-5s here). Disable with `WCC_NO_PREWARM=1`.
- **Every message** then costs the model's own response time (~3-4s for
  `sonnet`). That floor is the model, not this bridge — set `model` to `haiku`
  in the config for noticeably faster (if less capable) replies.
- The HTTP server and localhost networking add negligible latency (a few ms).

## Development

```bash
npm run typecheck
npm test          # 24 tests: backend, streaming, resident pool, config, OpenAI server
npm run dev       # run the CLI from source via tsx
```

## Credits

This project follows the implementation of
[XavierJiezou/codex-weixin](https://github.com/XavierJiezou/codex-weixin) (MIT) —
a bridge from personal WeChat to a local Codex. The whole "bridge a chat account
to a local agent" idea comes from it, and several key parts of
`agent/claude-code.ts` are adapted from its code:

- **Finding and launching the CLI** — on Windows, prefer the native exe, fall
  back to the `.cmd` shim (via `cmd.exe`), run `.js` through node. Adapted from
  its `resolveCodexCommand`.
- **Parsing stream-json output** — reading JSON line by line, pulling out the
  final text and session id. Adapted from its `parseCodexExecOutput`.
- **The resident-process protocol** — feeding turns over stdin, reading replies
  off stdout, `windowsHide`, and the overall shape of driving the CLI.

What changed: this reworks it into a resident-process **pool** (start once, reuse
across turns), hides all of it behind the `AgentBackend` interface, and cleanly
separates the agent from the chat channel. The **WeChat integration is not
copied from it** — that goes through the official OpenClaw Weixin channel instead
(see [WeChat via OpenClaw](#wechat-via-openclaw)).

## License

MIT — see [LICENSE](LICENSE).
