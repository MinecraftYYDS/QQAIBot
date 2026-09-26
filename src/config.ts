import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { configFile, exampleConfigFile } from './paths.js';

const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape);

export const ConfigSchema = obj({
  snowluma: obj({
    wsUrl: z.string().default('ws://127.0.0.1:3001/'),
    accessToken: z.string().default(''),
    reconnect: z.boolean().default(true),
    requestTimeoutMs: z.number().int().positive().default(30_000),
  }).default({}),
  prompt: obj({
    includeContext: z.boolean().default(true),
    timezone: z.string().default('Asia/Shanghai'),
  }).default({}),
  chat: obj({
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default(''),
    systemPrompt: z
      .string()
      .default('你是一个友好的群聊助手，说话简短、口语化，不暴露自己是 AI。'),
    temperature: z.number().min(0).max(2).default(0.8),
    maxTokens: z.number().int().positive().default(1024),
  }).default({}),
  vision: obj({
    enabled: z.boolean().default(true),
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default(''),
    maxBytes: z.number().int().positive().default(5 * 1024 * 1024),
    maxImagesPerRequest: z.number().int().positive().default(4),
  }).default({}),
  historyImages: obj({
    mode: z.enum(['none', 'latest', 'caption']).default('latest'),
    maxImages: z.number().int().min(0).default(4),
    captionPrompt: z
      .string()
      .default('用一两句话客观描述这张图片的内容，不要推测用户意图。'),
    captionMaxTokens: z.number().int().positive().default(120),
    captionModel: z.string().default(''),
  }).default({}),
  quote: obj({
    enabled: z.boolean().default(true),
    resolve: z.boolean().default(true),
    maxChars: z.number().int().positive().default(500),
    includeText: z.boolean().default(true),
    includeImage: z.boolean().default(true),
  }).default({}),
  mentions: obj({
    resolveNames: z.boolean().default(true),
    memberCacheTtlMs: z.number().int().positive().default(600_000),
  }).default({}),
  voice: obj({
    transcribe: z.boolean().default(true),
  }).default({}),
  context: obj({
    // 记录群里的全部消息作为上下文（机器人仍然只在被 @ 时回复）
    recordAll: z.boolean().default(true),
    // 被动消息里的图片是否也下载保存，之后按「文字 / 图片」原顺序送给多模态模型
    recordImages: z.boolean().default(true),
    // 每个会话保留最近多少轮（一轮 ≈ 2 条消息）
    maxTurns: z.number().int().min(1).default(20),
    maxContextChars: z.number().int().positive().default(12_000),
    includeTimestamps: z.boolean().default(false),
  }).default({}),
  trigger: obj({
    replyOnEmptyMention: z.boolean().default(false),
    emptyReplyText: z.string().default('嗯？'),
    groups: z.array(z.number().int()).default([]),
    privateUsers: z.array(z.number().int()).default([]),
  }).default({}),
  reply: obj({
    maxCharsPerMessage: z.number().int().positive().default(1500),
    quoteOnGroup: z.boolean().default(true),
    stripMarkdown: z.boolean().default(true),
    emptyFallback: z.string().default(''),
    errorReply: z.string().default(''),
    // 群里被 @ 时给那条消息贴个表情回应（QQ emoji id，留空 = 关闭）
    emojiReaction: z.string().default('424'),
  }).default({}),
  ai: obj({
    timeoutMs: z.number().int().positive().default(60_000),
    maxRetries: z.number().int().min(0).default(1),
  }).default({}),
  limits: obj({
    perUserCooldownMs: z.number().int().min(0).default(2000),
    busyStrategy: z.enum(['queue', 'drop', 'ignore']).default('queue'),
    maxQueuePerScope: z.number().int().positive().default(5),
  }).default({}),
  webui: obj({
    enabled: z.boolean().default(true),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8787),
    password: z.string().default(''),
  }).default({}),
  logging: obj({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    keepDays: z.number().int().positive().default(7),
    console: z.boolean().default(true),
  }).default({}),
  media: obj({
    keepDays: z.number().int().positive().default(3),
  }).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function substituteEnv(raw: string): string {
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
}

/**
 * YAML turns `key: ${MISSING}` into `key: null`; drop those so the schema
 * defaults apply instead of failing validation.
 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = dropNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Keeps older config.yaml files working after a rename. It only fills gaps, so
 * a value the user already set is never overwritten.
 */
function migrateLegacy(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const root = { ...(input as Record<string, unknown>) };

  const rawContext = root.context;
  if (rawContext && typeof rawContext === 'object') {
    const context = { ...(rawContext as Record<string, unknown>) };
    // Renamed on 2026-09: maxMessages (条数) -> maxTurns (轮次).
    if (context.maxTurns === undefined && context.maxMessages !== undefined) {
      const n = Number(context.maxMessages);
      if (Number.isFinite(n)) context.maxTurns = Math.max(1, Math.round(n / 2));
    }
    delete context.maxMessages;
    root.context = context;
  }
  return root;
}

/** Creates config.yaml from the example when the user has none yet. */
export function ensureConfigFile(): boolean {
  if (fs.existsSync(configFile)) return false;
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    if (fs.existsSync(exampleConfigFile)) {
      fs.copyFileSync(exampleConfigFile, configFile);
    } else {
      fs.writeFileSync(configFile, DEFAULT_CONFIG_YAML, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

export interface LoadedConfig {
  config: AppConfig;
  created: boolean;
}

export function loadConfig(): LoadedConfig {
  const created = ensureConfigFile();
  const text = fs.readFileSync(configFile, 'utf8');
  const parsed = parseYaml(substituteEnv(text)) ?? {};
  const config = ConfigSchema.parse(migrateLegacy(dropNulls(parsed)));
  return { config, created };
}

export function saveConfig(config: AppConfig): void {
  const tmp = `${configFile}.tmp`;
  fs.writeFileSync(tmp, stringifyYaml(config, { lineWidth: 120 }), 'utf8');
  fs.renameSync(tmp, configFile);
}

export const DEFAULT_CONFIG_YAML = `# qqaibot 配置文件
# 字符串里的 \${VAR} 会从 .env / 环境变量取值。
snowluma:
  wsUrl: ws://127.0.0.1:3001/
  accessToken: ""
  reconnect: true
`;
