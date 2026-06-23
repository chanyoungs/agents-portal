// Thin wrappers over the tmux CLI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync } from 'node:fs';
import type { SessionInfo } from '../shared/protocol.js';

const exec = promisify(execFile);

export interface ClaudeSession {
  session: string;
  cwd: string;
  /** Unix seconds the Claude process started (for transcript matching). */
  start: number;
}

function bootTime(): number {
  try {
    for (const l of readFileSync('/proc/stat', 'utf8').split('\n')) if (l.startsWith('btime')) return Number(l.split(/\s+/)[1]);
  } catch { /* not linux */ }
  return 0;
}

/** pid → { ppid, comm, start(jiffies) } from /proc. */
function procTable(): Map<number, { ppid: number; comm: string; start: number }> {
  const m = new Map<number, { ppid: number; comm: string; start: number }>();
  let names: string[] = [];
  try { names = readdirSync('/proc'); } catch { return m; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const s = readFileSync(`/proc/${n}/stat`, 'utf8');
      const rp = s.lastIndexOf(')');
      const comm = s.slice(s.indexOf('(') + 1, rp);
      const rest = s.slice(rp + 2).split(' ');
      m.set(Number(n), { ppid: Number(rest[1]), comm, start: Number(rest[19]) });
    } catch { /* race: pid gone */ }
  }
  return m;
}

/**
 * All tmux sessions running Claude, with the Claude process's start time — used
 * to map each session to its own transcript (sessions can share a cwd).
 */
export async function claudeSessions(): Promise<ClaudeSession[]> {
  let stdout = '';
  try {
    ({ stdout } = await exec('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}']));
  } catch { return []; }
  const table = procTable();
  const children = new Map<number, number[]>();
  for (const [pid, info] of table) {
    const a = children.get(info.ppid) ?? [];
    a.push(pid);
    children.set(info.ppid, a);
  }
  const findClaude = (root: number): number | null => {
    const stack = [root];
    while (stack.length) {
      const p = stack.pop()!;
      if (table.get(p)?.comm === 'claude') return p;
      for (const c of children.get(p) ?? []) stack.push(c);
    }
    return null;
  };
  const btime = bootTime();
  const out = new Map<string, ClaudeSession>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [session, panePid, cmd, cwd] = line.split('\t');
    if (cmd !== 'claude') continue;
    const cp = findClaude(Number(panePid)) ?? Number(panePid);
    const info = table.get(cp);
    if (!info) continue;
    const start = btime + info.start / 100; // USER_HZ = 100 on Linux
    if (!out.has(session)) out.set(session, { session, cwd, start });
  }
  return [...out.values()];
}

/** Fields we ask tmux to print, tab-separated, one line per session. */
const FORMAT = [
  '#{session_name}',
  '#{session_windows}',
  '#{pane_current_path}',
  '#{session_attached}',
  '#{session_created}',
].join('\t');

/** List all tmux sessions. Returns [] when the server isn't running. */
export async function listSessions(): Promise<SessionInfo[]> {
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', FORMAT]);
    return stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [name, windows, cwd, attached, created] = line.split('\t');
        return {
          name,
          windows: Number(windows) || 0,
          cwd: cwd ?? '',
          attached: attached === '1',
          created: Number(created) || 0,
        };
      });
  } catch {
    return [];
  }
}

/** Current working directory of a session's active pane. */
export async function sessionCwd(session: string): Promise<string> {
  try {
    const { stdout } = await exec('tmux', ['display-message', '-p', '-t', session, '#{pane_current_path}']);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  try {
    await exec('tmux', ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
}

/** Capture scrollback + current screen (with colors) to prime a new viewer. */
export async function capturePane(session: string, lines = 3000): Promise<string> {
  try {
    const { stdout } = await exec('tmux', [
      'capture-pane', '-p', '-e', '-S', `-${lines}`, '-t', session,
    ]);
    return stdout.replace(/\n/g, '\r\n'); // xterm needs CR+LF
  } catch {
    return '';
  }
}

/**
 * Create a grouped session sharing `target`'s windows, so a web client gets its
 * own view (independent current window + size) without disturbing other clients.
 * Mouse on (clicks/scroll work). Cleaned up explicitly on detach (we can't use
 * destroy-unattached here — it would kill the freshly-created detached session
 * before we attach). Orphans are swept on agent startup.
 */
export async function newGroupedSession(name: string, target: string): Promise<void> {
  await exec('tmux', ['new-session', '-d', '-s', name, '-t', target]);
  // mouse on; size shared windows to the most recently active client (so the
  // window fits whichever device is currently being used).
  for (const opt of [['mouse', 'on'], ['window-size', 'latest']]) {
    try { await exec('tmux', ['set-option', '-t', name, opt[0], opt[1]]); } catch { /* non-fatal */ }
  }
}

export async function killSession(name: string): Promise<void> {
  try { await exec('tmux', ['kill-session', '-t', name]); } catch { /* may already be gone */ }
}

/** Kill leftover web-client grouped sessions (e.g. after an agent crash). */
export async function killStaleGroups(): Promise<void> {
  try {
    const { stdout } = await exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    for (const name of stdout.split('\n')) {
      if (name.startsWith('_ap_')) await killSession(name);
    }
  } catch { /* no server / no sessions */ }
}

/** Visible (no scrollback) text of a pane — used to detect the busy spinner. */
export async function paneVisible(target: string): Promise<string> {
  try {
    const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', target]);
    return stdout;
  } catch {
    return '';
  }
}

/** Begin piping the pane's raw output to a file (unbuffered). */
export async function startPipe(session: string, file: string): Promise<void> {
  await exec('tmux', ['pipe-pane', '-o', '-t', session, `stdbuf -o0 cat >> '${file}'`]);
}

/** Stop piping the pane's output. */
export async function stopPipe(session: string): Promise<void> {
  try {
    await exec('tmux', ['pipe-pane', '-t', session]);
  } catch {
    // session may have closed — non-fatal
  }
}

/**
 * Fix the pane to an explicit size and resize to the (active) client's
 * dimensions, so the raw output we stream matches the renderer's grid.
 */
export async function resizeWindow(session: string, cols: number, rows: number): Promise<void> {
  try {
    await exec('tmux', ['set-option', '-t', session, 'window-size', 'manual']);
    await exec('tmux', ['resize-window', '-t', session, '-x', String(cols), '-y', String(rows)]);
  } catch {
    // non-fatal
  }
}

/** Write raw input bytes to a target (session or pane id) as hex key events. */
export async function sendRaw(target: string, data: string): Promise<void> {
  const hex = Buffer.from(data, 'utf8').toString('hex').match(/.{2}/g);
  if (!hex) return;
  try {
    await exec('tmux', ['send-keys', '-t', target, '-H', ...hex]);
  } catch {
    // non-fatal
  }
}

/**
 * Send a (possibly multi-line) message via bracketed paste, so newlines are
 * inserted literally instead of each acting as Enter. Caller sends Enter after.
 */
export async function sendText(target: string, data: string): Promise<void> {
  try {
    await exec('tmux', ['set-buffer', '--', data]);
    await exec('tmux', ['paste-buffer', '-t', target, '-p', '-d']);
  } catch {
    // non-fatal
  }
}

/** Send a proper Enter keypress (submits in most TUIs). */
export async function sendEnter(target: string): Promise<void> {
  try {
    await exec('tmux', ['send-keys', '-t', target, 'Enter']);
  } catch {
    // non-fatal
  }
}

/**
 * Find the pane actually running the agent in a session, so chat input goes to
 * Claude/Codex rather than whatever window happens to be active. Prefers an
 * agent-like command at the transcript's cwd; falls back to the session.
 */
export async function findAgentPane(session: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('tmux', [
      'list-panes', '-s', '-t', session,
      '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_current_path}',
    ]);
    const rows = stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
    const agent = /^(claude|codex|node|bun|deno|python|python3)$/;
    const pick =
      rows.find(([, cmd, p]) => p === cwd && agent.test(cmd)) ??
      rows.find(([, , p]) => p === cwd) ??
      rows.find(([, cmd]) => agent.test(cmd));
    return pick ? pick[0] : session;
  } catch {
    return session;
  }
}
