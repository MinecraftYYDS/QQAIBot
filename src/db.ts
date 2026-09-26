import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from './logger.js';
import { dataDir, dbFile } from './paths.js';
import type { ChatKind, Role, ScopeSettings, StoredMedia, StoredMessage } from './types.js';

const log = createLogger('db');

type Statement = ReturnType<DatabaseSync['prepare']>;

interface MessageRow {
  id: number;
  scope: string;
  role: string;
  speaker: string | null;
  content: string;
  had_image: number;
  had_quote: number;
  created_at: number;
}

interface MediaRow {
  id: number;
  message_id: number;
  seq: number;
  path: string;
  mime: string;
  bytes: number;
  sha1: string;
  caption: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  speaker    TEXT,
  content    TEXT    NOT NULL,
  had_image  INTEGER NOT NULL DEFAULT 0,
  had_quote  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_scope ON messages(scope, id DESC);

CREATE TABLE IF NOT EXISTS message_media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  path       TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  bytes      INTEGER NOT NULL,
  sha1       TEXT    NOT NULL,
  caption    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_message ON message_media(message_id);
CREATE INDEX IF NOT EXISTS idx_media_sha1    ON message_media(sha1);

CREATE TABLE IF NOT EXISTS scope_settings (
  scope          TEXT PRIMARY KEY,
  enabled        INTEGER,
  vision_enabled INTEGER,
  system_prompt  TEXT,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_stats (
  day               TEXT    NOT NULL,
  scope             TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  calls             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, kind, model)
);
`;

/**
 * Bump this whenever the schema below changes, and add the matching upgrade
 * step in `Database.migrate()`. Migrations must only add tables/columns and
 * backfill values — never drop or rewrite existing rows.
 */
const SCHEMA_VERSION = 1;

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((r) => String(r.name)));
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: Number(row.id),
    scope: String(row.scope),
    role: row.role as Role,
    speaker: row.speaker ?? null,
    content: String(row.content),
    hadImage: Boolean(row.had_image),
    hadQuote: Boolean(row.had_quote),
    createdAt: Number(row.created_at),
  };
}

export class Database {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Statement>();

  constructor() {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
    log.info('sqlite ready at %s', dbFile);
  }

  /**
   * Applies additive upgrades to databases created by older versions. A copy
   * of the database is written next to it before any upgrade runs, so a failed
   * update never costs stored conversations.
   */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as unknown as
      | { user_version?: number }
      | undefined;
    const from = Number(row?.user_version ?? 0);
    if (from >= SCHEMA_VERSION) return;

    if (from > 0) {
      this.backupBeforeUpgrade(from);
      // -- migrations for older databases go here, guarded by `if (from < N)` --
      // if (from < 2 && !tableColumns(this.db, 'messages').has('parts_json')) {
      //   this.db.exec('ALTER TABLE messages ADD COLUMN parts_json TEXT');
      // }
      log.info('数据库已从 v%d 升级到 v%d（原库已备份）', from, SCHEMA_VERSION);
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private backupBeforeUpgrade(from: number): void {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(dbFile, `${dbFile}.bak-v${from}-${stamp}`);
    } catch (e) {
      log.warn('备份旧数据库失败：%s', (e as Error).message);
    }
  }

  private stmt(sql: string): Statement {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  // ---------------------------------------------------------------- messages

  appendMessage(input: {
    scope: string;
    role: Role;
    speaker: string | null;
    content: string;
    hadImage?: boolean;
    hadQuote?: boolean;
  }): number {
    const info = this.stmt(
      `INSERT INTO messages (scope, role, speaker, content, had_image, had_quote, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.scope,
      input.role,
      input.speaker,
      input.content,
      input.hadImage ? 1 : 0,
      input.hadQuote ? 1 : 0,
      Date.now(),
    );
    return Number(info.lastInsertRowid);
  }

  /** Returns the newest `limit` messages for a scope, oldest first. */
  getHistory(scope: string, limit: number): StoredMessage[] {
    if (limit <= 0) return [];
    const rows = this.stmt(
      `SELECT id, scope, role, speaker, content, had_image, had_quote, created_at
       FROM messages WHERE scope = ? ORDER BY id DESC LIMIT ?`,
    ).all(scope, limit) as unknown as MessageRow[];
    return rows.map(toMessage).reverse();
  }

  countMessages(scope: string): number {
    const row = this.stmt('SELECT COUNT(*) AS n FROM messages WHERE scope = ?').get(scope) as unknown as
      | { n: number }
      | undefined;
    return row ? Number(row.n) : 0;
  }

  /** Drops everything but the newest `keep` messages of a scope. */
  pruneScope(scope: string, keep: number): void {
    if (keep <= 0) {
      this.stmt('DELETE FROM messages WHERE scope = ?').run(scope);
      return;
    }
    this.stmt(
      `DELETE FROM messages WHERE scope = ? AND id NOT IN (
         SELECT id FROM messages WHERE scope = ? ORDER BY id DESC LIMIT ?
       )`,
    ).run(scope, scope, keep);
  }

  listScopes(): Array<{ scope: string; count: number; lastAt: number }> {
    const rows = this.stmt(
      `SELECT scope, COUNT(*) AS n, MAX(created_at) AS last
       FROM messages GROUP BY scope ORDER BY last DESC`,
    ).all() as unknown as Array<{ scope: string; n: number; last: number }>;
    return rows.map((r) => ({ scope: String(r.scope), count: Number(r.n), lastAt: Number(r.last) }));
  }

  clearScope(scope: string): void {
    this.stmt(
      'DELETE FROM message_media WHERE message_id IN (SELECT id FROM messages WHERE scope = ?)',
    ).run(scope);
    this.stmt('DELETE FROM messages WHERE scope = ?').run(scope);
    this.stmt('DELETE FROM scope_settings WHERE scope = ?').run(scope);
  }

  // ------------------------------------------------------------------- media

  addMedia(input: {
    messageId: number;
    seq: number;
    filePath: string;
    mime: string;
    bytes: number;
    sha1: string;
    caption?: string | null;
  }): void {
    this.stmt(
      `INSERT INTO message_media (message_id, seq, path, mime, bytes, sha1, caption, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.messageId,
      input.seq,
      input.filePath,
      input.mime,
      input.bytes,
      input.sha1,
      input.caption ?? null,
      Date.now(),
    );
  }

  getMediaForMessage(messageId: number): StoredMedia[] {
    const rows = this.stmt(
      `SELECT id, message_id, seq, path, mime, bytes, sha1, caption
       FROM message_media WHERE message_id = ? ORDER BY seq`,
    ).all(messageId) as unknown as MediaRow[];
    return rows.map((r) => ({
      id: Number(r.id),
      messageId: Number(r.message_id),
      seq: Number(r.seq),
      path: String(r.path),
      mime: String(r.mime),
      bytes: Number(r.bytes),
      sha1: String(r.sha1),
      caption: r.caption ?? null,
    }));
  }

  findCaption(sha1: string): string | null {
    const row = this.stmt(
      'SELECT caption FROM message_media WHERE sha1 = ? AND caption IS NOT NULL LIMIT 1',
    ).get(sha1) as unknown as { caption: string | null } | undefined;
    return row?.caption ?? null;
  }

  setCaption(sha1: string, caption: string): void {
    this.stmt('UPDATE message_media SET caption = ? WHERE sha1 = ?').run(caption, sha1);
  }

  // --------------------------------------------------------- scope settings

  getScopeSettings(scope: string): ScopeSettings | null {
    const row = this.stmt(
      'SELECT enabled, vision_enabled, system_prompt FROM scope_settings WHERE scope = ?',
    ).get(scope) as unknown as
      | { enabled: number | null; vision_enabled: number | null; system_prompt: string | null }
      | undefined;
    if (!row) return null;
    return {
      enabled: row.enabled === null ? null : Boolean(row.enabled),
      visionEnabled: row.vision_enabled === null ? null : Boolean(row.vision_enabled),
      systemPrompt: row.system_prompt ?? null,
    };
  }

  setScopeSettings(scope: string, next: Partial<ScopeSettings>): void {
    const current = this.getScopeSettings(scope) ?? {
      enabled: null,
      visionEnabled: null,
      systemPrompt: null,
    };
    const merged = { ...current, ...next };
    this.stmt(
      `INSERT INTO scope_settings (scope, enabled, vision_enabled, system_prompt, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         enabled = excluded.enabled,
         vision_enabled = excluded.vision_enabled,
         system_prompt = excluded.system_prompt,
         updated_at = excluded.updated_at`,
    ).run(
      scope,
      merged.enabled === null ? null : merged.enabled ? 1 : 0,
      merged.visionEnabled === null ? null : merged.visionEnabled ? 1 : 0,
      merged.systemPrompt,
      Date.now(),
    );
  }

  allScopeSettings(): Array<{ scope: string } & ScopeSettings> {
    const rows = this.stmt(
      'SELECT scope, enabled, vision_enabled, system_prompt FROM scope_settings',
    ).all() as unknown as Array<{
      scope: string;
      enabled: number | null;
      vision_enabled: number | null;
      system_prompt: string | null;
    }>;
    return rows.map((r) => ({
      scope: String(r.scope),
      enabled: r.enabled === null ? null : Boolean(r.enabled),
      visionEnabled: r.vision_enabled === null ? null : Boolean(r.vision_enabled),
      systemPrompt: r.system_prompt ?? null,
    }));
  }

  // ----------------------------------------------------------- app settings

  getAppSetting(key: string): string | null {
    const row = this.stmt('SELECT value FROM app_settings WHERE key = ?').get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setAppSetting(key: string, value: string): void {
    this.stmt(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, Date.now());
  }

  deleteAppSetting(key: string): void {
    this.stmt('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  allAppSettings(): Record<string, string> {
    const rows = this.stmt('SELECT key, value FROM app_settings').all() as unknown as Array<{
      key: string;
      value: string;
    }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r.key)] = String(r.value);
    return out;
  }

  getAppBool(key: string): boolean | null {
    const raw = this.getAppSetting(key);
    if (raw === null) return null;
    return raw === 'true' || raw === '1';
  }

  getAppNumber(key: string): number | null {
    const raw = this.getAppSetting(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // ------------------------------------------------------------------ usage

  addUsage(rec: {
    day: string;
    scope: string;
    kind: ChatKind;
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }): void {
    this.stmt(
      `INSERT INTO usage_stats (day, scope, kind, model, calls, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, scope, kind, model) DO UPDATE SET
         calls = calls + excluded.calls,
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens`,
    ).run(rec.day, rec.scope, rec.kind, rec.model, rec.calls, rec.promptTokens, rec.completionTokens);
  }

  usageByDay(days: number): Array<{
    day: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }> {
    const rows = this.stmt(
      `SELECT day, SUM(calls) AS calls, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c
       FROM usage_stats GROUP BY day ORDER BY day DESC LIMIT ?`,
    ).all(days) as unknown as Array<{ day: string; calls: number; p: number; c: number }>;
    return rows
      .map((r) => ({
        day: String(r.day),
        calls: Number(r.calls),
        promptTokens: Number(r.p),
        completionTokens: Number(r.c),
      }))
      .reverse();
  }

  usageByModel(days: number): Array<{
    kind: string;
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = this.stmt(
      `SELECT kind, model, SUM(calls) AS calls, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c
       FROM usage_stats WHERE day >= ? GROUP BY kind, model ORDER BY calls DESC`,
    ).all(cutoff) as unknown as Array<{
      kind: string;
      model: string;
      calls: number;
      p: number;
      c: number;
    }>;
    return rows.map((r) => ({
      kind: String(r.kind),
      model: String(r.model),
      calls: Number(r.calls),
      promptTokens: Number(r.p),
      completionTokens: Number(r.c),
    }));
  }

  usageToday(): { calls: number; promptTokens: number; completionTokens: number } {
    const day = new Date().toISOString().slice(0, 10);
    const row = this.stmt(
      `SELECT SUM(calls) AS calls, SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c
       FROM usage_stats WHERE day = ?`,
    ).get(day) as unknown as { calls: number | null; p: number | null; c: number | null };
    return {
      calls: Number(row.calls ?? 0),
      promptTokens: Number(row.p ?? 0),
      completionTokens: Number(row.c ?? 0),
    };
  }

  // --------------------------------------------------------------- lifecycle

  checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (e) {
      log.warn('checkpoint failed', e);
    }
  }

  close(): void {
    this.checkpoint();
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

export function ensureDirs(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
}
