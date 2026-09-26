import { createLogger } from './logger.js';
import type {
  ImageRef,
  NormalizedMessage,
  NormalizedPart,
  NormalizedQuote,
} from './types.js';
import type { MentionResolver } from './mentions.js';

const log = createLogger('normalize');

export interface NormalizeDeps {
  selfId: number;
  isGroup: boolean;
  groupId?: number;
  messageId?: number;
  mentions: MentionResolver;
  transcribe: boolean;
  fetchPttText?: (messageId: number) => Promise<string | null>;
  getMessage?: (messageId: number) => Promise<Record<string, unknown>>;
}

interface Segment {
  type: string;
  data: Record<string, unknown>;
}

/** OneBot message field is either a segment array, a CQ string, or junk. */
function toSegments(raw: unknown, rawMessage: string | undefined): Segment[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      .map((s) => {
        const record = s as Record<string, unknown>;
        const explicit = record.data;
        // OneBot puts payload under `data`; some gateways flatten it inline.
        const data =
          explicit && typeof explicit === 'object'
            ? (explicit as Record<string, unknown>)
            : Object.fromEntries(Object.entries(record).filter(([k]) => k !== 'type'));
        return { type: String(record.type ?? ''), data };
      })
      .filter((s) => s.type.length > 0);
  }
  if (typeof raw === 'string' && raw.length > 0) return parseCq(raw);
  if (rawMessage) return parseCq(rawMessage);
  return [];
}

function parseCq(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[CQ:([a-zA-Z0-9_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push({ type: 'text', data: { text: text.slice(last, match.index) } });
    const type = match[1];
    const data: Record<string, unknown> = {};
    const params = match[2] ?? '';
    if (params) {
      for (const pair of params.replace(/^,/, '').split(',')) {
        const idx = pair.indexOf('=');
        if (idx > 0) data[pair.slice(0, idx)] = decodeCq(pair.slice(idx + 1));
      }
    }
    out.push({ type, data });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', data: { text: text.slice(last) } });
  return out;
}

function decodeCq(value: string): string {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export async function normalizeMessage(raw: unknown, deps: NormalizeDeps): Promise<NormalizedMessage> {
  const segments = toSegments(raw, undefined);
  const parts: NormalizedPart[] = [];
  const images: ImageRef[] = [];
  let quoteId: number | null = null;
  let recordSeen = false;

  for (const seg of segments) {
    switch (seg.type) {
      case 'text': {
        const text = str(seg.data.text);
        if (text) parts.push({ kind: 'text', text });
        break;
      }
      case 'at': {
        const qq = str(seg.data.qq);
        if (qq === String(deps.selfId)) break; // the mention that triggered us
        if (qq === 'all') {
          parts.push({ kind: 'text', text: '@全体成员' });
          break;
        }
        const id = Number(qq);
        let name = qq;
        if (deps.isGroup && deps.groupId && Number.isFinite(id)) {
          name = await deps.mentions.displayName(deps.groupId, id);
        }
        parts.push({ kind: 'text', text: `@${name}` });
        break;
      }
      case 'image': {
        const ref: ImageRef = {
          file: str(seg.data.file) || str(seg.data.file_id),
          url: str(seg.data.url) || undefined,
        };
        images.push(ref);
        parts.push({ kind: 'image', segment: ref });
        break;
      }
      case 'face':
        parts.push({ kind: 'text', text: '[表情]' });
        break;
      case 'record':
        recordSeen = true;
        parts.push({ kind: 'placeholder', text: '[语音]' });
        break;
      case 'video':
        parts.push({ kind: 'text', text: '[视频]' });
        break;
      case 'file':
        parts.push({ kind: 'text', text: `[文件]${str(seg.data.name) ? ` ${str(seg.data.name)}` : ''}` });
        break;
      case 'reply': {
        const id = Number(str(seg.data.id));
        if (Number.isFinite(id)) quoteId = id;
        break;
      }
      case 'json':
      case 'xml':
        parts.push({ kind: 'text', text: '[卡片]' });
        break;
      case 'forward':
        parts.push({ kind: 'text', text: '[合并转发]' });
        break;
      case 'poke':
        parts.push({ kind: 'text', text: '[戳一戳]' });
        break;
      case 'share':
        parts.push({ kind: 'text', text: '[分享]' });
        break;
      default:
        break;
    }
  }

  if (recordSeen && deps.transcribe && deps.fetchPttText && deps.messageId !== undefined) {
    const transcript = await deps.fetchPttText(deps.messageId);
    if (transcript) {
      const idx = parts.findIndex((p) => p.kind === 'placeholder');
      if (idx >= 0) parts[idx] = { kind: 'text', text: `[语音转文字] ${transcript}` };
    }
  }

  const quote = quoteId !== null ? await resolveQuote(quoteId, deps) : undefined;
  return { parts, images, quote: quote ?? undefined };
}

export async function resolveQuote(
  messageId: number,
  deps: NormalizeDeps,
): Promise<NormalizedQuote | null> {
  if (!deps.getMessage) return null;
  try {
    const event = await deps.getMessage(messageId);
    const senderRaw = event.sender as Record<string, unknown> | undefined;
    const senderId = Number(event.user_id ?? 0);
    const name = senderId === deps.selfId
      ? '你'
      : pickName(senderRaw) ?? (Number.isFinite(senderId) && senderId > 0 ? `@${senderId}` : '某人');
    const inner = await normalizeMessage(event.message, { ...deps, messageId: undefined });
    return { sender: name, parts: inner.parts, text: partsToText(inner.parts), images: inner.images };
  } catch (e) {
    log.debug('quote %d unresolved: %s', messageId, (e as Error).message);
    return null;
  }
}

function pickName(sender: Record<string, unknown> | undefined): string | null {
  if (!sender) return null;
  const card = str(sender.card).trim();
  if (card) return card;
  const nickname = str(sender.nickname).trim();
  if (nickname) return nickname;
  return null;
}

/** Renders parts to plain text, turning image parts into `[图片]`. */
export function partsToText(parts: NormalizedPart[], imageText = '[图片]'): string {
  return parts
    .map((p) => {
      if (p.kind === 'text') return p.text;
      if (p.kind === 'placeholder') return p.text;
      return imageText;
    })
    .join('')
    .trim();
}

export function hasContent(parts: NormalizedPart[]): boolean {
  return parts.some((p) => (p.kind === 'text' ? p.text.trim().length > 0 : true));
}

/** True when the raw message mentions `selfId` (structured segments or CQ text). */
export function mentionedSelf(raw: unknown, rawMessage: string | undefined, selfId: number): boolean {
  const target = String(selfId);
  if (Array.isArray(raw)) {
    for (const seg of raw) {
      if (!seg || typeof seg !== 'object') continue;
      const s = seg as { type?: unknown; data?: Record<string, unknown> };
      if (s.type !== 'at') continue;
      if (String(s.data?.qq ?? '') === target) return true;
    }
  }
  if (typeof rawMessage === 'string' && rawMessage.includes(`[CQ:at,qq=${target}]`)) return true;
  return false;
}
