#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { loadConfig, saveConfig, CONFIG_PATH } from '../config.js';
import { startAgent } from '../agent/server.js';
import { listSessions } from '../agent/tmux.js';

const program = new Command();
program
  .name('agents-portal')
  .description('Drive AI coding agents running in tmux from any device, over Tailscale.')
  .version('0.1.0');

// agents-portal up — start the per-workstation agent server.
program
  .command('up')
  .description('Start the agent server for this workstation')
  .option('--dev', 'development mode')
  .action(() => {
    const cfg = loadConfig();
    startAgent(cfg);
    console.log('\nExpose it on your tailnet with:');
    console.log(`  tailscale serve --bg --https=443 http://127.0.0.1:${cfg.port}`);
  });

// agents-portal new -t <name> [tmux args…] — start/attach a tmux session in $PWD.
program
  .command('new')
  .description('Create or attach a tmux session in the current directory')
  .requiredOption('-t, --target <name>', 'session name')
  .option('--ephemeral', 'stop the agent when this session exits')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action((opts, cmd) => {
    const passthrough = cmd.args; // any extra args after the known options
    const args = ['new-session', '-A', '-s', opts.target, ...passthrough];
    const r = spawnSync('tmux', args, { stdio: 'inherit', cwd: process.cwd() });
    process.exit(r.status ?? 0);
  });

// agents-portal ls — list tmux sessions on this host.
program
  .command('ls')
  .description('List tmux sessions on this host')
  .action(async () => {
    const sessions = await listSessions();
    if (sessions.length === 0) return console.log('no tmux sessions');
    for (const s of sessions) {
      console.log(`${s.attached ? '*' : ' '} ${s.name}\t${s.windows}w\t${s.cwd}`);
    }
  });

// agents-portal auth — join the tailnet.
program
  .command('auth')
  .description('Authenticate this workstation to Tailscale (Google SSO via URL)')
  .action(() => {
    spawnSync('tailscale', ['up'], { stdio: 'inherit' });
  });

// agents-portal config — show or set local config.
program
  .command('config')
  .description('Show or update agent configuration')
  .option('--port <port>', 'set the local listen port', (v) => Number(v))
  .option('--name <name>', 'set the display host name')
  .action((opts) => {
    const cfg = loadConfig();
    if (opts.port) cfg.port = opts.port;
    if (opts.name) cfg.hostName = opts.name;
    if (opts.port || opts.name) saveConfig(cfg);
    console.log(`config: ${CONFIG_PATH}`);
    console.log(JSON.stringify(cfg, null, 2));
  });

program.parseAsync();
