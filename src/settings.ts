import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import type { Scope } from './types.js';

export interface ChatModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface VisionModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface EffectiveSettings {
  enabled: boolean;
  visionEnabled: boolean;
  systemPrompt: string;
  historyImagesMode: 'none' | 'latest' | 'caption';
  maxImagesPerRequest: number;
  /** Record every group message as context, not only the ones that mention the bot. */
  recordAll: boolean;
  recordImages: boolean;
  /** How many recent turns (≈2 messages each) to keep and send. */
  maxTurns: number;
  /** QQ emoji id to react with on a group mention; '' disables it. */
  emojiReaction: string;
  chat: ChatModelSettings;
  vision: VisionModelSettings;
}

export const APP_KEYS = {
  visionEnabled: 'vision.enabled',
  historyImagesMode: 'historyImages.mode',
  systemPrompt: 'chat.systemPrompt',
  chatBaseUrl: 'chat.baseUrl',
  chatApiKey: 'chat.apiKey',
  chatModel: 'chat.model',
  chatTemperature: 'chat.temperature',
  chatMaxTokens: 'chat.maxTokens',
  visionBaseUrl: 'vision.baseUrl',
  visionApiKey: 'vision.apiKey',
  visionModel: 'vision.model',
  maxImagesPerRequest: 'vision.maxImagesPerRequest',
  recordAll: 'context.recordAll',
  recordImages: 'context.recordImages',
  maxTurns: 'context.maxTurns',
  emojiReaction: 'reply.emojiReaction',
} as const;

/**
 * Merges the three layers: per-scope settings > WebUI global overrides > config.yaml.
 */
export class SettingsStore {
  constructor(
    private config: AppConfig,
    private db: Database,
  ) {}

  updateConfig(config: AppConfig): void {
    this.config = config;
  }

  get base(): AppConfig {
    return this.config;
  }

  private appString(key: string, fallback: string): string {
    const value = this.db.getAppSetting(key);
    return value === null || value === '' ? fallback : value;
  }

  private appNumber(key: string, fallback: number): number {
    const value = this.db.getAppNumber(key);
    return value === null ? fallback : value;
  }

  private appBool(key: string, fallback: boolean): boolean {
    const value = this.db.getAppBool(key);
    return value === null ? fallback : value;
  }

  resolve(scope: Scope): EffectiveSettings {
    const c = this.config;
    const perScope = this.db.getScopeSettings(scope);

    const globalVision = this.appBool(APP_KEYS.visionEnabled, c.vision.enabled);
    const mode = (this.db.getAppSetting(APP_KEYS.historyImagesMode) ??
      c.historyImages.mode) as EffectiveSettings['historyImagesMode'];

    const globalPrompt = this.appString(APP_KEYS.systemPrompt, c.chat.systemPrompt);

    return {
      enabled: perScope?.enabled ?? true,
      visionEnabled: perScope?.visionEnabled ?? globalVision,
      systemPrompt: perScope?.systemPrompt ?? globalPrompt,
      historyImagesMode: mode,
      maxImagesPerRequest: this.appNumber(
        APP_KEYS.maxImagesPerRequest,
        c.vision.maxImagesPerRequest,
      ),
      recordAll: this.appBool(APP_KEYS.recordAll, c.context.recordAll),
      recordImages: this.appBool(APP_KEYS.recordImages, c.context.recordImages),
      maxTurns: Math.max(
        1,
        Math.round(this.appNumber(APP_KEYS.maxTurns, c.context.maxTurns)),
      ),
      emojiReaction: this.appString(APP_KEYS.emojiReaction, c.reply.emojiReaction).trim(),
      chat: {
        baseUrl: this.appString(APP_KEYS.chatBaseUrl, c.chat.baseUrl),
        apiKey: this.appString(APP_KEYS.chatApiKey, c.chat.apiKey),
        model: this.appString(APP_KEYS.chatModel, c.chat.model),
        temperature: this.appNumber(APP_KEYS.chatTemperature, c.chat.temperature),
        maxTokens: this.appNumber(APP_KEYS.chatMaxTokens, c.chat.maxTokens),
      },
      vision: {
        baseUrl: this.appString(APP_KEYS.visionBaseUrl, c.vision.baseUrl),
        apiKey: this.appString(APP_KEYS.visionApiKey, c.vision.apiKey),
        model: this.appString(APP_KEYS.visionModel, c.vision.model),
      },
    };
  }

  /** Applies a batch of WebUI global overrides (empty value clears the override). */
  applyGlobalOverrides(entries: Record<string, string | number | boolean | null>): void {
    for (const [key, value] of Object.entries(entries)) {
      if (value === null || value === '') {
        this.db.deleteAppSetting(key);
      } else {
        this.db.setAppSetting(key, String(value));
      }
    }
  }
}
