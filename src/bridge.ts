import type { AgentBackend } from "./agent/types.js";
import type { ChannelAdapter, InboundMessage, Recipient } from "./channel/types.js";
import { isWorkspaceAllowed, type Config } from "./config.js";

interface Conversation {
  sessionId?: string;
  workspace: string;
}

/**
 * Routes messages between one channel and one agent backend.
 *
 * Everything provider- and platform-specific lives below the two interfaces;
 * this file only knows Config, ChannelAdapter, and AgentBackend. It owns access
 * control, per-sender session continuity, and the reply strategy.
 */
export class Bridge {
  private readonly conversations = new Map<string, Conversation>();

  constructor(
    private readonly channel: ChannelAdapter,
    private readonly agent: AgentBackend,
    private readonly config: Config,
  ) {}

  async start(): Promise<void> {
    await this.channel.start((message) => this.onInbound(message));
  }

  async stop(): Promise<void> {
    await this.channel.stop();
    await this.agent.dispose();
  }

  private async onInbound(message: InboundMessage): Promise<void> {
    const { from } = message;
    if (!this.config.allowedSenders.includes(from.senderId)) {
      await this.reply(from, `Access denied. Add "${from.senderId}" to allowedSenders to pair.`);
      return;
    }

    const conversationId = `${from.channelId}:${from.senderId}`;
    const conversation = this.conversations.get(conversationId) ?? {
      workspace: this.config.defaultWorkspace,
    };
    this.conversations.set(conversationId, conversation);

    // Defense in depth: never run outside an allowed root, whatever state says.
    if (!isWorkspaceAllowed(conversation.workspace, this.config.workspaceRoots)) {
      await this.reply(from, "Workspace is not inside an allowed root. Refusing to run.");
      return;
    }

    try {
      await this.runTurn(conversationId, conversation, from, message.text);
    } catch (error) {
      await this.reply(from, `Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runTurn(
    conversationId: string,
    conversation: Conversation,
    to: Recipient,
    prompt: string,
  ): Promise<void> {
    const streaming = typeof this.channel.edit === "function";
    const events = this.agent.run({
      conversationId,
      prompt,
      cwd: conversation.workspace,
      sessionId: conversation.sessionId,
      model: this.config.model,
    });

    // Adaptive reply strategy (ARCHITECTURE §4.1): edit-in-place when the
    // channel supports it, otherwise buffer and send once.
    let acc = "";
    let ref: Awaited<ReturnType<ChannelAdapter["send"]>> | undefined;
    let lastEdit = 0;

    for await (const event of events) {
      if (event.type === "delta") {
        acc += event.text;
        if (streaming) {
          const now = Date.now();
          if (!ref) ref = await this.channel.send(to, { text: acc });
          else if (now - lastEdit > 500) {
            await this.channel.edit!(ref, { text: acc });
            lastEdit = now;
          }
        }
      } else if (event.type === "done") {
        if (event.sessionId) conversation.sessionId = event.sessionId;
        const text = event.text || acc || "(no response)";
        if (streaming && ref) await this.channel.edit!(ref, { text });
        else await this.channel.send(to, { text });
      } else if (event.type === "error") {
        await this.reply(to, `Error: ${event.message}`);
      }
      // tool events are progress-only; v0.1 folds them into the final answer.
    }
  }

  private async reply(to: Recipient, text: string): Promise<void> {
    await this.channel.send(to, { text });
  }
}
