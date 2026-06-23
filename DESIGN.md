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
- **Identity auth, no tokens.** `tailscale serve` injects a verified
  `Tailscale-User-Login` header on every request; the agent (bound to
  `127.0.0.1`, reachable only via serve) trusts it. Optionally restrict to
  specific logins via `allowedLogins`. A config token remains as a dev/local and
  cross-tailnet fallback.
- **CORS**: the agent reflects the requesting origin (token/identity is the gate).

## Components (one npm package, `agents-portal`)

- **agent** — `agents-portal up`. Long-running per-workstation server. Serves
  the dashboard and exposes:
  - `GET /api/info`, `GET /api/sessions`, `GET /api/whoami`
  - `GET /api/hosts` — tailnet machines (via `tailscale status`) for auto-discovery
  - `WS /ws/terminal?session=<name>` — streams the pane's **raw output** via
    `tmux pipe-pane` (so xterm renders with native scrollback), primes new
    viewers with `capture-pane`, takes input via `tmux send-keys -H`, and sizes
    the pane to the active client via `resize-window`. No PTY/`tmux attach`.
  - *(Phase 2)* file API scoped to each session's cwd (`#{pane_current_path}`).
  - *(Phase 3)* `POST /api/upload` → save to cwd → `tmux send-keys` the path.
  Listens on `127.0.0.1:<port>`; `tailscale serve` fronts it with TLS.
- **CLI** — thin tmux wrapper:
  - `agents-portal auth` → `tailscale up` (+ `tailscale serve` wiring)
  - `agents-portal up` → start the agent server
  - `agents-portal new -t <name> [tmux args…]` → `tmux new-session -A -s <name>`
    in `$PWD`; extra args pass through. Appears in the UI immediately.
  - `agents-portal ls / stop / config`
- **web** — SPA (xterm.js + Vite), **served by the agent** so opening
  `https://<anyhost>.ts.net` is zero-config: it calls `/api/hosts`, auto-lists
  every workstation, and connects directly to each (identity auth, no manual
  add). Manually-added cross-tailnet hosts (with a token) are also supported and
  stored in localStorage. Also deployed to GitHub Pages (base `/agents-portal/`)
  as an optional fixed public entry.

### Lifecycle ("killing tmux kills the connection")

The agent watches sessions; when a tmux session ends, its bridge closes and it
disappears from the dashboard — other sessions stay up. `agents-portal new
--ephemeral -t s1` runs foreground and stops the agent when that one session exits.

## Tech stack

- TypeScript, **Node 20** (pinned via `.nvmrc` / `engines`). System node is v16 — must use nvm.
- `ws` (terminal stream), `express` (REST + static). No native deps — terminal
  I/O is via the `tmux` CLI (`pipe-pane`/`capture-pane`/`send-keys`), so
  `npm i -g` needs no C toolchain.
- Frontend: `xterm.js` + Vite (Unicode 11 addon, native scrollback); agent-served.
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
