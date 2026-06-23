import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

interface Host {
  name: string;
  url: string; // origin, e.g. https://workstationA.tailnet.ts.net
  token?: string; // only for manually-added cross-tailnet hosts
}
interface SessionInfo {
  name: string;
  windows: number;
  cwd: string;
  attached: boolean;
  created: number;
}

const STORE_KEY = 'agents-portal.hosts';
const loadManual = (): Host[] => JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
const saveManual = (h: Host[]) => localStorage.setItem(STORE_KEY, JSON.stringify(h));

const hostsEl = document.getElementById('hosts')!;
const placeholder = document.getElementById('placeholder')!;
const termEl = document.getElementById('terminal')!;
const toolbar = document.getElementById('toolbar') as HTMLElement;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let activeEl: HTMLElement | null = null;

document.getElementById('add-host')!.addEventListener('click', addHostPrompt);
setupToolbar();
setupTouchScroll();

function send(data: string): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
}

const b64ToBytes = (s: string): Uint8Array => {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
};

// Keys phones lack. Scroll keys drive xterm's native scrollback, not the agent.
const KEYS: Record<string, string> = {
  esc: '\x1b',
  tab: '\t',
  ctrlc: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
};

function setupToolbar(): void {
  for (const btn of toolbar.querySelectorAll('button')) {
    const key = (btn as HTMLElement).dataset.key ?? '';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (key === 'pageup') term?.scrollPages(-1);
      else if (key === 'pagedown') term?.scrollPages(1);
      else if (KEYS[key]) send(KEYS[key]);
      term?.focus();
    });
  }
}

// Finger-drag scrolls xterm's native scrollback (the agent streams raw output,
// so xterm owns the history — no tmux copy-mode involved).
function setupTouchScroll(): void {
  let lastY = 0;
  let accum = 0;
  const STEP = 16;
  termEl.addEventListener('touchstart', (e) => { lastY = e.touches[0].clientY; accum = 0; }, { passive: true });
  termEl.addEventListener('touchmove', (e) => {
    const y = e.touches[0].clientY;
    accum += y - lastY;
    lastY = y;
    while (Math.abs(accum) >= STEP) {
      term?.scrollLines(accum > 0 ? -1 : 1); // drag down → older lines
      accum += accum > 0 ? -STEP : STEP;
    }
    e.preventDefault();
  }, { passive: false });
}

function addHostPrompt(): void {
  const url = prompt('Host URL (e.g. https://workstationA.tailnet.ts.net)')?.trim();
  if (!url) return;
  const token = prompt('Token (leave blank if on the same tailnet)')?.trim() || undefined;
  const name = prompt('Display name', new URL(url).hostname)?.trim() || url;
  const hosts = loadManual();
  hosts.push({ name, url: url.replace(/\/$/, ''), token });
  saveManual(hosts);
  render();
}

// Auto-discover hosts from the serving agent's tailnet, plus any manual ones.
async function discoverHosts(): Promise<Host[]> {
  const hosts: Host[] = [];
  try {
    const res = await fetch(`${location.origin}/api/hosts`);
    if (res.ok) {
      const peers: { hostName: string; dnsName: string; online: boolean; self: boolean }[] = await res.json();
      for (const p of peers) {
        if (!p.online) continue;
        hosts.push({ name: p.hostName, url: p.self ? location.origin : `https://${p.dnsName}` });
      }
    }
  } catch {
    // not agent-served (e.g. github.io) — manual hosts only
  }
  for (const m of loadManual()) if (!hosts.some((h) => h.url === m.url)) hosts.push(m);
  return hosts;
}

const authHeaders = (h: Host): HeadersInit => (h.token ? { Authorization: `Bearer ${h.token}` } : {});

async function render(): Promise<void> {
  hostsEl.innerHTML = '';
  for (const host of await discoverHosts()) {
    const header = document.createElement('li');
    header.className = 'host-name';
    header.textContent = host.name;
    hostsEl.appendChild(header);

    let sessions: SessionInfo[] = [];
    try {
      const res = await fetch(`${host.url}/api/sessions`, { headers: authHeaders(host) });
      if (res.ok) sessions = await res.json();
      else { header.textContent = `${host.name} — ${res.status}`; continue; }
    } catch {
      header.textContent = `${host.name} — offline`;
      continue;
    }
    if (sessions.length === 0) header.textContent = `${host.name} — no sessions`;

    for (const s of sessions) {
      const li = document.createElement('li');
      li.className = 'session';
      li.innerHTML = `<span class="dot"></span><span>${s.name}</span><span class="cwd">${s.cwd.split('/').pop() ?? ''}</span>`;
      li.addEventListener('click', () => openSession(host, s, li));
      hostsEl.appendChild(li);
    }
  }
}

function openSession(host: Host, session: SessionInfo, el: HTMLElement): void {
  ws?.close();
  term?.dispose();
  activeEl?.classList.remove('active');
  el.classList.add('active');
  activeEl = el;
  placeholder.style.display = 'none';
  toolbar.hidden = false;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    scrollback: 5000,
    fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace',
    theme: { background: '#0d1117' },
    allowProposedApi: true,
  });
  fit = new FitAddon();
  const unicode11 = new Unicode11Addon();
  term.loadAddon(fit);
  term.loadAddon(unicode11);
  term.unicode.activeVersion = '11';
  term.open(termEl);
  fit.fit();

  const wsBase = host.url.replace(/^http/, 'ws');
  const { cols, rows } = term;
  let q = `session=${encodeURIComponent(session.name)}&cols=${cols}&rows=${rows}`;
  if (host.token) q += `&token=${encodeURIComponent(host.token)}`;
  ws = new WebSocket(`${wsBase}/ws/terminal?${q}`);

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'output') term!.write(b64ToBytes(msg.data));
    else if (msg.type === 'closed') term!.write(`\r\n[${msg.reason}]\r\n`);
  };
  term.onData((data) => send(data));

  const onResize = () => {
    fit?.fit();
    if (term && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };
  window.addEventListener('resize', onResize);
}

render();
