/**
 * A messaging platform. Knows nothing about agents.
 *
 * The bridge drives this; an adapter never imports anything from ../agent.
 */

/** Who a message is from / to, in the channel's own id space. */
export interface Recipient {
  channelId: string;
  senderId: string;
}

export interface InboundMessage {
  from: Recipient;
  text: string;
}

export interface OutboundMessage {
  text: string;
}

/** Opaque handle a channel returns from send(), for a later edit(). */
export interface MessageRef {
  id: string;
}

/** The bridge hands each adapter this to deliver inbound messages. */
export type InboundSink = (message: InboundMessage) => void | Promise<void>;

export interface ChannelAdapter {
  readonly id: string;
  start(sink: InboundSink): Promise<void>;
  stop(): Promise<void>;
  send(to: Recipient, message: OutboundMessage): Promise<MessageRef>;
  /**
   * Edit a previously sent message in place, for token streaming. Absent means
   * the platform can't edit, so the bridge batches replies instead.
   */
  edit?(ref: MessageRef, message: OutboundMessage): Promise<void>;
}
