# agents-portal

Drive AI coding agents (codex, claude, …) running inside tmux from any device's
browser — even on a different network. Each workstation runs a small **agent**
that mirrors its tmux sessions; a static **dashboard** (hosted on GitHub Pages)
connects directly to your workstations over [Tailscale](https://tailscale.com).
No relay server, no port forwarding, no single point of failure.

See [DESIGN.md](./DESIGN.md) for the full architecture and rationale.

## Status

**Phase 1 (MVP) — working:** agent REST + token auth + WebSocket terminal bridge
to live tmux sessions; CLI tmux wrapper; xterm.js dashboard with multi-host /
multi-session switching. Validated end-to-end locally.

Next: file browser + image/video viewing (Phase 2), upload→`send-keys` path
injection (Phase 3).

## Requirements

- Node 20+ (system node may be older — use `nvm use`).
- tmux 3.x
- Tailscale (for remote access)

## Quick start (local)

```bash
nvm use                 # Node 20 (see .nvmrc)
npm install             # builds node-pty natively
npm run build           # compile server + web

# start a tmux session in your project and the agent
agents-portal new -t mysession   # = tmux new -A -s mysession in $PWD
agents-portal up                 # start the agent server (prints host + token)
```

Then open the dashboard, add the host (URL + token), and pick a session.

## Remote access (Tailscale)

```bash
agents-portal auth      # tailscale up (Google SSO)
agents-portal up        # agent on 127.0.0.1:7420
tailscale serve --bg --https=443 http://127.0.0.1:7420
```

Open `https://<this-host>.<tailnet>.ts.net` from the dashboard's host list. The
dashboard itself is deployed to GitHub Pages by `.github/workflows/pages.yml`.

## CLI

| Command | Description |
| --- | --- |
| `agents-portal new -t <name> [tmux args…]` | Create/attach a tmux session in `$PWD` (args pass through to tmux) |
| `agents-portal up` | Start the agent server for this workstation |
| `agents-portal ls` | List tmux sessions on this host |
| `agents-portal auth` | Join the tailnet (`tailscale up`) |
| `agents-portal config [--port N] [--name X]` | Show / update local config |

## Dev

```bash
npm run dev:agent       # tsx watch — agent
npm run dev:web         # vite dev server — dashboard
npm run typecheck
```
