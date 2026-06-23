import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { marked } from 'marked';

interface Host { name: string; url: string; token?: string }
interface SessionInfo { name: string; windows: number; cwd: string; attached: boolean; created: number }
interface ChatBlock { kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'; text?: string; tool?: string; input?: any; result?: string; isError?: boolean }
interface ChatEvent { role: 'user' | 'assistant'; blocks: ChatBlock[]; ts?: string; uuid?: string }

const STORE_KEY = 'agents-portal.hosts';
const loadManual = (): Host[] => JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
const saveManual = (h: Host[]) => localStorage.setItem(STORE_KEY, JSON.stringify(h));

const $ = (id: string) => document.getElementById(id)!;
const hostsEl = $('hosts');
const placeholder = $('placeholder');
const termEl = $('terminal');
const chatEl = $('chat');
const toolbar = $('toolbar') as HTMLElement;
const topbar = $('topbar') as HTMLElement;
const chatForm = $('chatinput') as HTMLFormElement;
const chatbox = $('chatbox') as HTMLTextAreaElement;
const sessionLabel = $('session-label');

let activeEl: HTMLElement | null = null;
let current: { host: Host; session: SessionInfo } | null = null;
let view: 'chat' | 'term' = 'chat';

// terminal state
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let termWs: WebSocket | null = null;
// chat state
let chatWs: WebSocket | null = null;

$('add-host').addEventListener('click', addHostPrompt);
setupToolbar();
setupTouchScroll();
for (const b of topbar.querySelectorAll('button')) {
  b.addEventListener('click', () => showView((b as HTMLElement).dataset.view as 'chat' | 'term'));
}
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatbox.value;
  if (!text.trim() || chatWs?.readyState !== WebSocket.OPEN) return;
  chatWs.send(JSON.stringify({ type: 'input', data: text + '\r' }));
  chatbox.value = '';
  chatbox.style.height = 'auto';
});
chatbox.addEventListener('input', () => {
  chatbox.style.height = 'auto';
  chatbox.style.height = Math.min(chatbox.scrollHeight, window.innerHeight * 0.4) + 'px';
});

// ── terminal helpers ────────────────────────────────────────────────────────
const b64ToBytes = (s: string): Uint8Array => {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
};
const KEYS: Record<string, string> = {
  esc: '\x1b', tab: '\t', ctrlc: '\x03',
  up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
};
function termSend(data: string): void {
  if (termWs?.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: 'input', data }));
}
function setupToolbar(): void {
  for (const btn of toolbar.querySelectorAll('button')) {
    const key = (btn as HTMLElement).dataset.key ?? '';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (key === 'pageup') term?.scrollPages(-1);
      else if (key === 'pagedown') term?.scrollPages(1);
      else if (KEYS[key]) termSend(KEYS[key]);
      term?.focus();
    });
  }
}
function setupTouchScroll(): void {
  let lastY = 0, accum = 0;
  const STEP = 16;
  termEl.addEventListener('touchstart', (e) => { lastY = e.touches[0].clientY; accum = 0; }, { passive: true });
  termEl.addEventListener('touchmove', (e) => {
    accum += e.touches[0].clientY - lastY;
    lastY = e.touches[0].clientY;
    while (Math.abs(accum) >= STEP) { term?.scrollLines(accum > 0 ? -1 : 1); accum += accum > 0 ? -STEP : STEP; }
    e.preventDefault();
  }, { passive: false });
}

// ── hosts / discovery ───────────────────────────────────────────────────────
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
async function discoverHosts(): Promise<Host[]> {
  const hosts: Host[] = [];
  try {
    const res = await fetch(`${location.origin}/api/hosts`);
    if (res.ok) {
      const peers: { hostName: string; dnsName: string; online: boolean; self: boolean }[] = await res.json();
      for (const p of peers) if (p.online) hosts.push({ name: p.hostName, url: p.self ? location.origin : `https://${p.dnsName}` });
    }
  } catch { /* manual only */ }
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
      if (!res.ok) { header.textContent = `${host.name} — ${res.status}`; continue; }
      sessions = await res.json();
    } catch { header.textContent = `${host.name} — offline`; continue; }
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

// ── session + views ─────────────────────────────────────────────────────────
function openSession(host: Host, session: SessionInfo, el: HTMLElement): void {
  activeEl?.classList.remove('active');
  el.classList.add('active');
  activeEl = el;
  current = { host, session };
  placeholder.style.display = 'none';
  topbar.hidden = false;
  sessionLabel.textContent = `${host.name} / ${session.name}`;
  showView('chat'); // web-friendly by default; falls back to terminal if no transcript
}

function showView(v: 'chat' | 'term'): void {
  if (!current) return;
  view = v;
  for (const b of topbar.querySelectorAll('button')) {
    (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.view === v);
  }
  if (v === 'chat') {
    closeTerminal();
    termEl.hidden = true; toolbar.hidden = true;
    chatEl.hidden = false; chatForm.hidden = false;
    connectChat();
  } else {
    closeChat();
    chatEl.hidden = true; chatForm.hidden = true;
    termEl.hidden = false; toolbar.hidden = false;
    connectTerminal();
  }
}

function wsUrl(host: Host, path: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params);
  if (host.token) q.set('token', host.token);
  return `${host.url.replace(/^http/, 'ws')}${path}?${q}`;
}

// ── conversation view ───────────────────────────────────────────────────────
function closeChat(): void { chatWs?.close(); chatWs = null; }

function connectChat(): void {
  if (!current) return;
  closeChat();
  chatEl.innerHTML = '';
  chatWs = new WebSocket(wsUrl(current.host, '/ws/chat', { session: current.session.name }));
  chatWs.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'chat-error') { showView('term'); return; }
    if (msg.type !== 'chat') return;
    const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
    const frag = document.createDocumentFragment();
    for (const e of msg.events as ChatEvent[]) frag.appendChild(renderEvent(e));
    chatEl.appendChild(frag);
    if (nearBottom) chatEl.scrollTop = chatEl.scrollHeight;
  };
}

const summarize = (tool: string, input: any): string => {
  if (!input) return '';
  if (typeof input.command === 'string') return input.command.split('\n')[0].slice(0, 80);
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.pattern === 'string') return input.pattern;
  return JSON.stringify(input).slice(0, 80);
};
const clip = (s: string, n = 4000): string => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderEvent(e: ChatEvent): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `msg ${e.role}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = e.role === 'user' ? 'You' : 'Agent';
  wrap.appendChild(who);
  for (const b of e.blocks) {
    if (b.kind === 'text' && b.text) {
      const d = document.createElement('div');
      d.className = 'bubble';
      d.innerHTML = marked.parse(b.text) as string;
      wrap.appendChild(d);
    } else if (b.kind === 'thinking' && b.text) {
      const det = document.createElement('details');
      det.className = 'tool';
      det.innerHTML = `<summary><span class="tname">💭 thinking</span></summary><div class="think"><pre>${esc(clip(b.text))}</pre></div>`;
      wrap.appendChild(det);
    } else if (b.kind === 'tool_use') {
      wrap.appendChild(renderToolUse(b));
    } else if (b.kind === 'tool_result' && b.result) {
      const det = document.createElement('details');
      det.className = 'tool';
      det.innerHTML = `<summary><span class="tname">${b.isError ? '⚠ result' : '▸ result'}</span></summary><pre>${esc(clip(b.result))}</pre>`;
      wrap.appendChild(det);
    }
  }
  return wrap;
}

function renderToolUse(b: ChatBlock): HTMLElement {
  const det = document.createElement('details');
  det.className = 'tool';
  const summary = `<summary><span class="tname">🔧 ${esc(b.tool ?? 'tool')}</span><span class="targ">${esc(summarize(b.tool ?? '', b.input))}</span></summary>`;
  let body: string;
  if ((b.tool === 'Edit' || b.tool === 'Write') && b.input?.new_string !== undefined) {
    const oldS = b.input.old_string ?? '';
    const newS = b.input.new_string ?? b.input.content ?? '';
    body = (oldS ? `<pre class="del">${esc(clip(oldS, 2000))}</pre>` : '') + `<pre class="add">${esc(clip(newS, 2000))}</pre>`;
  } else {
    body = `<pre>${esc(clip(JSON.stringify(b.input, null, 2)))}</pre>`;
  }
  det.innerHTML = summary + body;
  return det;
}

// ── terminal view ───────────────────────────────────────────────────────────
function closeTerminal(): void { termWs?.close(); termWs = null; term?.dispose(); term = null; }

function connectTerminal(): void {
  if (!current) return;
  closeTerminal();
  term = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace',
    theme: { background: '#0d1117' }, allowProposedApi: true,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(termEl);
  fit.fit();
  termWs = new WebSocket(wsUrl(current.host, '/ws/terminal', { session: current.session.name, cols: String(term.cols), rows: String(term.rows) }));
  termWs.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'output') term!.write(b64ToBytes(msg.data));
    else if (msg.type === 'closed') term!.write(`\r\n[${msg.reason}]\r\n`);
  };
  term.onData((data) => termSend(data));
  window.addEventListener('resize', () => {
    fit?.fit();
    if (term && termWs?.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
}

render();
