// Agent configuration, persisted at ~/.config/agents-portal/config.json.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** Local port the agent listens on (127.0.0.1 only; tailscale serve fronts it). */
  port: number;
  /** Shared secret required on WS/REST requests. Auto-generated on first run. */
  token: string;
  /** Display name for this host in the dashboard. */
  hostName: string;
  /**
   * If set, only these Tailscale logins may access the agent. Empty = any
   * authenticated tailnet member (tailnet membership is already the boundary).
   */
  allowedLogins: string[];
}

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'agents-portal');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS: Omit<Config, 'token' | 'allowedLogins'> = {
  port: 7420,
  hostName: hostname(),
};

export function loadConfig(): Config {
  let stored: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
      // Corrupt config — fall back to defaults rather than crash.
    }
  }
  const cfg: Config = {
    port: stored.port ?? DEFAULTS.port,
    hostName: stored.hostName ?? DEFAULTS.hostName,
    token: stored.token ?? randomBytes(24).toString('base64url'),
    allowedLogins: stored.allowedLogins ?? [],
  };
  // Persist so the generated token is stable across restarts.
  if (!stored.token) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

export { CONFIG_PATH };
