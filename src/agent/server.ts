// Per-workstation agent: serves session list + a WebSocket terminal bridge.
import { createServer, type IncomingMessage } from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { Config } from '../config.js';
import { listSessions } from './tmux.js';
import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ClientToAgent,
  type HostInfo,
} from '../shared/protocol.js';

const VERSION = '0.1.0';

export function startAgent(cfg: Config): { close: () => void } {
  const app = express();

  // CORS — the SPA is served from a different origin (GitHub Pages). The token
  // is the real gate, so we reflect any origin but keep credentials off.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const authed = (req: express.Request): boolean => tokenFromHeader(req) === cfg.token;

  app.get('/api/info', (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    const info: HostInfo = { hostName: cfg.hostName, version: VERSION, protocol: PROTOCOL_VERSION };
    res.json(info);
  });

  app.get('/api/sessions', async (req, res) => {
    if (!authed(req)) return res.sendStatus(401);
    res.json(await listSessions());
  });

  const server = createServer(app);

  // WebSocket terminal bridge at /ws/terminal?session=<name>&token=<token>.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== '/ws/terminal') return socket.destroy();
    if (url.searchParams.get('token') !== cfg.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, req));
  });

  function bridge(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? '', 'http://localhost');
    const session = url.searchParams.get('session');
    if (!session) {
      ws.send(encode({ type: 'closed', reason: 'missing session' }));
      return ws.close();
    }
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;

    // Attach to the tmux session through a PTY. Multiple clients on the same
    // session share tmux's view (mirrored), which is fine for v1.
    const term = pty.spawn('tmux', ['attach-session', '-t', session], {
      name: 'xterm-256color',
      cols,
      rows,
      env: process.env as Record<string, string>,
    });

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encode({ type: 'output', data }));
    });
    term.onExit(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encode({ type: 'closed', reason: 'session ended' }));
        ws.close();
      }
    });

    ws.on('message', (raw) => {
      let msg: ClientToAgent;
      try {
        msg = decode<ClientToAgent>(raw as Buffer);
      } catch {
        return;
      }
      if (msg.type === 'input') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(msg.cols, msg.rows);
    });

    ws.on('close', () => term.kill());
  }

  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`agents-portal agent listening on http://127.0.0.1:${cfg.port}`);
    console.log(`host: ${cfg.hostName}  token: ${cfg.token}`);
  });

  return { close: () => server.close() };
}

function tokenFromHeader(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  const q = req.query.token;
  return typeof q === 'string' ? q : undefined;
}
