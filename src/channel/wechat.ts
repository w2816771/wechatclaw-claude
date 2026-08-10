import type {
  ChannelAdapter,
  InboundSink,
  MessageRef,
  OutboundMessage,
  Recipient,
} from "./types.js";

/**
 * WeChat channel — intentionally a stub.
 *
 * Automating a personal WeChat account means driving reverse-engineered,
 * undocumented endpoints, and it is against Tencent's Terms of Service — it can
 * get the account banned. That integration is therefore the operator's to
 * supply, on their own account and their own risk; this project does not ship,
 * bundle, or redistribute it.
 *
 * To wire a real WeChat client in, implement this interface: call `sink(...)`
 * for each inbound message, and fulfill `send()` against the client. Everything
 * above the ChannelAdapter seam — routing, access control, reply chunking,
 * streaming — already works and is exercised by the terminal channel.
 */
export class WeChatChannel implements ChannelAdapter {
  readonly id = "wechat";

  async start(_sink: InboundSink): Promise<void> {
    throw new Error(
      "WeChat channel is a stub. See src/channel/wechat.ts — you must supply the " +
        "WeChat client integration yourself. The terminal channel works today.",
    );
  }

  async stop(): Promise<void> {}

  async send(_to: Recipient, _message: OutboundMessage): Promise<MessageRef> {
    throw new Error("WeChat channel is a stub.");
  }
}
