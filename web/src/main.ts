import { marked } from 'marked';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { createDockview, type DockviewApi } from 'dockview-core';
import 'dockview-core/dist/styles/dockview.css';

interface Host { name: string; url: string; token?: string }
interface SessionInfo { name: string; windows: number; cwd: string; attached: boolean; created: number; agent?: string }
interface ChatBlock { kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image'; text?: string; tool?: string; input?: any; result?: string; isError?: boolean; image?: string }
interface ChatEvent { role: 'user' | 'assistant'; blocks: ChatBlock[]; ts?: string; uuid?: string; cwd?: string }

const $ = (id: string) => document.getElementById(id)!;
const hostsEl = $('hosts');
const placeholder = $('placeholder');
const sidebar = $('sidebar');
const menuToggle = $('menu-toggle');
const backdrop = $('backdrop');

// ── mobile drawer ─────────────────────────────────────────────────────────
const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
const savedMenu = localStorage.getItem('ap.menu');
const persistMenu = () => localStorage.setItem('ap.menu', document.body.classList.contains('menu-open') ? '1' : '0');
const openMenu = () => { document.body.classList.add('menu-open'); persistMenu(); };
const closeMenu = () => { document.body.classList.remove('menu-open'); persistMenu(); };
menuToggle.addEventListener('click', () => { document.body.classList.toggle('menu-open'); persistMenu(); });
backdrop.addEventListener('click', closeMenu);

// ── new-version notification + refresh ──────────────────────────────────────
const myBundle = (import.meta.url.match(/index-[\w-]+\.js/) || [''])[0];
function showUpdateBanner(): void {
  if (document.getElementById('update-banner')) return;
  const b = document.createElement('div');
  b.id = 'update-banner';
  b.innerHTML = '<span>🔄 A new version is available.</span><button>Refresh</button>';
  b.querySelector('button')!.addEventListener('click', () => location.reload());
  document.body.appendChild(b);
}
async function checkUpdate(): Promise<void> {
  try {
    const res = await fetch(location.href, { cache: 'no-store' });
    if (!res.ok) return;
    const m = (await res.text()).match(/index-[\w-]+\.js/);
    if (m && myBundle && m[0] !== myBundle) showUpdateBanner();
  } catch { /* offline */ }
}
if (myBundle) setInterval(checkUpdate, 60000);

// ── global view filters (hide tool calls / results across all panes) ────────
function setupFilters(): void {
  const bar = document.createElement('div');
  bar.id = 'filters';
  for (const [cls, label] of [['hide-tools', 'tool calls'], ['hide-results', 'results']] as const) {
    if (localStorage.getItem('ap.' + cls) !== '0') document.body.classList.add(cls);
    const btn = document.createElement('button');
    const sync = () => {
      const hidden = document.body.classList.contains(cls);
      btn.textContent = `${hidden ? 'Show' : 'Hide'} ${label}`;
      btn.classList.toggle('active', !hidden);
    };
    btn.addEventListener('click', () => { localStorage.setItem('ap.' + cls, document.body.classList.toggle(cls) ? '1' : '0'); sync(); });
    sync();
    bar.appendChild(btn);
  }
  sidebar.prepend(bar);
}
setupFilters();

// ── rendering helpers (shared) ──────────────────────────────────────────────
const b64ToBytes = (s: string): Uint8Array => { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; };
const clip = (s: string, n = 4000): string => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kstParts = (ts: string): Record<string, string> => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
const kstStamp = (ts?: string): string => { try { const g = kstParts(ts!); return `${g.year}/${g.month}/${g.day} ${g.hour}:${g.minute}`; } catch { return ''; } };
const kstFull = (ts?: string): string => { try { return new Date(ts!).toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour12: false }) + ' KST'; } catch { return ''; } };
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const summarize = (input: any): string => {
  if (!input) return '';
  if (typeof input.command === 'string') return input.command.split('\n')[0].slice(0, 80);
  if (typeof input.cmd === 'string') return input.cmd.split('\n')[0].slice(0, 80); // codex exec_command
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.pattern === 'string') return input.pattern;
  return JSON.stringify(input).slice(0, 80);
};
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'ogv']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp']);
const authHeaders = (h: Host): HeadersInit => (h.token ? { Authorization: `Bearer ${h.token}` } : {});
const PANE_KEYS: Record<string, string> = { esc: '\x1b', tab: '\t', ctrlc: '\x03', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
const ATTACH_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

const PANE_HTML = `
  <div class="pane-head"><span class="pane-title"></span><span class="spacer"></span><button class="pane-mode" type="button"></button></div>
  <div class="pane-chat"></div>
  <div class="pane-term" hidden></div>
  <div class="pane-status" hidden></div>
  <div class="pane-thinking" hidden><span class="spin">✻</span> working…</div>
  <div class="pane-cmd" hidden></div>
  <form class="pane-input">
    <button type="button" class="pane-attach" title="Attach file">${ATTACH_SVG}</button>
    <textarea class="pane-box" rows="1" placeholder="Message the agent…"></textarea>
    <button type="submit">Send</button>
    <input type="file" multiple hidden>
  </form>
  <button class="pane-scroll" type="button" title="Scroll to bottom" hidden>↓</button>`;

// ── one independent session pane ────────────────────────────────────────────
class SessionView {
  el = document.createElement('div');
  private chatEl: HTMLElement; private termEl: HTMLElement;
  private form: HTMLFormElement; private box: HTMLTextAreaElement; private fileInput: HTMLInputElement;
  private thinkingEl: HTMLElement; private statusbar: HTMLElement; private cmdMenu: HTMLElement;
  private modeBtn: HTMLButtonElement; private scrollBtn: HTMLButtonElement;
  private chatWs: WebSocket | null = null; private termWs: WebSocket | null = null;
  private term: Terminal | null = null; private fit: FitAddon | null = null;
  private pending: { text: string; el: HTMLElement }[] = [];
  private commands: { name: string; builtin: boolean }[] = [];
  private mode: 'chat' | 'tmux' = 'chat';

  constructor(private host: Host, private session: string) {
    this.el.className = 'pane';
    this.el.innerHTML = PANE_HTML;
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
    this.chatEl = q('.pane-chat'); this.termEl = q('.pane-term');
    this.form = q('.pane-input'); this.box = q('.pane-box'); this.fileInput = q('.pane-input input[type=file]');
    this.thinkingEl = q('.pane-thinking'); this.statusbar = q('.pane-status'); this.cmdMenu = q('.pane-cmd');
    this.modeBtn = q('.pane-mode'); this.scrollBtn = q('.pane-scroll');
    q('.pane-title').textContent = `${host.name} / ${session}`;

    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.send(this.box.value); this.box.value = ''; this.box.style.height = 'auto'; });
    this.box.addEventListener('input', () => { this.box.style.height = 'auto'; this.box.style.height = Math.min(this.box.scrollHeight, window.innerHeight * 0.35) + 'px'; this.updateCmd(); });
    this.box.addEventListener('keydown', (e) => {
      if (!this.cmdMenu.hidden) {
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); (this.cmdMenu.querySelector('.cmd-item') as HTMLElement | null)?.click(); return; }
        if (e.key === 'Escape') { this.cmdMenu.hidden = true; return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && !isMobile()) { e.preventDefault(); this.form.requestSubmit(); }
    });
    q('.pane-attach').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', async () => { for (const f of Array.from(this.fileInput.files ?? [])) await this.upload(f); this.fileInput.value = ''; });
    this.modeBtn.addEventListener('click', () => this.showMode(this.mode === 'chat' ? 'tmux' : 'chat'));
    this.scrollBtn.addEventListener('click', () => this.chatEl.scrollTo({ top: this.chatEl.scrollHeight, behavior: 'smooth' }));
    this.chatEl.addEventListener('scroll', () => { this.scrollBtn.hidden = this.chatEl.scrollHeight - this.chatEl.scrollTop - this.chatEl.clientHeight < 80; });
    this.setupTouch();

    this.showMode((localStorage.getItem('ap.mode') === 'tmux' ? 'tmux' : 'chat'));
  }

  dispose(): void { this.chatWs?.close(); this.closeTerm(); }

  private wsUrl(path: string, params: Record<string, string>): string {
    const q = new URLSearchParams(params);
    if (this.host.token) q.set('token', this.host.token);
    return `${this.host.url.replace(/^http/, 'ws')}${path}?${q}`;
  }

  private showMode(m: 'chat' | 'tmux'): void {
    this.mode = m;
    localStorage.setItem('ap.mode', m);
    this.modeBtn.textContent = m === 'chat' ? '⌗ tmux' : '💬 chat';
    if (m === 'chat') {
      this.closeTerm(); this.termEl.hidden = true;
      this.chatEl.hidden = false; this.form.hidden = false;
      this.connectChat(); void this.loadCommands();
    } else {
      this.chatWs?.close(); this.chatWs = null;
      this.chatEl.hidden = true; this.form.hidden = true;
      this.statusbar.hidden = true; this.thinkingEl.hidden = true; this.cmdMenu.hidden = true; this.scrollBtn.hidden = true;
      this.termEl.hidden = false;
      this.connectTerm();
    }
  }

  // ── chat ──────────────────────────────────────────────────────────────────
  send(text: string): void {
    if (!text.trim() || this.chatWs?.readyState !== WebSocket.OPEN) return;
    this.chatWs.send(JSON.stringify({ type: 'input', data: text }));
    this.addPending(text.trim());
  }

  private connectChat(): void {
    this.chatWs?.close();
    this.chatEl.innerHTML = '<div class="loading"><span class="spin">✻</span> loading…</div>';
    this.pending = [];
    this.thinkingEl.hidden = true; this.statusbar.hidden = true;
    let first = true;
    this.chatWs = new WebSocket(this.wsUrl('/ws/chat', { session: this.session }));
    this.chatWs.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'chat-error') { this.chatEl.innerHTML = '<div class="empty">No conversation transcript for this session.</div>'; return; }
      if (msg.type === 'status') {
        this.thinkingEl.hidden = !msg.busy;
        const parts: string[] = [];
        if (msg.model) parts.push(msg.model);
        if (msg.context != null) parts.push(`${msg.context}% context`);
        if (msg.thinking) parts.push(`thinking: ${msg.thinking}`);
        this.statusbar.textContent = parts.join('  ·  ');
        this.statusbar.hidden = parts.length === 0;
        return;
      }
      if (msg.type !== 'chat') return;
      if (first) this.chatEl.innerHTML = '';
      const nearBottom = this.chatEl.scrollHeight - this.chatEl.scrollTop - this.chatEl.clientHeight < 80;
      const frag = document.createDocumentFragment();
      for (const e of msg.events as ChatEvent[]) { this.resolvePending(e); const el = this.renderEvent(e); if (!first) el.classList.add('fade-in'); frag.appendChild(el); }
      for (const p of this.pending) frag.appendChild(p.el);
      this.chatEl.appendChild(frag);
      const asks = this.chatEl.querySelectorAll('.ask');
      asks.forEach((a, i) => { if (i < asks.length - 1) for (const b of a.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true; });
      if (nearBottom) { if (first) this.chatEl.scrollTop = this.chatEl.scrollHeight; else this.chatEl.scrollTo({ top: this.chatEl.scrollHeight, behavior: 'smooth' }); }
      first = false;
    };
  }

  private addPending(text: string): void {
    const el = document.createElement('div');
    el.className = 'msg user pending fade-in';
    el.innerHTML = `<div class="who">You <span class="queued">queued</span></div><div class="bubble"></div>`;
    el.querySelector('.bubble')!.textContent = text;
    this.pending.push({ text, el });
    this.chatEl.appendChild(el);
    this.chatEl.scrollTo({ top: this.chatEl.scrollHeight, behavior: 'smooth' });
  }

  private resolvePending(e: ChatEvent): void {
    if (e.role !== 'user' || this.pending.length === 0) return;
    const t = norm(e.blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join(''));
    if (!t) return;
    let i = this.pending.findIndex((p) => norm(p.text) === t);
    if (i < 0) i = 0;
    this.pending[i].el.remove();
    this.pending.splice(i, 1);
  }

  private fileUrl(path: string, base?: string): string {
    const q = new URLSearchParams({ session: this.session, path });
    if (base) q.set('base', base);
    if (this.host.token) q.set('token', this.host.token);
    return `${this.host.url}/api/file?${q}`;
  }

  private renderEvent(e: ChatEvent): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = `msg ${e.role}`;
    const isToolOutput = e.role === 'user' && e.blocks.length > 0 && e.blocks.every((b) => b.kind === 'tool_result');
    if (e.role === 'user' && !isToolOutput) {
      const who = document.createElement('div');
      who.className = 'who';
      who.innerHTML = 'You ' + (e.ts ? `<span class="ts" title="${esc(kstFull(e.ts))}">${kstStamp(e.ts)}</span>` : '');
      wrap.appendChild(who);
    }
    for (const b of e.blocks) {
      if (b.kind === 'text' && b.text) { const d = document.createElement('div'); d.className = 'bubble'; d.innerHTML = marked.parse(b.text) as string; wrap.appendChild(d); }
      else if (b.kind === 'thinking' && b.text) { const d = document.createElement('details'); d.className = 'tool'; d.innerHTML = `<summary><span class="tname">💭 thinking</span></summary><div class="think"><pre>${esc(clip(b.text))}</pre></div>`; wrap.appendChild(d); }
      else if (b.kind === 'image' && b.image) { const img = document.createElement('img'); img.className = 'chat-img'; img.loading = 'lazy'; img.src = b.image; wrap.appendChild(img); }
      else if (b.kind === 'tool_use' && b.tool === 'AskUserQuestion') wrap.appendChild(this.renderAsk(b.input));
      else if (b.kind === 'tool_use' && b.tool === 'SendUserFile') wrap.appendChild(this.renderFiles(b, e.cwd));
      else if (b.kind === 'tool_use') wrap.appendChild(this.renderToolUse(b));
      else if (b.kind === 'tool_result' && b.result) { const d = document.createElement('details'); d.className = 'tool tr'; d.innerHTML = `<summary><span class="tname">${b.isError ? '⚠ result' : '▸ result'}</span></summary><pre>${esc(clip(b.result))}</pre>`; wrap.appendChild(d); }
    }
    return wrap;
  }

  private renderToolUse(b: ChatBlock): HTMLElement {
    const det = document.createElement('details');
    det.className = 'tool tu';
    let body: string;
    if ((b.tool === 'Edit' || b.tool === 'Write') && (b.input?.new_string !== undefined || b.input?.content !== undefined)) {
      const oldS = b.input.old_string ?? ''; const newS = b.input.new_string ?? b.input.content ?? '';
      body = (oldS ? `<pre class="del">${esc(clip(oldS, 2000))}</pre>` : '') + `<pre class="add">${esc(clip(newS, 2000))}</pre>`;
    } else body = `<pre>${esc(clip(JSON.stringify(b.input, null, 2)))}</pre>`;
    det.innerHTML = `<summary><span class="tname">🔧 ${esc(b.tool ?? 'tool')}</span><span class="targ">${esc(summarize(b.input))}</span></summary>${body}`;
    return det;
  }

  private renderFiles(b: ChatBlock, base?: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'files';
    for (const f of (Array.isArray(b.input?.files) ? b.input.files : []) as string[]) {
      const url = this.fileUrl(f, base);
      const ext = (f.split('.').pop() ?? '').toLowerCase();
      if (VIDEO_EXT.has(ext)) { const v = document.createElement('video'); v.className = 'chat-img'; v.controls = true; v.preload = 'metadata'; v.playsInline = true; v.src = url; wrap.appendChild(v); }
      else if (IMAGE_EXT.has(ext)) { const img = document.createElement('img'); img.className = 'chat-img'; img.loading = 'lazy'; img.src = url; wrap.appendChild(img); }
      else { const a = document.createElement('a'); a.className = 'file-link'; a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '📎 ' + (f.split('/').pop() ?? f); wrap.appendChild(a); }
    }
    if (typeof b.input?.caption === 'string' && b.input.caption.trim()) { const c = document.createElement('div'); c.className = 'cap'; c.textContent = b.input.caption; wrap.appendChild(c); }
    return wrap;
  }

  private renderAsk(input: any): HTMLElement {
    const box = document.createElement('div');
    box.className = 'ask';
    const questions: any[] = Array.isArray(input?.questions) ? input.questions : [];
    const chosen = new Map<number, string>();
    questions.forEach((qq, qi) => {
      const qd = document.createElement('div'); qd.className = 'ask-q';
      const qt = document.createElement('div'); qt.className = 'ask-qtext'; qt.textContent = qq.question ?? ''; qd.appendChild(qt);
      const opts = document.createElement('div'); opts.className = 'ask-opts';
      for (const o of qq.options ?? []) {
        const btn = document.createElement('button'); btn.className = 'ask-opt'; btn.textContent = o.label ?? '';
        btn.addEventListener('click', () => { chosen.set(qi, btn.textContent ?? ''); for (const x of opts.querySelectorAll('.ask-opt')) x.classList.remove('chosen'); btn.classList.add('chosen'); });
        opts.appendChild(btn);
      }
      qd.appendChild(opts); box.appendChild(qd);
    });
    const row = document.createElement('div'); row.className = 'ask-actions';
    const send = document.createElement('button'); send.className = 'ask-send'; send.textContent = 'Send answer';
    send.addEventListener('click', () => { const ans = questions.map((_, qi) => chosen.get(qi)).filter(Boolean) as string[]; if (!ans.length) return; this.send(ans.join('\n')); for (const b of box.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true; send.textContent = 'Sent'; });
    const tmux = document.createElement('button'); tmux.className = 'ask-tmux'; tmux.textContent = '↗ answer in tmux';
    tmux.addEventListener('click', () => this.showMode('tmux'));
    row.append(send, tmux); box.appendChild(row);
    return box;
  }

  private updateCmd(): void {
    const m = this.box.value.match(/^\/(\S*)$/);
    if (!m) { this.cmdMenu.hidden = true; return; }
    const q = m[1].toLowerCase();
    const matches = this.commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
    if (!matches.length) { this.cmdMenu.hidden = true; return; }
    this.cmdMenu.innerHTML = '';
    for (const c of matches) {
      const it = document.createElement('div'); it.className = 'cmd-item';
      it.innerHTML = `<span class="cmd-name">/${c.name}</span>${c.builtin ? '' : '<span class="cmd-src">custom</span>'}`;
      it.addEventListener('click', () => { this.box.value = `/${c.name} `; this.cmdMenu.hidden = true; this.box.focus(); });
      this.cmdMenu.appendChild(it);
    }
    this.cmdMenu.hidden = false;
  }

  private async loadCommands(): Promise<void> {
    this.commands = [];
    try { const r = await fetch(`${this.host.url}/api/commands?session=${encodeURIComponent(this.session)}`, { headers: authHeaders(this.host) }); if (r.ok) this.commands = await r.json(); } catch { /* ignore */ }
  }

  private async upload(f: File): Promise<void> {
    try {
      const r = await fetch(`${this.host.url}/api/upload?session=${encodeURIComponent(this.session)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { ...authHeaders(this.host), 'Content-Type': 'application/octet-stream' }, body: f });
      if (!r.ok) return;
      const { path } = await r.json();
      const cur = this.box.value;
      this.box.value = (cur && !cur.endsWith(' ') ? cur + ' ' : cur) + path + ' ';
      this.box.focus(); this.box.dispatchEvent(new Event('input'));
    } catch { /* ignore */ }
  }

  // ── tmux (terminal) ─────────────────────────────────────────────────────────
  private termSend(d: string): void { if (this.termWs?.readyState === WebSocket.OPEN) this.termWs.send(JSON.stringify({ type: 'input', data: d })); }
  private closeTerm(): void { this.termWs?.close(); this.termWs = null; this.term?.dispose(); this.term = null; }
  private setupTouch(): void {
    let y = 0, acc = 0;
    this.termEl.addEventListener('touchstart', (e) => { y = e.touches[0].clientY; acc = 0; }, { passive: true });
    this.termEl.addEventListener('touchmove', (e) => { acc += e.touches[0].clientY - y; y = e.touches[0].clientY; while (Math.abs(acc) >= 16) { this.termSend(acc > 0 ? '\x1b[<64;1;1M' : '\x1b[<65;1;1M'); acc += acc > 0 ? -16 : 16; } e.preventDefault(); }, { passive: false });
  }
  private connectTerm(): void {
    this.closeTerm();
    this.term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000, fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace', theme: { background: '#0d1117' }, allowProposedApi: true });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit); this.term.loadAddon(new Unicode11Addon()); this.term.unicode.activeVersion = '11';
    this.term.open(this.termEl); this.fit.fit();
    this.termWs = new WebSocket(this.wsUrl('/ws/terminal', { session: this.session, cols: String(this.term.cols), rows: String(this.term.rows) }));
    this.termWs.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'output') this.term!.write(b64ToBytes(m.data)); else if (m.type === 'closed') this.term!.write(`\r\n[${m.reason}]\r\n`); };
    this.term.onData((d) => this.termSend(d));
  }
  resize(): void { if (this.mode === 'tmux' && this.term && this.fit) { this.fit.fit(); if (this.termWs?.readyState === WebSocket.OPEN) this.termWs.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows })); } }
}

// ── hosts / discovery ───────────────────────────────────────────────────────
const loadManual = (): Host[] => JSON.parse(localStorage.getItem('agents-portal.hosts') ?? '[]');
async function discoverHosts(): Promise<Host[]> {
  const hosts: Host[] = [];
  try {
    const res = await fetch(`${location.origin}/api/hosts`);
    if (res.ok) for (const p of await res.json() as any[]) if (p.online) hosts.push({ name: p.hostName, url: p.self ? location.origin : `https://${p.dnsName}` });
  } catch { /* manual only */ }
  for (const m of loadManual()) if (!hosts.some((h) => h.url === m.url)) hosts.push(m);
  return hosts;
}

// ── dockview (panes) ────────────────────────────────────────────────────────
const views = new Set<SessionView>();
const panelId = (hostUrl: string, session: string) => `${hostUrl}|${session}`;

const dock: DockviewApi = createDockview($('dock'), {
  createComponent: () => {
    const container = document.createElement('div');
    container.className = 'pane-wrap';
    let view: SessionView | null = null;
    return {
      element: container,
      init(params: any) {
        const p = params.params ?? {};
        view = new SessionView({ name: p.hostName, url: p.hostUrl, token: p.token }, p.sessionName);
        views.add(view);
        container.appendChild(view.el);
        params.api.onDidDimensionsChange(() => view!.resize()); // refit terminal on pane resize
      },
      dispose() { if (view) { view.dispose(); views.delete(view); } },
    };
  },
});

const persistLayout = () => localStorage.setItem('ap.layout', JSON.stringify(dock.toJSON()));
dock.onDidLayoutChange(() => { persistLayout(); syncUI(); });
dock.onDidRemovePanel(() => syncCheckboxes());
const panelApi = (id: string) => dock.panels.find((p) => p.id === id);

function openPane(host: Host, session: string): void {
  const id = panelId(host.url, session);
  if (panelApi(id)) { dock.getPanel(id)?.api.setActive(); return; }
  dock.addPanel({ id, component: 'session', title: session, params: { hostUrl: host.url, hostName: host.name, token: host.token, sessionName: session } });
}
function closePane(host: Host, session: string): void { dock.getPanel(panelId(host.url, session))?.api.close(); }

function syncUI(): void { placeholder.style.display = dock.panels.length ? 'none' : ''; }
function syncCheckboxes(): void {
  for (const cb of Array.from(hostsEl.querySelectorAll<HTMLInputElement>('input.sess-cb'))) {
    cb.checked = !!panelApi(cb.dataset.id!);
  }
  syncUI();
}

// ── session list (checkboxes) ───────────────────────────────────────────────
async function render(): Promise<void> {
  hostsEl.innerHTML = '';
  for (const host of await discoverHosts()) {
    const header = document.createElement('li'); header.className = 'host-name'; header.textContent = host.name; hostsEl.appendChild(header);
    let sessions: SessionInfo[] = [];
    try { const res = await fetch(`${host.url}/api/sessions`, { headers: authHeaders(host) }); if (!res.ok) { header.textContent = `${host.name} — ${res.status}`; continue; } sessions = await res.json(); }
    catch { header.textContent = `${host.name} — offline`; continue; }
    if (!sessions.length) header.textContent = `${host.name} — no sessions`;
    for (const s of sessions) {
      const li = document.createElement('li'); li.className = 'session';
      const id = panelId(host.url, s.name);
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'sess-cb'; cb.dataset.id = id; cb.checked = !!panelApi(id);
      cb.addEventListener('change', () => { if (cb.checked) openPane(host, s.name); else closePane(host, s.name); if (isMobile() && cb.checked) closeMenu(); });
      const label = document.createElement('span'); label.className = 'sess-label';
      const badge = s.agent ? `<span class="agent-badge ${s.agent}">${s.agent}</span>` : '';
      label.innerHTML = `<span>${s.name}</span>${badge}<span class="cwd">${s.cwd.split('/').pop() ?? ''}</span>`;
      label.addEventListener('click', () => { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); });
      li.append(cb, label); hostsEl.appendChild(li);
    }
  }
  syncCheckboxes();
}

window.addEventListener('resize', () => { for (const v of views) v.resize(); });

(async () => {
  await render();
  const saved = localStorage.getItem('ap.layout');
  if (saved) { try { dock.fromJSON(JSON.parse(saved)); } catch { /* ignore */ } }
  syncCheckboxes();
  if (savedMenu === '1') openMenu(); else if (savedMenu === '0') closeMenu(); else if (isMobile()) openMenu();
})();
