// Read & tail a coding agent's own session transcript (its source-of-truth log)
// and normalize it into chat events, so the web UI can render a clean
// conversation without scraping the terminal. Claude Code first.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ChatBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  tool?: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  image?: string; // data URI or URL (e.g. from a Read of an image file)
}

function imageUri(source: any): string | null {
  if (!source) return null;
  if (source.type === 'base64' && source.data) return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  if (source.type === 'url' && source.url) return source.url;
  return null;
}
export interface ChatEvent {
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  ts?: string;
  uuid?: string;
  cwd?: string; // event's working dir — resolves relative file paths (SendUserFile)
}

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

/** Claude slugs a cwd by replacing every non-alphanumeric char with '-'. */
function claudeSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Newest *.jsonl in a dir, or null. */
function newestJsonl(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f));
  let best: string | null = null;
  let bestM = -1;
  for (const f of files) {
    const m = statSync(f).mtimeMs;
    if (m > bestM) {
      bestM = m;
      best = f;
    }
  }
  return best;
}

/** Locate the active Claude transcript for a working directory (newest). */
export function findClaudeTranscript(cwd: string): string | null {
  return newestJsonl(join(CLAUDE_PROJECTS, claudeSlug(cwd)));
}

/** Exact transcript path for a known session id (from ~/.claude/sessions). */
export function transcriptForSession(cwd: string, sessionId: string): string | null {
  const p = join(CLAUDE_PROJECTS, claudeSlug(cwd), `${sessionId}.jsonl`);
  return existsSync(p) ? p : null;
}

/** Event timestamps (epoch seconds) in a transcript, via a fast line scan. */
function eventTimes(file: string): number[] {
  const out: number[] = [];
  let data = '';
  try { data = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of data.split('\n')) {
    const m = line.match(/"timestamp":"([^"]+)"/);
    if (m) { const t = Date.parse(m[1]); if (!Number.isNaN(t)) out.push(t / 1000); }
  }
  return out;
}

/**
 * Assign each Claude session (in one cwd) to a DISTINCT transcript by matching
 * its process start time to the nearest event, greedily, so sessions sharing a
 * cwd don't all collapse onto the newest transcript. Cached briefly per cwd.
 */
let cache: { cwd: string; at: number; map: Map<string, string> } | null = null;
export function resolveTranscript(cwd: string, session: string, sessions: { session: string; start: number }[], now: number): string | null {
  if (!cache || cache.cwd !== cwd || now - cache.at > 15000) {
    cache = { cwd, at: now, map: assign(cwd, sessions) };
  }
  return cache.map.get(session) ?? findClaudeTranscript(cwd);
}

function assign(cwd: string, sessions: { session: string; start: number }[]): Map<string, string> {
  const dir = join(CLAUDE_PROJECTS, claudeSlug(cwd));
  const map = new Map<string, string>();
  if (!existsSync(dir) || sessions.length === 0) return map;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .map((f) => ({ f, m: statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, Math.max(sessions.length + 3, 8))
    .map((x) => x.f);
  const times = new Map(files.map((f) => [f, eventTimes(f)] as const));
  const pairs: { d: number; s: string; f: string }[] = [];
  for (const { session, start } of sessions) {
    for (const f of files) {
      const ts = times.get(f)!;
      if (!ts.length) continue;
      let d = Infinity;
      for (const t of ts) d = Math.min(d, Math.abs(t - start));
      pairs.push({ d, s: session, f });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const usedF = new Set<string>();
  for (const { s, f } of pairs) {
    if (map.has(s) || usedF.has(f)) continue;
    map.set(s, f);
    usedF.add(f);
  }
  return map;
}

/** Normalize one Claude JSONL line into a chat event (or null to skip). */
export function parseClaudeLine(line: string): ChatEvent | null {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  // Queued messages are persisted as queue-operation/enqueue (often the ONLY
  // record — Claude doesn't always write a user event for them). Render them as
  // user messages so they appear in the chat. (Dedup vs any user event is in
  // the tailer.)
  if (o.type === 'queue-operation') {
    if (o.operation === 'enqueue' && typeof o.content === 'string' && o.content.trim()) {
      return { role: 'user', blocks: [{ kind: 'text', text: o.content }], ts: o.timestamp };
    }
    return null;
  }
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  const content = o.message?.content;
  const blocks: ChatBlock[] = [];
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'text') blocks.push({ kind: 'text', text: b.text });
      else if (b.type === 'thinking') blocks.push({ kind: 'thinking', text: b.thinking });
      else if (b.type === 'image') { const u = imageUri(b.source); if (u) blocks.push({ kind: 'image', image: u }); }
      else if (b.type === 'tool_use') blocks.push({ kind: 'tool_use', tool: b.name, input: b.input });
      else if (b.type === 'tool_result') {
        const c = b.content;
        let text = '';
        const imgs: string[] = [];
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          for (const x of c) {
            if (typeof x === 'string') text += x;
            else if (x?.type === 'text') text += x.text ?? '';
            else if (x?.type === 'image') { const u = imageUri(x.source); if (u) imgs.push(u); }
          }
        }
        blocks.push({ kind: 'tool_result', result: text, isError: !!b.is_error });
        for (const u of imgs) blocks.push({ kind: 'image', image: u }); // images from Read etc.
      }
    }
  }
  if (blocks.length === 0) return null;
  return { role: o.type, blocks, ts: o.timestamp, uuid: o.uuid, cwd: o.cwd };
}

export type LineParser = (line: string) => ChatEvent | null;

// ── Codex (OpenAI Codex CLI) ────────────────────────────────────────────────
// Rollout JSONL: {timestamp, type, payload}. Clean text comes from event_msg
// (user_message/agent_message); tool calls from response_item function/custom
// tool calls + outputs. (Reasoning is encrypted, so it's skipped.)
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');

export function parseCodexLine(line: string): ChatEvent | null {
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  const p = o.payload;
  if (!p) return null;
  const ts = o.timestamp;
  if (o.type === 'event_msg') {
    if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) return { role: 'user', blocks: [{ kind: 'text', text: p.message }], ts };
    if (p.type === 'agent_message' && typeof p.message === 'string' && p.message.trim()) return { role: 'assistant', blocks: [{ kind: 'text', text: p.message }], ts };
    return null;
  }
  if (o.type === 'response_item') {
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input: unknown = p.input;
      if (p.type === 'function_call') { try { input = JSON.parse(p.arguments); } catch { input = p.arguments; } }
      return { role: 'assistant', blocks: [{ kind: 'tool_use', tool: p.name, input }], ts };
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      return { role: 'user', blocks: [{ kind: 'tool_result', result: out }], ts };
    }
    return null;
  }
  return null;
}

/** Most-recent rollout files (newest first), across the date-partitioned tree. */
function recentRollouts(limit = 40): string[] {
  if (!existsSync(CODEX_SESSIONS)) return [];
  const out: string[] = [];
  const desc = (d: string) => { try { return readdirSync(d).sort().reverse(); } catch { return []; } };
  for (const y of desc(CODEX_SESSIONS)) {
    for (const m of desc(join(CODEX_SESSIONS, y))) {
      for (const day of desc(join(CODEX_SESSIONS, y, m))) {
        const dp = join(CODEX_SESSIONS, y, m, day);
        for (const f of desc(dp)) if (f.endsWith('.jsonl')) { out.push(join(dp, f)); if (out.length >= limit) return out; }
      }
    }
  }
  return out;
}

const codexCwd = (file: string): string | null => {
  try {
    // read just the first line (session_meta can be tens of KB)
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(131072);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const chunk = buf.toString('utf8', 0, n);
    const nl = chunk.indexOf('\n');
    const o = JSON.parse(nl >= 0 ? chunk.slice(0, nl) : chunk);
    return o?.type === 'session_meta' ? (o.payload?.cwd ?? null) : null;
  } catch { return null; }
};

/** Active Codex rollout for a cwd: newest-modified rollout whose meta cwd matches. */
export function findCodexTranscript(cwd: string): string | null {
  const files = recentRollouts(40)
    .map((f) => { try { return { f, m: statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean as any as (x: any) => x is { f: string; m: number })
    .sort((a, b) => b.m - a.m);
  for (const { f } of files) if (codexCwd(f) === cwd) return f;
  return null;
}

/**
 * Tails a transcript file: parses the whole thing up front, then polls for
 * appended lines. New subscribers get the full history, then live events.
 */
export class TranscriptTailer {
  private events: ChatEvent[] = [];
  private subs = new Set<(e: ChatEvent[]) => void>();
  private offset = 0;
  private partial = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenUser = new Set<string>(); // dedup a message that is both enqueue + user

  constructor(private file: string, private parse: LineParser = parseClaudeLine, private dedup = true) {}

  start(): void {
    this.readNew();
    this.timer = setInterval(() => this.readNew(), 250);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subs.clear();
  }

  /** Subscribe; immediately receive the full history, then live batches. */
  subscribe(fn: (e: ChatEvent[]) => void): () => void {
    this.subs.add(fn);
    if (this.events.length) fn(this.events.slice());
    return () => this.subs.delete(fn);
  }

  get subscriberCount(): number {
    return this.subs.size;
  }

  private readNew(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.offset) { this.offset = 0; this.partial = ''; } // rotated
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
    this.partial += buf.toString('utf8');
    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    const fresh: ChatEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = this.parse(line);
      if (!ev) continue;
      if (this.dedup && ev.role === 'user') {
        // a queued message can appear as both enqueue and user — show it once
        const key = ev.blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('').replace(/\s+/g, ' ').trim();
        if (key) {
          if (this.seenUser.has(key)) continue;
          this.seenUser.add(key);
        }
      }
      fresh.push(ev);
    }
    if (fresh.length === 0) return;
    this.events.push(...fresh);
    for (const fn of this.subs) fn(fresh);
  }
}
