import { marked } from 'marked';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

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
const chatForm = $('chatinput') as HTMLFormElement;
const chatbox = $('chatbox') as HTMLTextAreaElement;
const menuToggle = $('menu-toggle');
const backdrop = $('backdrop');
const sidebar = $('sidebar');

let activeEl: HTMLElement | null = null;
let current: { host: Host; session: SessionInfo } | null = null;
let chatWs: WebSocket | null = null;
let pending: { text: string; el: HTMLElement }[] = [];
let commands: { name: string; builtin: boolean }[] = [];

// ── mobile menu (sidebar drawer) ─────────────────────────────────────────────
const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
const savedMenu = localStorage.getItem('ap.menu'); // read before anything mutates it
const persistMenu = () => localStorage.setItem('ap.menu', document.body.classList.contains('menu-open') ? '1' : '0');
const openMenu = () => { document.body.classList.add('menu-open'); persistMenu(); };
const closeMenu = () => { document.body.classList.remove('menu-open'); persistMenu(); };
const toggleMenu = () => { document.body.classList.toggle('menu-open'); persistMenu(); };
menuToggle.addEventListener('click', toggleMenu);
backdrop.addEventListener('click', closeMenu);

// ── view filters (menu: hide all tool calls / results) ───────────────────────
function setupFilters(): void {
  const bar = document.createElement('div');
  bar.id = 'filters';
  for (const [cls, label] of [['hide-tools', 'tool calls'], ['hide-results', 'results']] as const) {
    // hidden by default; respect an explicit "shown" choice
    if (localStorage.getItem('ap.' + cls) !== '0') document.body.classList.add(cls);
    const btn = document.createElement('button');
    const sync = () => {
      const hidden = document.body.classList.contains(cls);
      btn.textContent = `${hidden ? 'Show' : 'Hide'} ${label}`;
      btn.classList.toggle('active', !hidden); // highlight when shown
    };
    btn.addEventListener('click', () => {
      const on = document.body.classList.toggle(cls);
      localStorage.setItem('ap.' + cls, on ? '1' : '0');
      sync();
    });
    sync();
    bar.appendChild(btn);
  }
  sidebar.prepend(bar);
}
setupFilters();

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatbox.value;
  if (!text.trim() || chatWs?.readyState !== WebSocket.OPEN) return;
  chatWs.send(JSON.stringify({ type: 'input', data: text }));
  addPending(text.trim()); // show immediately as "queued" until it lands in the transcript
  chatbox.value = '';
  chatbox.style.height = 'auto';
});
chatbox.addEventListener('input', () => {
  chatbox.style.height = 'auto';
  chatbox.style.height = Math.min(chatbox.scrollHeight, window.innerHeight * 0.4) + 'px';
});
// "working…" indicator + slash-command menu, just above the input bar.
const thinkingEl = document.createElement('div');
thinkingEl.id = 'thinking';
thinkingEl.hidden = true;
thinkingEl.innerHTML = '<span class="spin">✻</span> working…';
chatForm.parentElement!.insertBefore(thinkingEl, chatForm);

// status bar: model · context % · thinking mode (parsed from the agent's TUI)
const statusbar = document.createElement('div');
statusbar.id = 'statusbar';
statusbar.hidden = true;
chatForm.parentElement!.insertBefore(statusbar, chatForm);

const cmdMenu = document.createElement('div');
cmdMenu.id = 'cmdmenu';
cmdMenu.hidden = true;
chatForm.parentElement!.insertBefore(cmdMenu, chatForm);

// attach button + hidden file input inside the input bar
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.multiple = true;
fileInput.hidden = true;
const attachBtn = document.createElement('button');
attachBtn.type = 'button';
attachBtn.id = 'attach';
attachBtn.title = 'Attach file';
attachBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
chatForm.insertBefore(attachBtn, chatbox);
chatForm.appendChild(fileInput);
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  for (const f of Array.from(fileInput.files ?? [])) await uploadFile(f);
  fileInput.value = '';
});

chatbox.addEventListener('input', updateCmdMenu);
chatbox.addEventListener('keydown', (e) => {
  if (!cmdMenu.hidden) {
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      (cmdMenu.querySelector('.cmd-item') as HTMLElement | null)?.click();
      return;
    }
    if (e.key === 'Escape') { cmdMenu.hidden = true; return; }
  }
  // Desktop: Enter sends, Shift+Enter newline. (Mobile keeps Enter = newline; tap Send.)
  if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

function updateCmdMenu(): void {
  const m = chatbox.value.match(/^\/(\S*)$/); // only while typing a leading /command
  if (!m) { cmdMenu.hidden = true; return; }
  const q = m[1].toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
  if (matches.length === 0) { cmdMenu.hidden = true; return; }
  cmdMenu.innerHTML = '';
  for (const c of matches) {
    const it = document.createElement('div');
    it.className = 'cmd-item';
    it.innerHTML = `<span class="cmd-name">/${c.name}</span>${c.builtin ? '' : '<span class="cmd-src">custom</span>'}`;
    it.addEventListener('click', () => { chatbox.value = `/${c.name} `; cmdMenu.hidden = true; chatbox.focus(); });
    cmdMenu.appendChild(it);
  }
  cmdMenu.hidden = false;
}

async function uploadFile(f: File): Promise<void> {
  if (!current) return;
  const url = `${current.host.url}/api/upload?session=${encodeURIComponent(current.session.name)}&name=${encodeURIComponent(f.name)}`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { ...authHeaders(current.host), 'Content-Type': 'application/octet-stream' }, body: f });
    if (!res.ok) return;
    const { path } = await res.json();
    const cur = chatbox.value;
    chatbox.value = (cur && !cur.endsWith(' ') ? cur + ' ' : cur) + path + ' ';
    chatbox.focus();
    chatbox.dispatchEvent(new Event('input'));
  } catch { /* ignore */ }
}

async function loadCommands(): Promise<void> {
  commands = [];
  if (!current) return;
  try {
    const res = await fetch(`${current.host.url}/api/commands?session=${encodeURIComponent(current.session.name)}`, { headers: authHeaders(current.host) });
    if (res.ok) commands = await res.json();
  } catch { /* ignore */ }
}

// scroll-to-bottom button (shown when the chat isn't near the bottom)
const main = chatEl.parentElement!;
const scrollBtn = document.createElement('button');
scrollBtn.id = 'scrollbottom';
scrollBtn.title = 'Scroll to bottom';
scrollBtn.textContent = '↓';
scrollBtn.hidden = true;
main.appendChild(scrollBtn);
scrollBtn.addEventListener('click', () => { chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' }); });
chatEl.addEventListener('scroll', () => {
  scrollBtn.hidden = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
});

// chapters: a sidebar section listing this session's user messages
const chaptersSection = document.createElement('div');
chaptersSection.id = 'chapters-section';
chaptersSection.hidden = true;
chaptersSection.innerHTML = '<div class="sec-title">Messages</div><ul id="chapter-list"></ul>';
sidebar.appendChild(chaptersSection);
const chapterListEl = chaptersSection.querySelector('#chapter-list')!;

function addChapter(text: string, target: HTMLElement, ts?: string): void {
  const li = document.createElement('li');
  li.className = 'chapter-item';
  li.innerHTML = `<span class="ch-text"></span>${ts ? `<span class="ch-ts">${kstStamp(ts)}</span>` : ''}`;
  li.querySelector('.ch-text')!.textContent = text.replace(/\s+/g, ' ').slice(0, 60);
  if (ts) li.title = kstFull(ts);
  li.addEventListener('click', () => {
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (isMobile()) closeMenu();
  });
  chapterListEl.appendChild(li);
}

// ── tmux (terminal) view + chat/tmux mode toggle ─────────────────────────────
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let termWs: WebSocket | null = null;
let mode: 'chat' | 'tmux' = 'chat';

const termEl = document.createElement('div');
termEl.id = 'terminal';
termEl.hidden = true;
main.appendChild(termEl);

const toolbar = document.createElement('nav');
toolbar.id = 'toolbar';
toolbar.hidden = true;
toolbar.innerHTML = ['esc:Esc', 'tab:Tab', 'ctrlc:^C', 'up:↑', 'down:↓', 'left:←', 'right:→', 'pageup:⤒', 'pagedown:⤓']
  .map((s) => { const [k, l] = s.split(':'); return `<button data-key="${k}">${l}</button>`; }).join('');
main.appendChild(toolbar);

const modeToggle = document.createElement('button');
modeToggle.id = 'mode-toggle';
modeToggle.hidden = true;
main.appendChild(modeToggle);
modeToggle.addEventListener('click', () => showMode(mode === 'chat' ? 'tmux' : 'chat'));

const b64ToBytes = (s: string): Uint8Array => {
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
};
const TERM_KEYS: Record<string, string> = { esc: '\x1b', tab: '\t', ctrlc: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
function termSend(data: string): void { if (termWs?.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: 'input', data })); }
for (const btn of Array.from(toolbar.querySelectorAll('button'))) {
  const key = (btn as HTMLElement).dataset.key ?? '';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (key === 'pageup') term?.scrollPages(-1);
    else if (key === 'pagedown') term?.scrollPages(1);
    else if (TERM_KEYS[key]) termSend(TERM_KEYS[key]);
    term?.focus();
  });
}
let tY = 0, tAcc = 0;
termEl.addEventListener('touchstart', (e) => { tY = e.touches[0].clientY; tAcc = 0; }, { passive: true });
termEl.addEventListener('touchmove', (e) => {
  tAcc += e.touches[0].clientY - tY; tY = e.touches[0].clientY;
  while (Math.abs(tAcc) >= 16) { term?.scrollLines(tAcc > 0 ? -1 : 1); tAcc += tAcc > 0 ? -16 : 16; }
  e.preventDefault();
}, { passive: false });

function closeTerminal(): void { termWs?.close(); termWs = null; term?.dispose(); term = null; }
function connectTerminal(): void {
  if (!current) return;
  closeTerminal();
  term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace', theme: { background: '#0d1117' }, allowProposedApi: true });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(termEl);
  fit.fit();
  termWs = new WebSocket(wsUrl(current.host, '/ws/terminal', { session: current.session.name, cols: String(term.cols), rows: String(term.rows) }));
  termWs.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'output') term!.write(b64ToBytes(m.data));
    else if (m.type === 'closed') term!.write(`\r\n[${m.reason}]\r\n`);
  };
  term.onData((d) => termSend(d));
  window.addEventListener('resize', () => {
    if (mode !== 'tmux') return;
    fit?.fit();
    if (term && termWs?.readyState === WebSocket.OPEN) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
}

function showMode(m: 'chat' | 'tmux'): void {
  mode = m;
  localStorage.setItem('ap.mode', m);
  modeToggle.textContent = m === 'chat' ? '⌗ tmux' : '💬 chat';
  if (m === 'chat') {
    closeTerminal();
    termEl.hidden = true; toolbar.hidden = true;
    chatEl.hidden = false; chatForm.hidden = false; chaptersSection.hidden = false;
    connectChat();
    void loadCommands();
  } else {
    closeChat();
    chatEl.hidden = true; chatForm.hidden = true; chaptersSection.hidden = true;
    statusbar.hidden = true; thinkingEl.hidden = true; cmdMenu.hidden = true;
    termEl.hidden = false; toolbar.hidden = false;
    connectTerminal();
  }
}

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
      li.dataset.host = host.url;
      li.dataset.session = s.name;
      li.innerHTML = `<span class="dot"></span><span>${s.name}</span><span class="cwd">${s.cwd.split('/').pop() ?? ''}</span>`;
      li.addEventListener('click', () => openSession(host, s, li));
      hostsEl.appendChild(li);
    }
  }
  restoreSession();
  // apply the cached drawer state last so restore can't clobber it
  if (savedMenu === '1') openMenu();
  else if (savedMenu === '0') closeMenu();
  else if (isMobile()) openMenu();
}

// re-open the previously selected session (if it still exists)
function restoreSession(): void {
  const raw = localStorage.getItem('ap.session');
  if (!raw) return;
  try {
    const { hostUrl, sessionName } = JSON.parse(raw);
    for (const li of Array.from(hostsEl.querySelectorAll<HTMLElement>('.session'))) {
      if (li.dataset.host === hostUrl && li.dataset.session === sessionName) { li.click(); return; }
    }
  } catch { /* ignore */ }
}

// ── session + conversation view ──────────────────────────────────────────────
function openSession(host: Host, session: SessionInfo, el: HTMLElement): void {
  activeEl?.classList.remove('active');
  el.classList.add('active');
  activeEl = el;
  current = { host, session };
  placeholder.style.display = 'none';
  modeToggle.hidden = false;
  localStorage.setItem('ap.session', JSON.stringify({ hostUrl: host.url, sessionName: session.name }));
  showMode(localStorage.getItem('ap.mode') === 'tmux' ? 'tmux' : 'chat');
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
  pending = [];
  chapterListEl.innerHTML = '';
  thinkingEl.hidden = true;
  statusbar.hidden = true;
  let firstBatch = true; // don't animate the initial history dump
  chatWs = new WebSocket(wsUrl(current.host, '/ws/chat', { session: current.session.name }));
  chatWs.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'chat-error') {
      chatEl.innerHTML = '<div class="empty">No conversation transcript for this session.</div>';
      return;
    }
    if (msg.type === 'status') {
      thinkingEl.hidden = !msg.busy;
      const parts: string[] = [];
      if (msg.model) parts.push(msg.model);
      if (msg.context != null) parts.push(`${msg.context}% context`);
      if (msg.thinking) parts.push(`thinking: ${msg.thinking}`);
      statusbar.textContent = parts.join('  ·  ');
      statusbar.hidden = parts.length === 0;
      return;
    }
    if (msg.type !== 'chat') return;
    const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
    const frag = document.createDocumentFragment();
    for (const e of msg.events as ChatEvent[]) {
      resolvePending(e); // a real user message arriving clears its queued placeholder
      const el = renderEvent(e);
      if (!firstBatch) el.classList.add('fade-in'); // animate live messages
      frag.appendChild(el);
    }
    // keep queued placeholders at the bottom, after newly-rendered events
    for (const p of pending) frag.appendChild(p.el);
    chatEl.appendChild(frag);
    if (nearBottom) {
      if (firstBatch) chatEl.scrollTop = chatEl.scrollHeight; // jump on initial load
      else chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' }); // glide up to new messages
    }
    firstBatch = false;
  };
}

// optimistic "queued" message, shown until the transcript reports it
function addPending(text: string): void {
  const el = document.createElement('div');
  el.className = 'msg user pending fade-in';
  el.innerHTML = `<div class="who">You <span class="queued">queued</span></div><div class="bubble"></div>`;
  el.querySelector('.bubble')!.textContent = text;
  pending.push({ text, el });
  chatEl.appendChild(el);
  chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: 'smooth' });
}

const eventUserText = (e: ChatEvent): string =>
  e.blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('').trim();

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
function resolvePending(e: ChatEvent): void {
  if (e.role !== 'user' || pending.length === 0) return;
  const t = norm(eventUserText(e));
  if (!t) return;
  const i = pending.findIndex((p) => norm(p.text) === t);
  if (i >= 0) { pending[i].el.remove(); pending.splice(i, 1); }
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

// date + time stamp in Korea Standard Time, formatted YY/MM/DD HH:MM
const kstStamp = (ts?: string): string => {
  if (!ts) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts));
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${g('year')}/${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
  } catch { return ''; }
};
const kstFull = (ts?: string): string => {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour12: false }) + ' KST'; }
  catch { return ''; }
};

function renderEvent(e: ChatEvent): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `msg ${e.role}`;
  // A "user" event that is only tool_result blocks is tool output, not a person.
  const isToolOutput = e.role === 'user' && e.blocks.length > 0 && e.blocks.every((b) => b.kind === 'tool_result');
  const showUser = e.role === 'user' && !isToolOutput;
  // Only user messages get a header + datetime stamp; agent replies are bare.
  if (showUser) {
    const who = document.createElement('div');
    who.className = 'who';
    const tsHtml = e.ts ? `<span class="ts" title="${esc(kstFull(e.ts))}">${kstStamp(e.ts)}</span>` : '';
    who.innerHTML = 'You ' + tsHtml;
    wrap.appendChild(who);
    const t = eventUserText(e);
    if (t) addChapter(t, wrap, e.ts); // sidebar "Messages" jump list
  }
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
      det.className = 'tool tr';
      det.innerHTML = `<summary><span class="tname">${b.isError ? '⚠ result' : '▸ result'}</span></summary><pre>${esc(clip(b.result))}</pre>`;
      wrap.appendChild(det);
    }
  }
  return wrap;
}

function renderToolUse(b: ChatBlock): HTMLElement {
  const det = document.createElement('details');
  det.className = 'tool tu';
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

render(); // builds the session list, then restores the cached session + drawer state
