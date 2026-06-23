// Thin wrappers over the tmux CLI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionInfo } from '../shared/protocol.js';

const exec = promisify(execFile);

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

/** Write raw input bytes to a session as hex key events (handles any byte). */
export async function sendRaw(session: string, data: string): Promise<void> {
  const hex = Buffer.from(data, 'utf8').toString('hex').match(/.{2}/g);
  if (!hex) return;
  try {
    await exec('tmux', ['send-keys', '-t', session, '-H', ...hex]);
  } catch {
    // non-fatal
  }
}
