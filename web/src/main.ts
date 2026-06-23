import { marked } from 'marked';

interface Host { name: string; url: string; token?: string }
interface SessionInfo { name: string; windows: number; cwd: string; attached: boolean; created: number }
interface ChatBlock { kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'; text?: string; tool?: string; input?: any; result?: string; isError?: boolean }
interface ChatEvent { role: 'user' | 'assistant'; blocks: ChatBlock[]; ts?: string; uuid?: string }

const STORE_KEY = 'agents-portal.hosts';
const loadManual = (): Host[] => JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');

const $ = (id: string) => document.getElementById(id)!;
const hostsEl = $('hosts');
const placeholder = $('placeholder');
const chatEl = $('chat');
const topbar = $('topbar') as HTMLElement;
const chatForm = $('chatinput') as HTMLFormElement;
const chatbox = $('chatbox') as HTMLTextAreaElement;
const sessionLabel = $('session-label');
const menuToggle = $('menu-toggle');
const backdrop = $('backdrop');

let activeEl: HTMLElement | null = null;
let current: { host: Host; session: SessionInfo } | null = null;
let chatWs: WebSocket | null = null;

// ── mobile menu (sidebar drawer) ─────────────────────────────────────────────
const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
const openMenu = () => document.body.classList.add('menu-open');
const closeMenu = () => document.body.classList.remove('menu-open');
const toggleMenu = () => document.body.classList.toggle('menu-open');
menuToggle.addEventListener('click', toggleMenu);
backdrop.addEventListener('click', closeMenu);

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatbox.value;
  if (!text.trim() || chatWs?.readyState !== WebSocket.OPEN) return;
  chatWs.send(JSON.stringify({ type: 'input', data: text }));
  chatbox.value = '';
  chatbox.style.height = 'auto';
});
chatbox.addEventListener('input', () => {
  chatbox.style.height = 'auto';
  chatbox.style.height = Math.min(chatbox.scrollHeight, window.innerHeight * 0.4) + 'px';
});

// ── hosts / discovery ───────────────────────────────────────────────────────
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

// ── session + conversation view ──────────────────────────────────────────────
function openSession(host: Host, session: SessionInfo, el: HTMLElement): void {
  activeEl?.classList.remove('active');
  el.classList.add('active');
  activeEl = el;
  current = { host, session };
  placeholder.style.display = 'none';
  topbar.hidden = false;
  sessionLabel.textContent = `${host.name} / ${session.name}`;
  chatEl.hidden = false;
  chatForm.hidden = false;
  connectChat();
  if (isMobile()) closeMenu(); // picking a session collapses the drawer on mobile
}

function wsUrl(host: Host, path: string, params: Record<string, string>): string {
  const q = new URLSearchParams(params);
  if (host.token) q.set('token', host.token);
  return `${host.url.replace(/^http/, 'ws')}${path}?${q}`;
}

function closeChat(): void { chatWs?.close(); chatWs = null; }

function connectChat(): void {
  if (!current) return;
  closeChat();
  chatEl.innerHTML = '';
  chatWs = new WebSocket(wsUrl(current.host, '/ws/chat', { session: current.session.name }));
  chatWs.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'chat-error') {
      chatEl.innerHTML = '<div class="empty">No conversation transcript for this session.</div>';
      return;
    }
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

render();
