// Read & tail a coding agent's own session transcript (its source-of-truth log)
// and normalize it into chat events, so the web UI can render a clean
// conversation without scraping the terminal. Claude Code first.
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ChatBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  tool?: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
}
export interface ChatEvent {
  role: 'user' | 'assistant';
  blocks: ChatBlock[];
  ts?: string;
  uuid?: string;
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
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  const content = o.message?.content;
  const blocks: ChatBlock[] = [];
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'text') blocks.push({ kind: 'text', text: b.text });
      else if (b.type === 'thinking') blocks.push({ kind: 'thinking', text: b.thinking });
      else if (b.type === 'tool_use') blocks.push({ kind: 'tool_use', tool: b.name, input: b.input });
      else if (b.type === 'tool_result') {
        const c = b.content;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).join('')
            : '';
        blocks.push({ kind: 'tool_result', result: text, isError: !!b.is_error });
      }
    }
  }
  if (blocks.length === 0) return null;
  return { role: o.type, blocks, ts: o.timestamp, uuid: o.uuid };
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

  constructor(private file: string) {}

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
      const ev = parseClaudeLine(line);
      if (ev) fresh.push(ev);
    }
    if (fresh.length === 0) return;
    this.events.push(...fresh);
    for (const fn of this.subs) fn(fresh);
  }
}
