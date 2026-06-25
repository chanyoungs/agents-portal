// Per-workstation agent. Serves the dashboard, session list, peer discovery,
// and a WebSocket terminal stream. Auth is by Tailscale identity (injected by
// `tailscale serve`) with a config token as a dev/local fallback.
//
// Rendering model: we do NOT mirror tmux's repainted screen. Instead we stream
// the pane's RAW output via `tmux pipe-pane` so the browser's xterm renders it
// with its own native scrollback. Input goes back via `tmux send-keys -H`, and
// the pane is sized to the (active) client via `resize-window`.
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from '../config.js';
import * as pty from 'node-pty';
import { listSessions, sessionCwd, sendText, sendEnter, findAgentPane, paneVisible, newGroupedSession, killSession, killStaleGroups, agentSessions } from './tmux.js';
import { listPeers, identityLogin } from './tailscale.js';
import { resolveTranscript, transcriptForSession, findCodexTranscript, parseClaudeLine, parseCodexLine, TranscriptTailer } from './transcript.js';
import { listCommands } from './commands.js';
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ClientToAgent,
  type HostInfo,
} from '../shared/protocol.js';

const VERSION = '0.1.0';

function findWebRoot(): string | null {
  for (const rel of ['../web', '../../dist/web']) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  return null;
}


export function startAgent(cfg: Config): { close: () => void } {
  const app = express();

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const authLogin = (headers: IncomingMessage['headers']): string | false => {
    const login = identityLogin(headers as Record<string, unknown>);
    if (login) return cfg.allowedLogins.length === 0 || cfg.allowedLogins.includes(login) ? login : false;
    return false;
  };
  const authed = (req: express.Request): boolean =>
    !!authLogin(req.headers) || tokenFromHeader(req) === cfg.token;

  app.get('/api/whoami', (req, res) => res.json({ login: authLogin(req.headers) || null }));

  app.get('/api/info', (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    const info: HostInfo = { hostName: cfg.hostName, version: VERSION, protocol: PROTOCOL_VERSION };
    res.json(info);
  });

  app.get('/api/sessions', async (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    const sessions = await listSessions();
    const byName = new Map((await agentSessions()).map((a) => [a.session, a.agent]));
    for (const s of sessions) s.agent = byName.get(s.name);
    res.json(sessions);
  });

  app.get('/api/hosts', async (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    res.json(await listPeers());
  });

  // Slash commands for autocomplete (built-ins + this session's custom commands).
  app.get('/api/commands', async (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    const session = String(req.query.session ?? '');
    res.json(listCommands(session ? await sessionCwd(session) : ''));
  });

  // Upload a file from the browser to the session's cwd; returns its path so
  // the user can reference it to the agent. Raw body (no multipart dep).
  app.post('/api/upload', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    const session = String(req.query.session ?? '');
    const cwd = session ? await sessionCwd(session) : '';
    if (!cwd) return res.status(400).json({ error: 'unknown session cwd' });
    const safe = String(req.query.name ?? 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';
    const dir = join(cwd, '.agents-portal', 'uploads');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${safe}`);
    writeFileSync(file, req.body as Buffer);
    res.json({ path: file });
  });

  // Serve a file from a session's cwd so the chat can render media the agent
  // emitted (e.g. a SendUserFile tool call with files: ["montage/montage.mp4"]).
  // Paths are resolved against the session cwd and confined to it (no traversal).
  // express sendFile handles Content-Type + HTTP Range, so <video> can seek.
  app.get('/api/file', async (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    const session = String(req.query.session ?? '');
    const rel = String(req.query.path ?? '');
    if (!session || !rel) return res.sendStatus(400);
    const cwd = await sessionCwd(session);
    if (!cwd) return res.status(400).json({ error: 'unknown session cwd' });
    const root = resolve(cwd);
    // Resolve relative paths against the event's cwd (where the agent created
    // the file), which may be a subdir of the session cwd; still confine the
    // final path within the session root so nothing outside it can be served.
    const baseQ = String(req.query.base ?? '');
    const base = baseQ && resolve(baseQ).startsWith(root) ? resolve(baseQ) : root;
    const abs = isAbsolute(rel) ? resolve(rel) : resolve(base, rel);
    if (abs !== root && !abs.startsWith(root + sep)) return res.sendStatus(403); // outside cwd
    try {
      if (!statSync(abs).isFile()) return res.sendStatus(404);
    } catch {
      return res.sendStatus(404);
    }
    res.sendFile(abs);
  });

  const webRoot = findWebRoot();
  if (webRoot) {
    app.use(express.static(webRoot));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webRoot, 'index.html')));
  }

  const server = createServer(app);
  const tailers = new Map<string, TranscriptTailer>();

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws/terminal' && url.pathname !== '/ws/chat') return socket.destroy();
    const ok = !!authLogin(req.headers) || url.searchParams.get('token') === cfg.token;
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    const handler = url.pathname === '/ws/chat' ? chatBridge : bridge;
    wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
  });

  // Conversation view: tail the agent's transcript and stream chat events.
  async function chatBridge(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    const session = url.searchParams.get('session');
    if (!session) return ws.close();
    // Map THIS session to its transcript, and pick the right parser per agent.
    const all = await agentSessions();
    const me = all.find((s) => s.session === session);
    const cwd = me ? me.cwd : await sessionCwd(session);
    let file: string | null;
    let parse = parseClaudeLine;
    let dedup = true;
    if (me?.agent === 'codex') {
      file = findCodexTranscript(cwd);
      parse = parseCodexLine;
      dedup = false; // codex has no enqueue/user duplication
    } else {
      // Claude: exact session id from ~/.claude/sessions/<pid>.json; else heuristic.
      file = me?.sessionId ? transcriptForSession(cwd, me.sessionId) : null;
      if (!file) file = resolveTranscript(cwd, session, all.filter((s) => s.agent === 'claude' && s.cwd === cwd), Date.now());
    }
    if (!file) {
      ws.send(encode({ type: 'chat-error', reason: `no transcript for ${cwd}` }));
      return ws.close();
    }
    // Send chat input to the pane actually running the agent (not whatever
    // window is active), then a real Enter to submit.
    const pane = await findAgentPane(session, cwd);

    let tailer = tailers.get(file);
    if (!tailer) {
      tailer = new TranscriptTailer(file, parse, dedup);
      tailer.start();
      tailers.set(file, tailer);
    }
    const unsub = tailer.subscribe((events) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: 'chat', events }));
    });

    const BUSY_RE = /…[^\n]*tokens\)|esc to interrupt/i;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // True once the agent's input box is empty again — i.e. the message we just
    // pasted has been submitted (idle) or moved to the native queue (busy).
    const inputCleared = async (): Promise<boolean> => {
      const lines = (await paneVisible(pane)).split('\n');
      const prompt = [...lines].reverse().find((l) => l.includes('❯'));
      if (!prompt) return true;
      return prompt.replace(/.*❯/, '').trim().length === 0;
    };

    // Use Claude's NATIVE queue: paste + Enter immediately (Claude queues it and
    // runs it after the current tool calls). Between consecutive messages, wait
    // until the input box clears so each is registered separately (no lumping).
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      try {
        const msg = decode<ClientToAgent>(raw as Buffer);
        if (msg.type === 'input') {
          const data = msg.data;
          queue = queue.then(async () => {
            await sendText(pane, data); // bracketed paste (multi-line safe)
            await sendEnter(pane);
            for (let t = 0; t < 4000; t += 200) {
              if (await inputCleared()) break;
              await sleep(200);
            }
            await sleep(150);
          });
        }
      } catch {
        /* ignore */
      }
    });
    // Stream status parsed from the agent's TUI: working spinner, model name,
    // context %, and thinking mode. Busy settles (~1.5s) to ride blink frames;
    // the rest update immediately. Only emit when something changes.
    let busy = false;
    let idle = 0;
    let lastStatus = '';
    const statusPoll = setInterval(async () => {
      const text = await paneVisible(pane);
      if (BUSY_RE.test(text)) { idle = 0; busy = true; }
      else if (busy && ++idle >= 3) busy = false;

      // Parse model/context/thinking only from the footer (last few non-empty
      // lines) so conversation text can't trigger false matches.
      const footer = text.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
      const ctx = footer.match(/Context(?:\s+left)?:\s*([\d.]+)%/i);
      // Claude footer: "<model>  Context: …". Codex footer: "<model …> · /cwd".
      const cModel = footer.match(/^\s*([A-Za-z][\w.\- ]*?(?:\([^)]*\))?)\s{2,}Context:/m);
      const xModel = footer.match(/^\s*([A-Za-z][\w.\- ]*?)\s+·\s+\//m);
      const think = footer.match(/\bthinking\b(?:[:\s]+(on|off|\w+))?/i);
      const payload = {
        type: 'status',
        busy,
        model: cModel ? cModel[1].trim() : xModel ? xModel[1].trim() : null,
        context: ctx ? Number(ctx[1]) : null,
        thinking: think ? (think[1] ?? 'on') : null,
      };
      const sig = JSON.stringify(payload);
      if (sig !== lastStatus) {
        lastStatus = sig;
        if (ws.readyState === WebSocket.OPEN) ws.send(encode(payload));
      }
    }, 500);

    ws.on('close', () => {
      clearInterval(statusPoll);
      unsub();
      if (tailer!.subscriberCount === 0) {
        tailer!.stop();
        tailers.delete(file);
      }
    });
  }

  // tmux mode: a REAL tmux client (full session — status bar, all windows,
  // prefix keys, mouse) via a PTY. We attach a grouped session so this web
  // client has its own window/size and doesn't disturb other clients.
  async function bridge(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    const session = url.searchParams.get('session');
    if (!session) {
      ws.send(encode({ type: 'closed', reason: 'missing session' }));
      return ws.close();
    }
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;
    const group = `_ap_${session.replace(/[^A-Za-z0-9_]/g, '_')}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      await newGroupedSession(group, session);
    } catch {
      ws.send(encode({ type: 'closed', reason: `cannot attach ${session}` }));
      return ws.close();
    }

    const term = pty.spawn('tmux', ['attach-session', '-t', group], {
      name: 'xterm-256color',
      cols,
      rows,
      env: process.env as Record<string, string>,
    });
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: 'output', data: Buffer.from(data, 'utf8').toString('base64') }));
    });
    term.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) { ws.send(encode({ type: 'closed', reason: 'detached' })); ws.close(); }
    });
    ws.on('message', (raw) => {
      try {
        const msg = decode<ClientToAgent>(raw as Buffer);
        if (msg.type === 'input') term.write(msg.data); // raw keystrokes incl. Ctrl-B, mouse
        else if (msg.type === 'resize') term.resize(msg.cols || 80, msg.rows || 24);
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => { term.kill(); void killSession(group); });
  }

  void killStaleGroups(); // sweep leftover grouped sessions from a previous run

  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`agents-portal agent listening on http://127.0.0.1:${cfg.port}`);
    console.log(`host: ${cfg.hostName}  web: ${webRoot ? 'served' : 'not built'}`);
  });

  return { close: () => server.close() };
}

function tokenFromHeader(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  const q = req.query.token;
  return typeof q === 'string' ? q : undefined;
}
