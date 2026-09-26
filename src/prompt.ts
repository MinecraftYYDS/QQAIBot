import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { EffectiveSettings } from './settings.js';
import type {
  ChatKind,
  ImageRef,
  NormalizedPart,
  NormalizedQuote,
  StoredMedia,
  StoredMessage,
} from './types.js';

export interface ResolvedImage {
  ref: ImageRef;
  /** data URL when the image is usable; null when dropped (too large / failed). */
  dataUrl: string | null;
}

export interface PromptParams {
  settings: EffectiveSettings;
  includeContext: boolean;
  timezone: string;
  scope: string;
  isGroup: boolean;
  groupId?: number;
  groupName?: string;
  selfId: number;
  botName?: string;
  speaker: string | null;
  userName: string;
  history: StoredMessage[];
  historyMedia: Map<number, StoredMedia[]>;
  currentParts: NormalizedPart[];
  currentImages: ResolvedImage[];
  quote?: {
    sender: string;
    parts: NormalizedPart[];
    text: string;
    images: ResolvedImage[];
  };
  /** Caps how many history images may be replayed in `latest` mode. */
  historyMaxImages: number;
  /** Caps the quoted message text length. */
  quoteMaxChars: number;
  maxContextChars: number;
  includeTimestamps: boolean;
  /** Loads stored media bytes for `latest` history replay. */
  loadMediaDataUrl?: (item: StoredMedia) => Promise<string | null>;
}

export interface BuiltPrompt {
  kind: ChatKind;
  model: string;
  messages: ChatCompletionMessageParam[];
  attachedImages: number;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export async function buildPrompt(params: PromptParams): Promise<BuiltPrompt> {
  const { settings } = params;
  const visionOn = settings.visionEnabled;

  let budget = settings.maxImagesPerRequest;

  const currentAttach = params.currentImages.map((img) => {
    if (!visionOn || !img.dataUrl || budget <= 0) return null;
    budget -= 1;
    return img.dataUrl;
  });
  const quoteAttach = (params.quote?.images ?? []).map((img) => {
    if (!visionOn || !img.dataUrl || budget <= 0) return null;
    budget -= 1;
    return img.dataUrl;
  });

  const systemText = buildSystemPrompt(params);
  const history = trimHistory(params, systemText.length);

  // History images can only be replayed in `latest` mode. This runs before the
  // model is chosen, so replayed history images still route to the vision model.
  const historyAttach = new Map<number, Set<number>>();
  let historyAttached = 0;
  if (visionOn && settings.historyImagesMode === 'latest') {
    let historyBudget = Math.max(0, params.historyMaxImages);
    for (let i = history.length - 1; i >= 0 && historyBudget > 0; i--) {
      const m = history[i];
      if (m.role !== 'user' || !m.hadImage) continue;
      const media = params.historyMedia.get(m.id) ?? [];
      for (const item of media) {
        if (budget <= 0 || historyBudget <= 0) break;
        const set = historyAttach.get(m.id) ?? new Set<number>();
        set.add(item.id);
        historyAttach.set(m.id, set);
        budget -= 1;
        historyBudget -= 1;
        historyAttached += 1;
      }
    }
  }

  const inlineImages = currentAttach.filter(Boolean).length + quoteAttach.filter(Boolean).length;
  const kind: ChatKind = visionOn && inlineImages + historyAttached > 0 ? 'vision' : 'chat';
  const model = kind === 'vision' ? settings.vision.model : settings.chat.model;

  const messages: ChatCompletionMessageParam[] = [{ role: 'system', content: systemText }];
  let attached = inlineImages;

  for (const m of history) {
    if (m.role === 'assistant') {
      messages.push({ role: 'assistant', content: m.content });
      continue;
    }
    const media = params.historyMedia.get(m.id) ?? [];
    const attach = historyAttach.get(m.id);
    const speakerPrefix = m.speaker ? `${m.speaker}: ` : '';
    const stamp = params.includeTimestamps ? `(${formatClock(m.createdAt, params.timezone)}) ` : '';
    const prefix = `${stamp}${speakerPrefix}`;

    if (attach && attach.size > 0) {
      const attachedMedia = media.filter((item) => attach.has(item.id));
      const parts = await renderHistoryContent(
        m.content,
        attachedMedia,
        prefix,
        params.loadMediaDataUrl,
      );
      attached += parts.filter((p) => p.type === 'image_url').length;
      messages.push({ role: 'user', content: parts });
    } else {
      const text =
        settings.historyImagesMode === 'caption' ? applyCaptions(m.content, media) : m.content;
      messages.push({ role: 'user', content: `${prefix}${text}`.trim() });
    }
  }

  // Current turn (quote block first, then the live message).
  const prefix = params.isGroup && params.speaker ? `${params.speaker}: ` : '';
  const quoteBody = params.quote
    ? renderParts(params.quote.parts, (i) => quoteAttach[i] !== null)
    : '';
  const quotePrefix = params.quote
    ? `[引用 ${params.quote.sender} 的消息] ${truncate(quoteBody, params.quoteMaxChars)}\n`
    : '';

  if (kind === 'chat') {
    const body = renderParts(params.currentParts, () => false);
    messages.push({ role: 'user', content: `${quotePrefix}${prefix}${body}`.trim() || '[空消息]' });
  } else {
    const content: ContentPart[] = [];
    let buf = quotePrefix;
    const flush = () => {
      if (buf.length > 0) {
        content.push({ type: 'text', text: buf });
        buf = '';
      }
    };
    buf += prefix;
    let idx = 0;
    for (const part of params.currentParts) {
      if (part.kind === 'image') {
        const url = currentAttach[idx] ?? null;
        idx += 1;
        if (url) {
          flush();
          content.push({ type: 'image_url', image_url: { url } });
        } else {
          buf += '[图片]';
        }
      } else {
        buf += part.text;
      }
    }
    flush();
    if (content.length === 0) content.push({ type: 'text', text: '[空消息]' });
    messages.push({ role: 'user', content });
  }

  return { kind, model, messages, attachedImages: attached };
}

function renderParts(parts: NormalizedPart[], isAttached: (index: number) => boolean): string {
  let idx = 0;
  let out = '';
  for (const part of parts) {
    if (part.kind === 'image') {
      const attach = isAttached(idx);
      idx += 1;
      if (!attach) out += '[图片]';
    } else {
      out += part.text;
    }
  }
  return out.trim();
}

/**
 * Rebuilds a stored message as text/image parts in the original posting order,
 * so multimodal models see "文字 → 图片 → 文字 → 图片…" instead of captions.
 */
async function renderHistoryContent(
  content: string,
  media: StoredMedia[],
  prefix: string,
  load?: (item: StoredMedia) => Promise<string | null>,
): Promise<ContentPart[]> {
  const loadOne = async (item: StoredMedia | undefined): Promise<ContentPart> => {
    const url = item && load ? await load(item) : null;
    return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[图片]' };
  };

  const segments = content.split('[图片]');
  const placeholders = segments.length - 1;

  // Only interleave when every placeholder maps to a stored image; otherwise
  // fall back to text first and whatever images we do have afterwards.
  if (placeholders === 0 || placeholders !== media.length) {
    const text = content.replace(/\[图片\]/g, '').replace(/\s{2,}/g, ' ').trim();
    const parts: ContentPart[] = [];
    const head = `${prefix}${text}`.trim();
    if (head) parts.push({ type: 'text', text: head });
    for (const item of media) parts.push(await loadOne(item));
    if (parts.length === 0) parts.push({ type: 'text', text: '[空消息]' });
    return parts;
  }

  const parts: ContentPart[] = [];
  for (let i = 0; i < segments.length; i++) {
    const head = i === 0 ? `${prefix}${segments[i]}` : segments[i];
    const text = head.trim();
    if (text) parts.push({ type: 'text', text });
    if (i < segments.length - 1) parts.push(await loadOne(media[i]));
  }
  return parts;
}

function truncate(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return text;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function applyCaptions(text: string, media: StoredMedia[]): string {
  const captions = media.map((m) => m.caption).filter((c): c is string => Boolean(c));
  if (captions.length === 0) return text;
  let i = 0;
  return text.replace(/\[图片\]/g, () => {
    const cap = captions[i];
    i += 1;
    return cap ? `[图片: ${cap}]` : '[图片]';
  });
}

function trimHistory(params: PromptParams, systemLength: number): StoredMessage[] {
  const limit = params.maxContextChars;
  let total =
    systemLength +
    params.currentParts.reduce((n, p) => n + (p.kind === 'text' ? p.text.length : 4), 0) +
    (params.quote?.text.length ?? 0);
  const kept: StoredMessage[] = [];
  for (let i = params.history.length - 1; i >= 0; i--) {
    const m = params.history[i];
    const media = params.historyMedia.get(m.id) ?? [];
    const size = m.content.length + (m.speaker?.length ?? 0) + media.reduce((n, x) => n + (x.caption?.length ?? 0) + 6, 0);
    if (total + size > limit && kept.length > 0) break;
    total += size;
    kept.push(m);
  }
  return kept.reverse();
}

function buildSystemPrompt(params: PromptParams): string {
  const base = params.settings.systemPrompt.trim() || '你是一个友好的群聊助手。';
  if (!params.includeContext) return base;

  const lines: string[] = [base, '', '[环境]'];
  lines.push(`当前时间：${formatFull(new Date(), params.timezone)}（${params.timezone}）`);
  if (params.isGroup) {
    const name = params.groupName ? `，群名 ${params.groupName}` : '';
    lines.push(`场景：群聊（群号 ${params.groupId ?? '未知'}${name}）`);
  } else {
    lines.push('场景：私聊');
  }
  if (params.botName) lines.push(`你的昵称：${params.botName}`);
  lines.push(`正在与你对话的人：${params.userName}`);
  lines.push('会话约定：消息中 "@昵称" 表示提到了该成员；"[引用 X 的消息]" 表示引用了 X 的一条消息；"[图片]" 表示图片，"[图片: 描述]" 是图片内容描述。');
  return lines.join('\n');
}

export function formatFull(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatClock(epochMs: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(epochMs));
  } catch {
    return new Date(epochMs).toISOString().slice(11, 16);
  }
}

export type { NormalizedQuote };
