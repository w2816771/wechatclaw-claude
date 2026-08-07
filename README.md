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
machine, and your Claude Code credentials never leave it.

## Design in one page

Built on [`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk),
not on spawning the `claude` CLI. That single decision removes the process pool,
the session-file scraping, and the kill-to-cancel semantics that a
subprocess-driven bridge is forced into — see
[ARCHITECTURE §2](docs/ARCHITECTURE.md#2-the-core-decision-sdk-not-subprocess)
for the mapping, including measurements from the predecessor design that
motivated it.

Two interfaces carry the whole system:

- **`ChannelAdapter`** — a messaging platform. Knows nothing about agents.
- **`AgentBackend`** — an agent runtime. Knows nothing about chat platforms.

Adding a channel means implementing one interface, in one directory, touching
nothing else.

## Design principles

1. **The agent runtime is a dependency, not a subprocess.**
2. **Permissions are a policy, not a flag.** Write and exec actions ask for
   confirmation in the chat thread by default. An agent you can reach from your
   phone should not start with unrestricted access to your disk.
3. **Channel-neutral core.** No platform's vocabulary in a shared signature.
4. **Degrade explicitly.** Backends declare capabilities; the bridge adapts
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
