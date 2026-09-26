import type { OneBotGroupMessageEvent, OneBotPrivateMessageEvent } from '@snowluma/sdk';

/** Any message event the bot reacts to. */
export type MessageEvent = OneBotGroupMessageEvent | OneBotPrivateMessageEvent;

/** Conversation bucket: groups share one, private chats are per user. */
export type Scope = `group:${number}` | `private:${number}`;

export type ChatKind = 'chat' | 'vision';

export type Role = 'user' | 'assistant';

export interface StoredMessage {
  id: number;
  scope: string;
  role: Role;
  speaker: string | null;
  content: string;
  hadImage: boolean;
  hadQuote: boolean;
  createdAt: number;
}

export interface StoredMedia {
  id: number;
  messageId: number;
  seq: number;
  path: string;
  mime: string;
  bytes: number;
  sha1: string;
  caption: string | null;
}

export interface ScopeSettings {
  enabled: boolean | null;
  visionEnabled: boolean | null;
  systemPrompt: string | null;
}

/** One flattened piece of an inbound message, in original order. */
export type NormalizedPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; segment: ImageRef }
  | { kind: 'placeholder'; text: string };

export interface ImageRef {
  file: string;
  url?: string;
  mime?: string;
}

export interface NormalizedMessage {
  /** Flattened content, in original order. */
  parts: NormalizedPart[];
  /** Images in order of appearance. */
  images: ImageRef[];
  /** Quoted (replied-to) message, already normalized. */
  quote?: NormalizedQuote;
}

export interface NormalizedQuote {
  sender: string;
  parts: NormalizedPart[];
  text: string;
  images: ImageRef[];
}

export interface BuiltRequest {
  kind: ChatKind;
  messages: Array<Record<string, unknown>>;
}

export interface UsageRecord {
  scope: string;
  kind: ChatKind;
  model: string;
  promptTokens: number;
  completionTokens: number;
}
