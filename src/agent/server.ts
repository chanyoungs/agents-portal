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
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { Config } from '../config.js';
import { listSessions, sessionCwd, capturePane, startPipe, stopPipe, resizeWindow, sendRaw, sendEnter, findAgentPane } from './tmux.js';
import { listPeers, identityLogin } from './tailscale.js';
import { findClaudeTranscript, TranscriptTailer } from './transcript.js';
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

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/**
 * One raw-output stream per tmux session, fanned out to all viewers. The first
 * viewer starts `pipe-pane`; the last stops it. Output is buffered to a file
 * (append never blocks tmux) which we poll and broadcast.
 */
class SessionStream {
  private clients = new Set<WebSocket>();
  private file: string;
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private session: string,
    private onEmpty: () => void,
  ) {
    const safe = session.replace(/[^A-Za-z0-9_.-]/g, '_');
    this.file = join(tmpdir(), 'agents-portal', `${safe}.log`);
  }

  async add(ws: WebSocket): Promise<void> {
    if (this.clients.size === 0) await this.start();
    this.clients.add(ws);
  }

  async remove(ws: WebSocket): Promise<void> {
    this.clients.delete(ws);
    if (this.clients.size === 0) await this.stop();
  }

  private async start(): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, '');
    this.offset = 0;
    await startPipe(this.session, this.file);
    this.timer = setInterval(() => this.pump(), 40);
  }

  private pump(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.offset) this.offset = 0; // file was truncated/rotated
    if (size <= this.offset) return;
    const len = size - this.offset;
    const buf = Buffer.alloc(len);
    const fd = openSync(this.file, 'r');
    try {
      readSync(fd, buf, 0, len, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const msg = encode({ type: 'output', data: buf.toString('base64') });
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }

  private async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await stopPipe(this.session);
    try {
      rmSync(this.file);
    } catch {
      /* ignore */
    }
    this.onEmpty();
  }
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
    res.json(await listSessions());
  });

  app.get('/api/hosts', async (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    res.json(await listPeers());
  });

  const webRoot = findWebRoot();
  if (webRoot) {
    app.use(express.static(webRoot));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webRoot, 'index.html')));
  }

  const server = createServer(app);
  const streams = new Map<string, SessionStream>();
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
    const cwd = await sessionCwd(session);
    const file = findClaudeTranscript(cwd);
    if (!file) {
      ws.send(encode({ type: 'chat-error', reason: `no Claude transcript for ${cwd}` }));
      return ws.close();
    }
    // Send chat input to the pane actually running the agent (not whatever
    // window is active), then a real Enter to submit.
    const pane = await findAgentPane(session, cwd);

    let tailer = tailers.get(file);
    if (!tailer) {
      tailer = new TranscriptTailer(file);
      tailer.start();
      tailers.set(file, tailer);
    }
    const unsub = tailer.subscribe((events) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: 'chat', events }));
    });

    // Serialize sends so rapidly-queued messages don't interleave: each
    // message's text + Enter completes (plus a small gap) before the next.
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      try {
        const msg = decode<ClientToAgent>(raw as Buffer);
        if (msg.type === 'input') {
          const data = msg.data;
          queue = queue.then(async () => {
            await sendRaw(pane, data);
            await sendEnter(pane);
            await new Promise((r) => setTimeout(r, 150));
          });
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('close', () => {
      unsub();
      if (tailer!.subscriberCount === 0) {
        tailer!.stop();
        tailers.delete(file);
      }
    });
  }

  async function bridge(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '', 'http://localhost');
    const session = url.searchParams.get('session');
    if (!session) {
      ws.send(encode({ type: 'closed', reason: 'missing session' }));
      return ws.close();
    }
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    await resizeWindow(session, cols, rows); // active-device sizing

    // Prime this viewer with scrollback + current screen, then join the stream.
    ws.send(encode({ type: 'output', data: b64(await capturePane(session)) }));

    let stream = streams.get(session);
    if (!stream) {
      stream = new SessionStream(session, () => streams.delete(session));
      streams.set(session, stream);
    }
    await stream.add(ws);

    ws.on('message', (raw) => {
      let msg: ClientToAgent;
      try {
        msg = decode<ClientToAgent>(raw as Buffer);
      } catch {
        return;
      }
      if (msg.type === 'input') void sendRaw(session, msg.data);
      else if (msg.type === 'resize') void resizeWindow(session, msg.cols, msg.rows);
    });
    ws.on('close', () => void stream!.remove(ws));
  }

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
