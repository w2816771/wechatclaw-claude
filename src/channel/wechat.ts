import type {
  ChannelAdapter,
  InboundSink,
  MessageRef,
  OutboundMessage,
  Recipient,
} from "./types.js";

/**
 * WeChat channel — a stub, and NOT the recommended path for WeChat.
 *
 * WeChat runs through OpenClaw, which is a gateway that routes each channel
 * message to a *model* — so the real integration point is the OpenAI-compatible
 * `serve` endpoint (see src/server/openai.ts and the "WeChat via OpenClaw"
 * section of the README), not a ChannelAdapter. OpenClaw owns the official
 * Weixin plugin (OAuth QR, no reverse-engineering); we are the model it calls.
 *
 * This stub remains only for a hypothetical *direct* WeChat ChannelAdapter
 * (bypassing OpenClaw). If you build that, call `sink(...)` for each inbound
 * message and fulfill `send()` — everything above the seam already works.
 */
export class WeChatChannel implements ChannelAdapter {
  readonly id = "wechat";

  async start(_sink: InboundSink): Promise<void> {
    throw new Error(
      "WeChat channel is a stub — wire it to the OpenClaw Weixin plugin " +
        "(@tencent-weixin/openclaw-weixin-cli). The terminal channel works today.",
    );
  }

  async stop(): Promise<void> {}

  async send(_to: Recipient, _message: OutboundMessage): Promise<MessageRef> {
    throw new Error("WeChat channel is a stub.");
  }
}
