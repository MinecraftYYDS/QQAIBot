import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from './paths.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LoggerOptions {
  level: LogLevel;
  keepDays: number;
  console: boolean;
}

let options: LoggerOptions = { level: 'info', keepDays: 7, console: true };
let stream: fs.WriteStream | null = null;
let streamDay = '';

export function configureLogger(next: Partial<LoggerOptions>): void {
  options = { ...options, ...next };
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function currentStream(): fs.WriteStream | null {
  const day = dayKey();
  if (stream && streamDay === day) return stream;
  if (stream) {
    stream.end();
    stream = null;
  }
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    stream = fs.createWriteStream(path.join(logsDir, `bot-${day}.log`), { flags: 'a' });
    streamDay = day;
    pruneOldLogs();
  } catch {
    stream = null;
  }
  return stream;
}

function pruneOldLogs(): void {
  try {
    const cutoff = Date.now() - options.keepDays * 86_400_000;
    for (const name of fs.readdirSync(logsDir)) {
      if (!/^bot-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = path.join(logsDir, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  } catch {
    /* best effort */
  }
}

export function logFilePath(d = new Date()): string {
  return path.join(logsDir, `bot-${dayKey(d)}.log`);
}

function formatArgs(format: string, args: unknown[]): string {
  if (args.length === 0) return format;
  let i = 0;
  const rendered = format.replace(/%[sdjo%]/g, (token) => {
    if (token === '%%') return '%';
    if (i >= args.length) return token;
    const value = args[i++];
    switch (token) {
      case '%d':
        return String(Number(value));
      case '%j':
      case '%o':
        return safeJson(value);
      default:
        return typeof value === 'string' ? value : safeJson(value);
    }
  });
  const rest = args.slice(i).map((v) => (typeof v === 'string' ? v : safeJson(v)));
  return rest.length ? `${rendered} ${rest.join(' ')}` : rendered;
}

function write(level: LogLevel, scope: string, message: string, extra: unknown[]): void {
  if (ORDER[level] < ORDER[options.level]) return;
  const time = new Date().toISOString();
  const line = `${time} [${level.toUpperCase()}] [${scope}] ${formatArgs(message, extra)}`;
  if (options.console) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(line);
  }
  const s = currentStream();
  if (s) s.write(line + '\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, ...e) => write('debug', scope, m, e),
    info: (m, ...e) => write('info', scope, m, e),
    warn: (m, ...e) => write('warn', scope, m, e),
    error: (m, ...e) => write('error', scope, m, e),
  };
}

/** Reads the tail of today's (and yesterday's) log file for the WebUI. */
export function readLogTail(lines: number): string[] {
  const out: string[] = [];
  const days = [new Date(), new Date(Date.now() - 86_400_000)];
  for (const d of days.reverse()) {
    const file = logFilePath(d);
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      out.push(...content.split(/\r?\n/).filter(Boolean));
    } catch {
      /* ignore */
    }
  }
  return out.slice(-Math.max(1, lines));
}
