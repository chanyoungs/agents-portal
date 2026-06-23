import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// A workstation the dashboard connects to directly over the tailnet.
interface Host {
  name: string;
  url: string; // e.g. https://workstationA.tailnet.ts.net
  token: string;
}
interface SessionInfo {
  name: string;
  windows: number;
  cwd: string;
  attached: boolean;
  created: number;
}

const STORE_KEY = 'agents-portal.hosts';
const loadHosts = (): Host[] => JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
const saveHosts = (h: Host[]) => localStorage.setItem(STORE_KEY, JSON.stringify(h));

const hostsEl = document.getElementById('hosts')!;
const placeholder = document.getElementById('placeholder')!;
const termEl = document.getElementById('terminal')!;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let activeEl: HTMLElement | null = null;

document.getElementById('add-host')!.addEventListener('click', addHostPrompt);

function addHostPrompt(): void {
  const url = prompt('Host URL (e.g. https://workstationA.tailnet.ts.net)')?.trim();
  if (!url) return;
  const token = prompt('Token for this host')?.trim();
  if (!token) return;
  const name = prompt('Display name', new URL(url).hostname)?.trim() || url;
  const hosts = loadHosts();
  hosts.push({ name, url: url.replace(/\/$/, ''), token });
  saveHosts(hosts);
  render();
}

async function render(): Promise<void> {
  hostsEl.innerHTML = '';
  for (const host of loadHosts()) {
    const header = document.createElement('li');
    header.className = 'host-name';
    header.textContent = host.name;
    hostsEl.appendChild(header);

    let sessions: SessionInfo[] = [];
    try {
      const res = await fetch(`${host.url}/api/sessions`, {
        headers: { Authorization: `Bearer ${host.token}` },
      });
      if (res.ok) sessions = await res.json();
      else header.textContent = `${host.name} — ${res.status}`;
    } catch {
      header.textContent = `${host.name} — offline`;
    }

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

  term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: '#0d1117' } });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termEl);
  fit.fit();

  const wsBase = host.url.replace(/^http/, 'ws');
  const { cols, rows } = term;
  const q = `session=${encodeURIComponent(session.name)}&token=${encodeURIComponent(host.token)}&cols=${cols}&rows=${rows}`;
  ws = new WebSocket(`${wsBase}/ws/terminal?${q}`);

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'output') term!.write(msg.data);
    else if (msg.type === 'closed') term!.write(`\r\n[${msg.reason}]\r\n`);
  };
  term.onData((data) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'input', data })));

  const onResize = () => {
    fit?.fit();
    if (term && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };
  window.addEventListener('resize', onResize);
}

render();
