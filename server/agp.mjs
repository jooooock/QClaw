import { randomUUID } from "node:crypto";

/**
 * AGP (Agent Gateway Protocol) message helpers
 */

/** Create a session.prompt envelope */
export function createPrompt(sessionId, promptId, text, guid = "", userId = "") {
  return {
    msg_id: randomUUID(),
    guid,
    user_id: userId,
    method: "session.prompt",
    payload: {
      session_id: sessionId,
      prompt_id: promptId,
      agent_app: "agent_main",
      content: [{ type: "text", text }],
    },
  };
}

/** Create a session.cancel envelope */
export function createCancel(sessionId, promptId, guid = "", userId = "") {
  return {
    msg_id: randomUUID(),
    guid,
    user_id: userId,
    method: "session.cancel",
    payload: {
      session_id: sessionId,
      prompt_id: promptId,
      agent_app: "agent_main",
    },
  };
}

/** Generate a new session ID */
export function newSessionId() {
  return `session-${randomUUID()}`;
}

/** Generate a new prompt (turn) ID */
export function newPromptId() {
  return `turn-${randomUUID()}`;
}
