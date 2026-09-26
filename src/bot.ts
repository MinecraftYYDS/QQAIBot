import {
  SnowLumaWebSocketClient,
  type OneBotGroupMessageEvent,
  type OneBotMessageEvent,
  type OneBotPrivateMessageEvent,
  type SnowLumaEvent,
} from '@snowluma/sdk';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { AiClient, type AiResult } from './ai.js';
import { createLogger } from './logger.js';
import { MentionResolver } from './mentions.js';
import {
  fetchAndStoreImage,
  pruneMediaFiles,
  readAsDataUrl,
  toDataUrl,
  type FetchedImage,
} from './media.js';
import { hasContent, mentionedSelf, normalizeMessage, partsToText } from './normalize.js';
import { buildPrompt, type ResolvedImage } from './prompt.js';
import { SettingsStore } from './settings.js';
import { splitChunks, stripMarkdown } from './text.js';
import type { ChatKind, NormalizedPart, Scope } from './types.js';

const log = createLogger('bot');

export interface BotStatus {
  connected: boolean;
  selfId: number | null;
  botName: string | null;
  startedAt: number;
  lastEventAt: number | null;
}

interface ResolvedEntry {
  ref: { file: string; url?: string };
  dataUrl: string | null;
  fetched: FetchedImage | null;
}

/** Serialises work per conversation and optionally drops when busy. */
class ScopeQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depth = new Map<string, number>();

  enqueue(
    scope: string,
    maxDepth: number,
    strategy: 'queue' | 'drop' | 'ignore',
    task: () => Promise<void>,
    onDrop?: () => void,
  ): void {
    if (!this.tails.has(scope)) this.tails.set(scope, Promise.resolve());
    const depth = this.depth.get(scope) ?? 0;
    if (depth >= maxDepth || (strategy !== 'queue' && depth > 0)) {
      onDrop?.();
      return;
    }
    this.depth.set(scope, depth + 1);
    const next = (this.tails.get(scope) as Promise<void>)
      .then(task)
      .catch((e) => log.error('scope task failed: %s', (e as Error).message))
      .finally(() => {
        this.depth.set(scope, Math.max(0, (this.depth.get(scope) ?? 1) - 1));
      });
    this.tails.set(scope, next);
  }

  /**
   * Chains work onto the same tail without a depth limit. Used for passive
   * context recording, which is cheap and must never be dropped mid-burst.
   */
  enqueueChain(scope: string, task: () => Promise<void>): void {
    if (!this.tails.has(scope)) this.tails.set(scope, Promise.resolve());
    const next = (this.tails.get(scope) as Promise<void>)
      .then(task)
      .catch((e) => log.error('scope task failed: %s', (e as Error).message));
    this.tails.set(scope, next);
  }
}

export class QqAiBot {
  private readonly client: SnowLumaWebSocketClient;
  private readonly queue = new ScopeQueue();
  private readonly ai = new AiClient();
  private readonly mentions: MentionResolver;
  private readonly cooldowns = new Map<string, number>();
  private readonly seen = new Set<number>();
  private readonly groupNames = new Map<number, string>();
  private readonly captioning = new Set<string>();
  private readonly startedAt = Date.now();
  private stopping = false;
  private selfId: number | null = null;
  private botName: string | null = null;
  private lastEventAt: number | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly settings: SettingsStore,
  ) {
    this.client = new SnowLumaWebSocketClient({
      url: config.snowluma.wsUrl,
      accessToken: config.snowluma.accessToken || undefined,
      requestTimeoutMs: config.snowluma.requestTimeoutMs,
      // We run our own reconnect loop so we can log and back off predictably.
      reconnect: false,
    });
    this.mentions = new MentionResolver(this.client, config.mentions.memberCacheTtlMs);
  }

  get status(): BotStatus {
    return {
      connected: this.client.isConnected,
      selfId: this.selfId,
      botName: this.botName,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
    };
  }

  async start(): Promise<void> {
    this.client.onMessage((event) => this.onMessage(event));
    this.client.on('open', () => log.info('websocket open (%s)', this.config.snowluma.wsUrl));
    this.client.on('close', (info) =>
      log.debug('websocket closed (code=%s reason=%s)', info.code ?? '-', info.reason ?? '-'),
    );
    this.client.on('error', (err) =>
      log.debug('websocket error: %s', (err as Error)?.message ?? String(err)),
    );

    this.maintenanceTimer = setInterval(() => this.maintenance(), 6 * 60 * 60 * 1000);

    void this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.client.close();
  }

  /** Runs a one-off chat completion without touching memory (used by the WebUI). */
  async testChat(text: string, scope: Scope): Promise<string> {
    const resolved = this.settings.resolve(scope);
    const model = resolved.chat.model;
    const result = await this.ai.complete({
      baseUrl: resolved.chat.baseUrl,
      apiKey: resolved.chat.apiKey,
      model,
      messages: [
        { role: 'system', content: resolved.systemPrompt },
        { role: 'user', content: text },
      ],
      temperature: resolved.chat.temperature,
      maxTokens: resolved.chat.maxTokens,
      timeoutMs: this.config.ai.timeoutMs,
      maxRetries: 0,
    });
    return result.content;
  }

  async previewVision(imagePath: string, question: string, scope: Scope): Promise<string> {
    const resolved = this.settings.resolve(scope);
    const dataUrl = await readAsDataUrl(imagePath, guessMime(imagePath));
    if (!dataUrl) throw new Error('图片读取失败');
    const result = await this.ai.complete({
      baseUrl: resolved.vision.baseUrl,
      apiKey: resolved.vision.apiKey,
      model: resolved.vision.model,
      messages: [
        { role: 'system', content: resolved.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: question || '描述这张图片' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: resolved.chat.temperature,
      maxTokens: resolved.chat.maxTokens,
      timeoutMs: this.config.ai.timeoutMs,
      maxRetries: 0,
    });
    return result.content;
  }

  // ------------------------------------------------------------------ connect

  private async connectLoop(): Promise<void> {
    let delay = 1500;
    while (!this.stopping) {
      try {
        await this.client.connect();
        const info = await this.client.getLoginInfo();
        this.selfId = Number(info.user_id ?? 0) || null;
        this.botName = String(info.nickname ?? '') || null;
        log.info('connected as %s (%d)', this.botName ?? '?', this.selfId ?? 0);
        await this.maintenance();
        delay = 1500;
        await this.waitUntilDisconnected();
        if (this.stopping) break;
        if (!this.config.snowluma.reconnect) {
          log.warn('连接已断开（未开启自动重连）');
          break;
        }
        log.warn('连接已断开，%dms 后重连', delay);
      } catch (e) {
        if (this.stopping) break;
        if (!this.config.snowluma.reconnect) {
          log.error('连接失败：%s', (e as Error).message);
          break;
        }
        log.warn('连接失败：%s，%dms 后重试', (e as Error).message, delay);
      }
      await sleep(delay);
      delay = Math.min(Math.round(delay * 2), 30_000);
    }
  }

  /** Polls instead of listening for `close`, so we can never miss the event. */
  private async waitUntilDisconnected(): Promise<void> {
    while (!this.stopping && this.client.isConnected) {
      await sleep(1000);
    }
  }

  // ------------------------------------------------------------------- events

  private onMessage(event: OneBotMessageEvent): void {
    if (this.stopping) return;
    if (event.post_type !== 'message') return;
    if (!event.self_id && this.selfId) event.self_id = this.selfId;

    const selfId = Number(event.self_id ?? this.selfId ?? 0);
    if (selfId === 0) {
      log.warn('drop event without self_id');
      return;
    }
    this.selfId = selfId;

    const userId = Number(event.user_id);
    if (userId === selfId) return;

    const messageId = Number(event.message_id);
    log.debug(
      'event message_type=%s user=%d id=%d',
      event.message_type,
      userId,
      Number.isFinite(messageId) ? messageId : -1,
    );
    if (Number.isFinite(messageId)) {
      if (this.seen.has(messageId)) return;
      this.seen.add(messageId);
      if (this.seen.size > 2000) {
        const first = this.seen.values().next().value;
        if (first !== undefined) this.seen.delete(first);
      }
    }

    this.lastEventAt = Date.now();

    const isGroup = event.message_type === 'group';
    const groupId = isGroup ? Number((event as OneBotGroupMessageEvent).group_id) : undefined;
    const scope: Scope = isGroup ? (`group:${groupId}` as Scope) : (`private:${userId}` as Scope);

    // Whitelists decide whether a scope is handled at all.
    if (isGroup) {
      if (this.config.trigger.groups.length > 0 && !this.config.trigger.groups.includes(groupId as number)) {
        log.debug('群 %s 不在白名单内，忽略', scope);
        return;
      }
    } else if (
      this.config.trigger.privateUsers.length > 0 &&
      !this.config.trigger.privateUsers.includes(userId)
    ) {
      log.debug('用户 %s 不在白名单内，忽略', scope);
      return;
    }

    const resolved = this.settings.resolve(scope);
    if (!resolved.enabled) {
      log.debug('%s 已关闭（enabled=false），忽略', scope);
      return;
    }

    // In groups only a mention triggers a reply. Without a mention the message
    // is still stored as context when `context.recordAll` is on.
    const mentioned = isGroup ? mentionedSelf(event.message, event.raw_message, selfId) : true;
    if (!mentioned) {
      if (!resolved.recordAll) {
        log.debug('群 %s 未 @ 机器人且未开启全量记录，忽略', scope);
        return;
      }
      this.queue.enqueueChain(scope, () => this.recordPassive(event, scope, isGroup, groupId, selfId));
      return;
    }

    if (!this.passCooldown(scope, userId)) {
      log.info('冷却中，忽略 %s 的这次触发（间隔需 >= %dms）', scope, this.config.limits.perUserCooldownMs);
      return;
    }

    this.queue.enqueue(
      scope,
      this.config.limits.maxQueuePerScope,
      this.config.limits.busyStrategy,
      () => this.process(event, scope, isGroup, groupId, selfId),
      () => log.warn('同一会话任务繁忙，丢弃了一条触发消息：%s', scope),
    );
  }

  /**
   * Stores a group message that did not mention the bot, so it becomes part of
   * the conversation context. Never replies and never fails loudly.
   */
  private async recordPassive(
    event: OneBotMessageEvent,
    scope: Scope,
    isGroup: boolean,
    groupId: number | undefined,
    selfId: number,
  ): Promise<void> {
    const resolved = this.settings.resolve(scope);

    const normalized = await normalizeMessage(event.message, {
      selfId,
      isGroup,
      groupId,
      messageId: Number(event.message_id),
      mentions: this.mentions,
      // Passive recording stays cheap: no voice transcription, no quote lookup.
      transcribe: false,
    });

    const speaker = displayName(event);
    const text = partsToText(normalized.parts);
    if (!text && normalized.images.length === 0) return;

    const messageRowId = this.db.appendMessage({
      scope,
      role: 'user',
      speaker: isGroup ? speaker : null,
      content: text || '[图片]',
      hadImage: normalized.images.length > 0,
      hadQuote: false,
    });

    // Images are only downloaded when explicitly enabled. They are replayed to
    // the model in their original text/image order (no up-front captioning);
    // captions are only generated when the user picked `caption` mode.
    if (resolved.recordImages && normalized.images.length > 0) {
      const entries = await this.resolveImages(normalized.images, resolved);
      for (let i = 0; i < normalized.images.length; i++) {
        const entry = entries[i];
        if (!entry?.fetched) continue;
        this.db.addMedia({
          messageId: messageRowId,
          seq: i,
          filePath: entry.fetched.filePath,
          mime: entry.fetched.mime,
          bytes: entry.fetched.bytes.length,
          sha1: entry.fetched.sha1,
          caption: this.db.findCaption(entry.fetched.sha1),
        });
        if (resolved.historyImagesMode === 'caption' && resolved.visionEnabled) {
          this.scheduleCaption(entry.fetched, resolved, scope);
        }
      }
    }

    this.db.pruneScope(scope, resolved.maxTurns * 2);
    log.debug(
      'passive %s <- %s: %s',
      scope,
      speaker ?? String(event.user_id),
      (text || '[图片]').slice(0, 40),
    );
  }

  private passCooldown(scope: string, userId: number): boolean {
    const ms = this.config.limits.perUserCooldownMs;
    if (ms <= 0) return true;
    const key = `${scope}:${userId}`;
    const now = Date.now();
    const last = this.cooldowns.get(key) ?? 0;
    if (now - last < ms) return false;
    this.cooldowns.set(key, now);
    if (this.cooldowns.size > 5000) this.cooldowns.clear();
    return true;
  }

  // ---------------------------------------------------------------- processing

  /** Adds an emoji reaction to the triggering message (OneBot set_msg_emoji_like). */
  private async reactEmoji(event: OneBotMessageEvent, emojiId: string): Promise<void> {
    if (!emojiId) return;
    const messageId = Number(event.message_id);
    if (!Number.isFinite(messageId)) return;
    try {
      await this.client.setMsgEmojiLike(messageId, emojiId, true);
    } catch (e) {
      log.debug('emoji reaction failed: %s', (e as Error).message);
    }
  }

  private async process(
    event: OneBotMessageEvent,
    scope: Scope,
    isGroup: boolean,
    groupId: number | undefined,
    selfId: number,
  ): Promise<void> {
    const resolved = this.settings.resolve(scope);

    // React to the mention immediately so it feels instant.
    if (isGroup) void this.reactEmoji(event, resolved.emojiReaction);

    const normalized = await normalizeMessage(event.message, {
      selfId,
      isGroup,
      groupId,
      messageId: Number(event.message_id),
      mentions: this.mentions,
      transcribe: this.config.voice.transcribe,
      fetchPttText: (id) => this.fetchPttText(id),
      getMessage: (id) => this.client.getMessage(id),
    });

    log.debug(
      'normalized %s: parts=%d images=%d quote=%s',
      scope,
      normalized.parts.length,
      normalized.images.length,
      normalized.quote ? 'yes' : 'no',
    );

    const speaker = displayName(event);
    const userName = speaker ?? String(event.user_id);

    if (!hasContent(normalized.parts) && normalized.images.length === 0) {
      if (this.config.trigger.replyOnEmptyMention) {
        await this.sendReply(event, scope, isGroup, this.config.trigger.emptyReplyText, false);
      } else {
        log.info(
          '收到 %s 的空触发（只有 @ 或只有引用，没有文字/图片），replyOnEmptyMention=false，不回复',
          scope,
        );
      }
      return;
    }

    const currentEntries = await this.resolveImages(normalized.images, resolved);

    // Quote handling honours the `quote.*` switches.
    const quoteCfg = this.config.quote;
    const quoteSource = quoteCfg.enabled && quoteCfg.resolve ? normalized.quote : undefined;
    const quoteEntries =
      quoteSource && quoteCfg.includeImage
        ? await this.resolveImages(quoteSource.images, resolved)
        : [];

    const history = this.db.getHistory(scope, resolved.maxTurns * 2);
    const historyMedia = new Map<number, ReturnType<Database['getMediaForMessage']>>();
    for (const m of history) {
      if (m.hadImage) historyMedia.set(m.id, this.db.getMediaForMessage(m.id));
    }

    const userText = partsToText(normalized.parts) || '[图片]';
    const messageRowId = this.db.appendMessage({
      scope,
      role: 'user',
      speaker: isGroup ? speaker : null,
      content: userText,
      hadImage: normalized.images.length > 0,
      hadQuote: Boolean(normalized.quote),
    });

    const storedForCaption: FetchedImage[] = [];
    for (let i = 0; i < normalized.images.length; i++) {
      const entry = currentEntries[i];
      if (!entry?.fetched) continue;
      this.db.addMedia({
        messageId: messageRowId,
        seq: i,
        filePath: entry.fetched.filePath,
        mime: entry.fetched.mime,
        bytes: entry.fetched.bytes.length,
        sha1: entry.fetched.sha1,
        caption: this.db.findCaption(entry.fetched.sha1),
      });
      storedForCaption.push(entry.fetched);
    }

    this.db.pruneScope(scope, resolved.maxTurns * 2);

    let groupName: string | undefined;
    if (isGroup && groupId !== undefined) groupName = await this.groupName(groupId);

    const built = await buildPrompt({
      settings: resolved,
      includeContext: this.config.prompt.includeContext,
      timezone: this.config.prompt.timezone,
      scope,
      isGroup,
      groupId,
      groupName,
      selfId,
      botName: this.botName ?? undefined,
      speaker: isGroup ? speaker : null,
      userName,
      history,
      historyMedia,
      currentParts: normalized.parts,
      currentImages: toResolved(currentEntries),
      quote: quoteSource
        ? {
            sender: quoteSource.sender,
            parts: quoteCfg.includeText ? quoteSource.parts : [],
            text: quoteCfg.includeText ? quoteSource.text : '',
            images: toResolved(quoteEntries),
          }
        : undefined,
      historyMaxImages: this.config.historyImages.maxImages,
      quoteMaxChars: this.config.quote.maxChars,
      maxContextChars: this.config.context.maxContextChars,
      includeTimestamps: this.config.context.includeTimestamps,
      loadMediaDataUrl: (item) => readAsDataUrl(item.path, item.mime),
    });

    if (!built.model) {
      throw new Error(`${built.kind} 模型未配置，请在 WebUI 里设置`);
    }

    log.info(
      '%s -> %s (kind=%s model=%s images=%d history=%d)',
      scope,
      userName,
      built.kind,
      built.model,
      built.attachedImages,
      history.length,
    );

    let result: AiResult;
    try {
      result = await this.ai.complete({
        baseUrl: resolved[built.kind].baseUrl,
        apiKey: resolved[built.kind].apiKey,
        model: built.model,
        messages: built.messages,
        temperature: resolved.chat.temperature,
        maxTokens: resolved.chat.maxTokens,
        timeoutMs: this.config.ai.timeoutMs,
        maxRetries: this.config.ai.maxRetries,
      });
      this.db.addUsage({
        day: new Date().toISOString().slice(0, 10),
        scope,
        kind: built.kind,
        model: built.model,
        calls: 1,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
      });
    } catch (e) {
      log.error('AI 调用失败 %s：%s', scope, (e as Error).message);
      if (this.config.reply.errorReply) {
        await this.sendReply(event, scope, isGroup, this.config.reply.errorReply, false);
      }
      return;
    }

    const cleaned = this.config.reply.stripMarkdown ? stripMarkdown(result.content) : result.content.trim();
    if (!cleaned) {
      const hint =
        result.finishReason === 'length'
          ? `输出被 max_tokens 截断${result.reasoningChars > 0 ? '（该模型带思考过程，额度被思考用光了）' : ''}，请到管理面板「模型与设置」把「最大回复 tokens」调大（如 4096）`
          : '模型没有返回任何正文内容';
      log.warn(
        '模型返回空内容，未回复 %s（model=%s finish_reason=%s 推理字符=%d 输出tokens=%d）：%s',
        scope,
        built.model,
        result.finishReason || '-',
        result.reasoningChars,
        result.completionTokens,
        hint,
      );
      if (this.config.reply.emptyFallback) {
        await this.sendReply(event, scope, isGroup, this.config.reply.emptyFallback, false);
      }
      return;
    }

    log.debug('%s 回复 %d 字（finish_reason=%s）', scope, cleaned.length, result.finishReason || '-');

    await this.sendReply(event, scope, isGroup, cleaned, isGroup && this.config.reply.quoteOnGroup);
    this.db.appendMessage({ scope, role: 'assistant', speaker: null, content: cleaned });
    this.db.pruneScope(scope, resolved.maxTurns * 2);

    if (resolved.historyImagesMode === 'caption' && resolved.visionEnabled) {
      for (const fetched of storedForCaption) this.scheduleCaption(fetched, resolved, scope);
    }
  }

  private async resolveImages(
    refs: Array<{ file: string; url?: string }>,
    resolved: ReturnType<SettingsStore['resolve']>,
  ): Promise<ResolvedEntry[]> {
    const out: ResolvedEntry[] = [];
    for (const ref of refs) {
      const fetched = await fetchAndStoreImage(ref, (file) => this.getImageUrl(file), this.config.vision.maxBytes);
      out.push({
        ref,
        dataUrl: fetched ? toDataUrl(fetched.bytes, fetched.mime) : null,
        fetched,
      });
    }
    return out;
  }

  private scheduleCaption(
    fetched: FetchedImage,
    resolved: ReturnType<SettingsStore['resolve']>,
    scope: Scope,
  ): void {
    if (this.captioning.has(fetched.sha1)) return;
    if (this.db.findCaption(fetched.sha1)) return;
    const model = this.config.historyImages.captionModel || resolved.vision.model;
    if (!model || !resolved.vision.baseUrl) return;

    this.captioning.add(fetched.sha1);
    const dataUrl = toDataUrl(fetched.bytes, fetched.mime);
    void this.ai
      .complete({
        baseUrl: resolved.vision.baseUrl,
        apiKey: resolved.vision.apiKey,
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: this.config.historyImages.captionPrompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
        maxTokens: this.config.historyImages.captionMaxTokens,
        timeoutMs: this.config.ai.timeoutMs,
        maxRetries: 0,
      })
      .then((result) => {
        const caption = result.content.trim().replace(/\s+/g, ' ');
        if (!caption) return;
        this.db.setCaption(fetched.sha1, caption);
        this.db.addUsage({
          day: new Date().toISOString().slice(0, 10),
          scope,
          kind: 'vision',
          model,
          calls: 1,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
        });
        log.debug('caption for %s: %s', fetched.sha1.slice(0, 8), caption);
      })
      .catch((e) => log.warn('caption failed: %s', (e as Error).message))
      .finally(() => this.captioning.delete(fetched.sha1));
  }

  private async sendReply(
    event: OneBotMessageEvent,
    _scope: Scope,
    isGroup: boolean,
    text: string,
    quote: boolean,
  ): Promise<void> {
    const chunks = splitChunks(text, this.config.reply.maxCharsPerMessage);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
        if (i === 0 && quote) segments.push({ type: 'reply', data: { id: String(event.message_id) } });
        segments.push({ type: 'text', data: { text: chunks[i] } });
        if (isGroup) {
          await this.client.sendGroupMessage(Number((event as OneBotGroupMessageEvent).group_id), segments as never);
        } else {
          await this.client.sendPrivateMessage(Number((event as OneBotPrivateMessageEvent).user_id), segments as never);
        }
      }
    } catch (e) {
      log.error('send failed for message %s: %s', event.message_id, (e as Error).message);
    }
  }

  // ------------------------------------------------------------------ helpers

  private async getImageUrl(file: string): Promise<string | null> {
    try {
      const info = (await this.client.getImage({ file })) as Record<string, unknown>;
      const url = info.url ?? info.file;
      return typeof url === 'string' && url ? url : null;
    } catch {
      return null;
    }
  }

  private async fetchPttText(messageId: number): Promise<string | null> {
    try {
      const result = (await this.client.raw('fetch_ptt_text', { message_id: messageId } as never)) as {
        text?: unknown;
      };
      const text = result?.text;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    } catch {
      return null;
    }
  }

  private async groupName(groupId: number): Promise<string | undefined> {
    const cached = this.groupNames.get(groupId);
    if (cached) return cached;
    try {
      const info = (await this.client.getGroupInfo(groupId)) as Record<string, unknown>;
      const name = String(info.group_name ?? '').trim();
      if (name) this.groupNames.set(groupId, name);
      return name || undefined;
    } catch {
      return undefined;
    }
  }

  private maintenance(): void {
    try {
      // media files are content addressed; prune by age
      pruneMediaFiles(this.config.media.keepDays);
      this.db.checkpoint();
    } catch (e) {
      log.warn('maintenance failed: %s', (e as Error).message);
    }
  }
}

function toResolved(entries: ResolvedEntry[]): ResolvedImage[] {
  return entries.map((e) => ({ ref: e.ref, dataUrl: e.dataUrl }));
}

function displayName(event: OneBotMessageEvent): string {
  const card = (event.sender?.card ?? '').trim();
  if (card) return card;
  const nickname = (event.sender?.nickname ?? '').trim();
  if (nickname) return nickname;
  return String(event.user_id);
}

function guessMime(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'image/jpeg';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type {
  OneBotMessageEvent,
  OneBotGroupMessageEvent,
  OneBotPrivateMessageEvent,
  SnowLumaEvent,
  NormalizedPart,
  ChatKind,
};
