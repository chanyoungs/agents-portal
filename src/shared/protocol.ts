// Wire protocol between the browser SPA and a workstation agent.
//
// There is no relay. The SPA connects directly to each agent over the tailnet:
//   • REST  GET /api/info, GET /api/sessions
//   • WS    /ws/terminal?session=<name>&token=<token>
// The agent bridges that WS to a tmux session via node-pty.

export const PROTOCOL_VERSION = 1;

/** A tmux session as reported by an agent. */
export interface SessionInfo {
  name: string;
  windows: number;
  /** Current working directory of the active pane (#{pane_current_path}). */
  cwd: string;
  attached: boolean;
  /** Unix seconds the session was created. */
  created: number;
  /** Coding agent running in the session, if any ('claude' | 'codex'). */
  agent?: string;
}

/** GET /api/info response — also used as a token/liveness check. */
export interface HostInfo {
  hostName: string;
  version: string;
  protocol: number;
}

// ── Client → Agent (over the terminal WebSocket) ────────────────────────────
export type ClientToAgent =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

// ── Agent → Client (over the terminal WebSocket) ────────────────────────────
// `output.data` is base64-encoded raw terminal bytes (base64 keeps multi-byte
// UTF-8 sequences intact across chunk boundaries; the client decodes to bytes
// and writes them straight into xterm).
export type AgentToClient =
  | { type: 'output'; data: string }
  | { type: 'closed'; reason: string };

export function encode(msg: unknown): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string | Buffer): T {
  return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as T;
}
