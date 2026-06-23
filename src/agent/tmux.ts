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
    // `tmux list-sessions` exits non-zero when no server is running.
    return [];
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

/** Send a literal string of keys to a session (used for path injection later). */
export async function sendKeys(session: string, keys: string, enter = false): Promise<void> {
  await exec('tmux', ['send-keys', '-t', session, keys]);
  if (enter) await exec('tmux', ['send-keys', '-t', session, 'Enter']);
}
