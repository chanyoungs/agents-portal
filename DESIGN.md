# agents-portal — Design

Drive AI coding agents (codex, claude, …) running inside tmux from any device's
browser. You keep working in tmux on a workstation; the portal mirrors the
session to a web UI you can reach from your phone or laptop anywhere — even on a
different network.

## Goals

- Mirror any tmux session (any agent — it's terminal-level, not agent-specific) to a browser.
- Reach it from any device **not** on the same network.
- List sessions across **all** workstations in one dashboard; switch between them.
- A **fixed entry URL** with no always-on server to babysit.
- View images/videos and download files from the workstation. *(Phase 2)*
- Upload an image → save it on the workstation → hand the path to the agent via a prompt. *(Phase 3)*

## Architecture — no relay (Model B)

Tailscale handles cross-network reachability, so there is **no central hub/relay
process**. Each workstation runs an **agent** that serves its own terminal
stream + file API. A **static dashboard** (the SPA) is hosted at a fixed URL and,
when loaded in your browser, connects **directly** to each workstation over the
tailnet. The only always-up thing is static file hosting — no server you run.

```
  https://chanyoungs.github.io/agents-portal   ← fixed entry (static SPA on GitHub Pages)
                    │  loads in browser
                    ▼
        browser connects directly, over the tailnet, to each workstation:
        ├──► wss://workstationA.<tailnet>.ts.net   (terminal + files)
        └──► wss://workstationB.<tailnet>.ts.net
        whichever hosts are up appear; the entry URL is up regardless.
```

### Why no relay
On a tailnet every workstation is already directly reachable from your laptop
across any network/NAT. A relay would only add an always-on box + a single point
of failure for no connectivity gain. (A relay would only matter for access from
devices that can't run Tailscale — out of scope; would use `tailscale funnel`.)

## Networking & auth — Tailscale

Every device (workstations + your laptop/phone) joins one tailnet via
`tailscale up` (Google SSO). Each workstation agent is exposed with
`tailscale serve` (real HTTPS on its `*.ts.net` name). Security boundary:
- **Tailnet membership** is the primary boundary.
- A **per-agent token** gates the WS/REST endpoints so a tailnet co-member can't
  silently attach. Entered once per host in the SPA.
- **CORS**: the agent allows the GitHub Pages origin (the SPA's origin).

## Components (one npm package, `agents-portal`)

- **agent** — `agents-portal up`. Long-running per-workstation server. Watches
  `tmux list-sessions`, exposes:
  - `GET /api/info`, `GET /api/sessions`
  - `WS /ws/terminal?session=<name>` — bridges the PTY via `tmux attach -t <name>`
    through node-pty (input/output/resize).
  - *(Phase 2)* file API scoped to each session's cwd (`#{pane_current_path}`).
  - *(Phase 3)* `POST /api/upload` → save to cwd → `tmux send-keys` the path.
  Listens on `127.0.0.1:<port>`; `tailscale serve` fronts it with TLS.
- **CLI** — thin tmux wrapper:
  - `agents-portal auth` → `tailscale up` (+ `tailscale serve` wiring)
  - `agents-portal up` → start the agent server
  - `agents-portal new -t <name> [tmux args…]` → `tmux new-session -A -s <name>`
    in `$PWD`; extra args pass through. Appears in the UI immediately.
  - `agents-portal ls / stop / config`
- **web** — static SPA (xterm.js + Vite). Holds your host list (localStorage),
  connects directly to each agent, one combined dashboard. Deployed to GitHub
  Pages via Actions. Same bundle can instead be served by `tailscale serve` from
  a host if you prefer a private `*.ts.net` entry URL.

### Lifecycle ("killing tmux kills the connection")

The agent watches sessions; when a tmux session ends, its bridge closes and it
disappears from the dashboard — other sessions stay up. `agents-portal new
--ephemeral -t s1` runs foreground and stops the agent when that one session exits.

## Tech stack

- TypeScript, **Node 20** (pinned via `.nvmrc` / `engines`). System node is v16 — must use nvm.
- `node-pty` (PTY bridge), `ws` (terminal stream), `express` (REST + static).
- Frontend: `xterm.js` + Vite; deployed to GitHub Pages.
- Packaging: **npm global** (`npm i -g agents-portal`).

## Phases

- **Phase 0 — validate (now):** `ttyd + tmux + tailscale serve` to confirm remote terminal + mobile UX.
- **Phase 1 — MVP:** agent (tmux watch + node-pty WS bridge) + CLI (`auth/up/new/ls/stop`);
  SPA with multi-host + multi-session switcher; tailnet TLS via `tailscale serve`; token + CORS.
- **Phase 2 — files:** scoped file browser; download + inline image/video viewing.
- **Phase 3 — upload→inject:** upload → save to cwd → `send-keys` path into the agent.
- **Phase 4 — polish:** reconnection, auth hardening, GitHub Pages deploy, notifications.

## Security notes

The agent can run arbitrary commands on the workstation — treat it like SSH.
Tailnet membership + per-agent token are the boundaries. Never expose the agent
on a public interface; only `127.0.0.1` + `tailscale serve`. If `tailscale
funnel` is ever used, token auth is mandatory.
