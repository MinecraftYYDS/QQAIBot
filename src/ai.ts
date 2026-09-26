import OpenAI from 'openai';
import { createLogger } from './logger.js';

const log = createLogger('ai');

export interface AiCallOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  maxRetries: number;
}

export interface AiResult {
  content: string;
  /** Provider finish reason, e.g. `stop` or `length` (length = 被 max_tokens 截断). */
  finishReason: string;
  /** Length of `reasoning_content`, when the provider returns one. */
  reasoningChars: number;
  promptTokens: number;
  completionTokens: number;
}

type ClientKey = string;

export class AiClient {
  private readonly clients = new Map<ClientKey, OpenAI>();

  private clientFor(baseUrl: string, apiKey: string, timeoutMs: number): OpenAI {
    const key = `${baseUrl}|${apiKey}|${timeoutMs}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new OpenAI({
        baseURL: baseUrl || undefined,
        apiKey: apiKey || 'not-needed',
        timeout: timeoutMs,
        maxRetries: 0, // we retry ourselves so we can log
      });
      this.clients.set(key, client);
    }
    return client;
  }

  async complete(opts: AiCallOptions): Promise<AiResult> {
    if (!opts.model) throw new Error('chat/vision model 未配置');
    if (!opts.baseUrl) throw new Error('chat/vision baseUrl 未配置');

    const client = this.clientFor(opts.baseUrl, opts.apiKey, opts.timeoutMs);
    const attempts = Math.max(1, opts.maxRetries + 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await client.chat.completions.create({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
        });
        const choice = res.choices?.[0];
        return {
          content: extractContent(choice?.message?.content),
          finishReason: String(choice?.finish_reason ?? ''),
          reasoningChars: reasoningLength(choice?.message),
          promptTokens: Number(res.usage?.prompt_tokens ?? 0),
          completionTokens: Number(res.usage?.completion_tokens ?? 0),
        };
      } catch (e) {
        lastError = e;
        const retriable = isRetriable(e);
        if (attempt >= attempts || !retriable) break;
        const delay = 400 * attempt;
        log.warn('chat call failed (attempt %d/%d), retrying in %dms: %s', attempt, attempts, delay, describe(e));
        await sleep(delay);
      }
    }
    // A 401 with no key configured is almost always "you forgot to fill it in",
    // which is worth saying plainly instead of echoing the provider's wording.
    if (!opts.apiKey && isAuthError(lastError)) {
      throw new Error('未配置 API Key，请在管理面板「模型与密钥」里填写后保存');
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text ?? '');
        return '';
      })
      .join('');
  }
  return '';
}

function reasoningLength(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const raw = (message as Record<string, unknown>).reasoning_content;
  return typeof raw === 'string' ? raw.length : 0;
}

function isRetriable(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500;
  const code = (error as { code?: string })?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  return false;
}

function isAuthError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === 401 || status === 403;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    return status ? `${error.message} (status ${status})` : error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
