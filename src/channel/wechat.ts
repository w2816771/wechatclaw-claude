import type {
  ChannelAdapter,
  InboundSink,
  MessageRef,
  OutboundMessage,
  Recipient,
} from "./types.js";

/**
 * WeChat channel — a stub, to be wired to the official OpenClaw Weixin channel.
 *
 * Integration goes through Tencent's sanctioned agent plugin, installed via
 * `@tencent-weixin/openclaw-weixin-cli` and authorized in-app (WeChat → 设置 →
 * 插件 → ClawBot) with an OAuth QR code. No reverse-engineered protocols, no
 * personal-account automation — so nothing here risks a ban or redistributes
 * someone else's endpoints.
 *
 * To implement: install/attach the OpenClaw Weixin plugin, call `sink(...)` for
 * each inbound message, and fulfill `send()` against it. Everything above the
 * ChannelAdapter seam — routing, access control, reply streaming — already
 * works and is exercised by the terminal channel.
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
