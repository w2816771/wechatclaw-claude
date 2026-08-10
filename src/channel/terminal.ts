import readline from "node:readline";

import type {
  ChannelAdapter,
  InboundSink,
  MessageRef,
  OutboundMessage,
  Recipient,
} from "./types.js";

/**
 * A channel that reads from stdin and writes to stdout — the local operator
 * talking to their own agent in a terminal.
 *
 * It exists so the whole pipe (channel → bridge → agent → back) is runnable and
 * testable with zero external accounts. It supports edit(), so the bridge
 * exercises its streaming path here too.
 */
export class TerminalChannel implements ChannelAdapter {
  readonly id = "terminal";
  private rl?: readline.Interface;
  private lastLineHadOutput = false;

  constructor(private readonly senderId = "operator") {}

  async start(sink: InboundSink): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt("you › ");
    this.rl.prompt();
    this.rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }
      await sink({ from: { channelId: this.id, senderId: this.senderId }, text });
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
  }

  async send(_to: Recipient, message: OutboundMessage): Promise<MessageRef> {
    process.stdout.write(`\nclaude › ${message.text}\n`);
    this.lastLineHadOutput = true;
    this.rl?.prompt();
    return { id: String(Date.now()) };
  }

  // Terminals can't truly edit a prior line once the prompt moved on, so the
  // "edit" is a fresh append. Good enough to exercise the streaming path.
  async edit(_ref: MessageRef, message: OutboundMessage): Promise<void> {
    process.stdout.write(`\nclaude › ${message.text}\n`);
    this.lastLineHadOutput = true;
  }
}
