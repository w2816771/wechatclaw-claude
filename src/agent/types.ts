/**
 * An agent runtime. Knows nothing about chat platforms.
 *
 * The one seam between the bridge and whatever is actually answering. The
 * shipped implementation drives the Claude Code CLI (see claude-code.ts); the
 * interface is deliberately provider-neutral so an API-key / SDK backend could
 * drop in without the bridge noticing.
 */

/** One request to the agent. `conversationId` selects a resident session. */
export interface AgentTurn {
  conversationId: string;
  prompt: string;
  /** Absolute workspace directory the agent runs in. Containment is the caller's job. */
  cwd: string;
  /** Prior Claude session id to resume, if any. */
  sessionId?: string;
  model?: string;
}

/** Streamed as a turn runs. `done` is always the last event on success. */
export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "done"; text: string; sessionId?: string }
  | { type: "error"; message: string };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
}

export interface BackendCapabilities {
  /** Can a running turn be cancelled? */
  interrupt: boolean;
  /** Can prior-turn history be read back? */
  history: boolean;
  /** Per-tool permission prompts routed to the user (vs. a coarse up-front mode). */
  perToolPermission: boolean;
}

export interface AgentBackend {
  readonly id: string;
  run(turn: AgentTurn): AsyncIterable<AgentEvent>;
  interrupt(conversationId: string): Promise<void>;
  history(conversationId: string, sessionId: string): Promise<AgentMessage[]>;
  capabilities(): BackendCapabilities;
  dispose(): Promise<void>;
}
