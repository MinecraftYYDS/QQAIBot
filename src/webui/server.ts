import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { saveConfig } from '../config.js';
import type { Database } from '../db.js';
import { createLogger, readLogTail } from '../logger.js';
import { publicDir } from '../paths.js';
import type { SettingsStore } from '../settings.js';
import type { QqAiBot } from '../bot.js';
import type { Scope } from '../types.js';

const log = createLogger('webui');

export interface WebUiDeps {
  config: AppConfig;
  db: Database;
  settings: SettingsStore;
  bot: QqAiBot;
  onConfigSaved: (config: AppConfig) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export function startWebUi(deps: WebUiDeps): http.Server {
  const { config } = deps;
  const server = http.createServer((req, res) => {
    handle(req, res, deps).catch((e) => {
      log.error('request failed: %s', (e as Error).message);
      sendJson(res, 500, { error: (e as Error).message });
    });
  });

  server.on('error', (e) => log.error('webui error: %s', (e as Error).message));
  server.listen(config.webui.port, config.webui.host, () => {
    log.info('webui on http://%s:%d', config.webui.host, config.webui.port);
  });
  return server;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: WebUiDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;

  if (pathname.startsWith('/api/')) {
    if (!authorized(req, url, deps.settings.base)) {
      sendJson(res, 401, { error: '未授权' });
      return;
    }
    await handleApi(req, res, url, deps);
    return;
  }
  serveStatic(res, pathname);
}

function authorized(req: http.IncomingMessage, url: URL, config: AppConfig): boolean {
  const pwd = config.webui.password;
  if (!pwd) return true;
  const given = req.headers['x-webui-password'] ?? url.searchParams.get('pwd');
  return given === pwd;
}

// ------------------------------------------------------------------------- API

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  deps: WebUiDeps,
): Promise<void> {
  const method = req.method ?? 'GET';
  const route = url.pathname.replace(/^\/api\//, '');

  if (method === 'GET' && route === 'overview') return sendJson(res, 200, overview(deps));
  if (method === 'GET' && route === 'scopes') return sendJson(res, 200, scopes(deps));
  if (method === 'PUT' && route === 'scopes') {
    const body = await readJson(req);
    const scope = String(body.scope ?? '');
    if (!scope) return sendJson(res, 400, { error: 'scope 不能为空' });
    deps.db.setScopeSettings(scope, {
      enabled: toBoolOrNull(body.enabled),
      visionEnabled: toBoolOrNull(body.visionEnabled),
      systemPrompt: toStringOrNull(body.systemPrompt),
    });
    return sendJson(res, 200, scopes(deps));
  }
  if (method === 'DELETE' && route === 'scopes') {
    const scope = url.searchParams.get('scope');
    if (!scope) return sendJson(res, 400, { error: 'scope 不能为空' });
    deps.db.clearScope(scope);
    return sendJson(res, 200, scopes(deps));
  }
  if (method === 'GET' && route === 'settings') return sendJson(res, 200, settingsView(deps));
  if (method === 'PUT' && route === 'overrides') {
    const body = await readJson(req);
    deps.settings.applyGlobalOverrides(normalizeOverrides(body));
    return sendJson(res, 200, settingsView(deps));
  }
  if (method === 'PUT' && route === 'config') {
    const body = await readJson(req);
    const merged = mergeConfig(deps, body);
    saveConfig(merged);
    deps.onConfigSaved(merged);
    return sendJson(res, 200, settingsView(deps));
  }
  if (method === 'POST' && route === 'test-chat') {
    const body = await readJson(req);
    const text = String(body.text ?? '').trim();
    if (!text) return sendJson(res, 400, { error: '请输入内容' });
    const scope = (typeof body.scope === 'string' && body.scope) || 'private:0';
    try {
      const reply = await deps.bot.testChat(text, scope as Scope);
      return sendJson(res, 200, { reply });
    } catch (e) {
      return sendJson(res, 200, { error: (e as Error).message });
    }
  }
  if (method === 'GET' && route === 'usage') {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 14)));
    return sendJson(res, 200, {
      days: deps.db.usageByDay(days),
      models: deps.db.usageByModel(days),
      today: deps.db.usageToday(),
    });
  }
  if (method === 'GET' && route === 'logs') {
    const tail = Math.max(1, Math.min(5000, Number(url.searchParams.get('tail') ?? 300)));
    return sendJson(res, 200, { lines: readLogTail(tail) });
  }
  if (method === 'GET' && route === 'scopes/detail') {
    const scope = url.searchParams.get('scope') ?? '';
    const messages = deps.db.getHistory(scope, 50);
    return sendJson(res, 200, { messages });
  }

  sendJson(res, 404, { error: `未知接口 ${method} /api/${route}` });
}

// ------------------------------------------------------------------- payloads

function overview(deps: WebUiDeps) {
  const status = deps.bot.status;
  const sample = deps.settings.resolve('private:0' as Scope);
  const scopes = deps.db.listScopes();
  return {
    connected: status.connected,
    selfId: status.selfId,
    botName: status.botName,
    uptimeSec: Math.floor((Date.now() - status.startedAt) / 1000),
    lastEventAt: status.lastEventAt,
    wsUrl: deps.settings.base.snowluma.wsUrl,
    today: deps.db.usageToday(),
    scopeCount: scopes.length,
    messageCount: scopes.reduce((n, s) => n + s.count, 0),
    models: {
      chat: { model: sample.chat.model, baseUrl: sample.chat.baseUrl },
      vision: { model: sample.vision.model, baseUrl: sample.vision.baseUrl, enabled: sample.visionEnabled },
      historyImagesMode: sample.historyImagesMode,
    },
  };
}

function scopes(deps: WebUiDeps) {
  const counts = new Map(deps.db.listScopes().map((s) => [s.scope, s]));
  const stored = new Map(deps.db.allScopeSettings().map((s) => [s.scope, s]));
  const names = new Set<string>([...counts.keys(), ...stored.keys()]);
  return {
    scopes: [...names].map((scope) => {
      const row = counts.get(scope);
      const saved = stored.get(scope);
      const resolved = deps.settings.resolve(scope as Scope);
      return {
        scope,
        count: row?.count ?? 0,
        lastAt: row?.lastAt ?? null,
        enabled: saved?.enabled ?? null,
        visionEnabled: saved?.visionEnabled ?? null,
        systemPrompt: saved?.systemPrompt ?? null,
        effectiveVision: resolved.visionEnabled,
        effectiveSystemPrompt: resolved.systemPrompt,
      };
    }),
  };
}

function settingsView(deps: WebUiDeps) {
  const c = deps.settings.base;
  const sample = deps.settings.resolve('private:0' as Scope);
  return {
    base: {
      snowluma: { wsUrl: c.snowluma.wsUrl, accessToken: mask(c.snowluma.accessToken) },
      chat: {
        baseUrl: c.chat.baseUrl,
        apiKey: mask(c.chat.apiKey),
        model: c.chat.model,
        temperature: c.chat.temperature,
        maxTokens: c.chat.maxTokens,
        systemPrompt: c.chat.systemPrompt,
      },
      vision: {
        baseUrl: c.vision.baseUrl,
        apiKey: mask(c.vision.apiKey),
        model: c.vision.model,
        enabled: c.vision.enabled,
      },
      historyImages: { mode: c.historyImages.mode },
      reply: {
        maxCharsPerMessage: c.reply.maxCharsPerMessage,
        quoteOnGroup: c.reply.quoteOnGroup,
        stripMarkdown: c.reply.stripMarkdown,
        emojiReaction: c.reply.emojiReaction,
      },
      context: {
        recordAll: c.context.recordAll,
        recordImages: c.context.recordImages,
        maxTurns: c.context.maxTurns,
        maxContextChars: c.context.maxContextChars,
        includeTimestamps: c.context.includeTimestamps,
      },
    },
    overrides: maskOverrides(deps.db.allAppSettings()),
    effective: {
      historyImagesMode: sample.historyImagesMode,
      visionEnabled: sample.visionEnabled,
      systemPrompt: sample.systemPrompt,
      chat: { baseUrl: sample.chat.baseUrl, model: sample.chat.model, apiKey: mask(sample.chat.apiKey) },
      vision: { baseUrl: sample.vision.baseUrl, model: sample.vision.model, apiKey: mask(sample.vision.apiKey) },
    },
  };
}

function normalizeOverrides(body: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const source = (body.overrides ?? body) as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(source)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value as string | number | boolean;
    } else if (value === null) {
      out[key] = null;
    }
  }
  return out;
}

function mergeConfig(deps: WebUiDeps, body: Record<string, unknown>): AppConfig {
  const next = structuredClone(deps.settings.base);
  const snowluma = body.snowluma as Record<string, unknown> | undefined;
  if (snowluma) {
    if (typeof snowluma.wsUrl === 'string' && snowluma.wsUrl) next.snowluma.wsUrl = snowluma.wsUrl;
    if (typeof snowluma.accessToken === 'string' && !snowluma.accessToken.includes('***')) {
      next.snowluma.accessToken = snowluma.accessToken;
    }
  }
  const chat = body.chat as Record<string, unknown> | undefined;
  if (chat) {
    applyString(chat, next.chat, 'baseUrl');
    applyString(chat, next.chat, 'model');
    applySecret(chat, next.chat, 'apiKey');
    if (typeof chat.systemPrompt === 'string' && chat.systemPrompt.trim()) {
      next.chat.systemPrompt = chat.systemPrompt;
    }
  }
  const vision = body.vision as Record<string, unknown> | undefined;
  if (vision) {
    applyString(vision, next.vision, 'baseUrl');
    applyString(vision, next.vision, 'model');
    applySecret(vision, next.vision, 'apiKey');
    if (typeof vision.enabled === 'boolean') next.vision.enabled = vision.enabled;
  }
  return next;
}

function applyString(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
  if (typeof from[key] === 'string') to[key] = from[key];
}

function applySecret(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
  const value = from[key];
  if (typeof value === 'string' && value && !value.includes('***')) to[key] = value;
}

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

const SECRET_KEYS = new Set(['chat.apiKey', 'vision.apiKey']);

function maskOverrides(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    out[key] = SECRET_KEYS.has(key) && value ? mask(value) : value;
  }
  return out;
}

// -------------------------------------------------------------------- helpers

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toBoolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(publicDir, rel);
  if (!resolved.startsWith(path.resolve(publicDir))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(resolved).pipe(res);
}
