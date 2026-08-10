# codex-claude

Talk to [Claude Code](https://code.claude.com) running on your own machine, from
whatever chat app you already have open.

> **Status: design stage.** The architecture is settled and written up in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Implementation has not started.

## What it is

A local bridge. It runs on your machine, connects to a messaging platform, and
routes messages to a Claude Code agent working in a directory you nominate.

```
   your phone  ──►  chat platform  ──►  codex-claude  ──►  Claude Code
                                        (localhost)        (your files)
```

Nothing is hosted. The service binds to loopback, your files stay on your
machine, and it runs on **your existing Claude Code subscription** — no
per-token API bill.

## Design in one page

It drives the `claude` CLI (`-p`), **not** the Agent SDK — a deliberate choice,
because the CLI runs on your Claude Code **subscription** while the SDK would
force every user onto metered **API** billing. This tool is for individuals who
already pay for a subscription, so the subprocess approach (and the resident
process pool that makes it fast) is kept on purpose, not tolerated. See
[ARCHITECTURE §2](docs/ARCHITECTURE.md#2-the-core-decision-subprocess-deliberately)
for the tradeoff and the warm/cold latency numbers.

The rewrite's value is **structure**, not mechanism: two interfaces carry the
whole system, so a new chat platform or a future API-key backend drops in
without touching anything else.

First run walks you through the choices that have no safe default — which
directories the agent may touch, and who is allowed to message it — via
`codex-claude init`. It runs once, writes a config you can hand-edit, and never
re-asks on upgrade. See
[ARCHITECTURE §5](docs/ARCHITECTURE.md#5-setup-the-confirm-before-run-wizard).

- **`ChannelAdapter`** — a messaging platform. Knows nothing about agents.
- **`AgentBackend`** — an agent runtime. Knows nothing about chat platforms.

Adding a channel means implementing one interface, in one directory, touching
nothing else.

## Design principles

1. **Billing model decides the mechanism.** The CLI subprocess rides your
   subscription; the SDK bills per token. Individual users, so: subprocess.
2. **The subprocess is encapsulated, never exposed.** Exactly one backend knows
   about processes, PIDs, and session files. The bridge above sees only events.
3. **Permissions are a policy, not a flag.** Write and exec actions ask for
   confirmation in the chat thread by default. An agent you can reach from your
   phone should not start with unrestricted access to your disk.
4. **Channel-neutral core.** No platform's vocabulary in a shared signature.
5. **Degrade explicitly.** Backends declare capabilities; the bridge adapts
   rather than pretending.

## Security

- Loopback-bound; no inbound port is opened to a network.
- Sender allowlist is deny-by-default — an unknown sender is refused until
  explicitly paired.
- Workspace paths are containment-checked in the bridge, independently of
  whatever sandboxing the agent applies.
- Secrets are read from the environment. Never commit a config file with
  credentials in it.

## Contributing

Discussion of the architecture is welcome before code exists — that is the
cheapest time to change it. Open an issue.

## License

MIT
