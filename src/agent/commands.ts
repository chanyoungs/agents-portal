// Enumerate slash commands for autocomplete: a curated set of stable built-ins
// plus custom commands from ~/.claude/commands and <cwd>/.claude/commands.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SlashCommand {
  name: string;
  builtin: boolean;
}

const BUILTINS = [
  'help', 'clear', 'compact', 'model', 'cost', 'config', 'init', 'review',
  'resume', 'status', 'memory', 'agents', 'mcp', 'doctor', 'pr-comments',
  'vim', 'login', 'logout', 'add-dir', 'export',
];

/** Recursively collect command names from a dir; subdirs namespace with ':'. */
function scanDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${prefix}${e.name}:`);
      else if (e.name.endsWith('.md')) out.push(prefix + e.name.replace(/\.md$/, ''));
    }
  };
  try {
    walk(dir, '');
  } catch {
    /* ignore */
  }
  return out;
}

export function listCommands(cwd: string): SlashCommand[] {
  const custom = new Set<string>([
    ...scanDir(join(homedir(), '.claude', 'commands')),
    ...(cwd ? scanDir(join(cwd, '.claude', 'commands')) : []),
  ]);
  const seen = new Set<string>();
  const cmds: SlashCommand[] = [];
  for (const name of BUILTINS) {
    if (!seen.has(name)) { seen.add(name); cmds.push({ name, builtin: true }); }
  }
  for (const name of custom) {
    if (!seen.has(name)) { seen.add(name); cmds.push({ name, builtin: false }); }
  }
  cmds.sort((a, b) => a.name.localeCompare(b.name));
  return cmds;
}
