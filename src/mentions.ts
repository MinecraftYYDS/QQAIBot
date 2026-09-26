import { createLogger } from './logger.js';

const log = createLogger('mentions');

type Json = Record<string, unknown>;

export interface MemberListClient {
  getGroupMemberList(groupId: number, options?: { noCache?: boolean }): Promise<Json[]>;
  getGroupMemberInfo(groupId: number, userId: number): Promise<Json>;
}

interface GroupCache {
  expireAt: number;
  byId: Map<number, string>;
  byName: Map<string, number>;
}

/** Resolves QQ numbers to display names using a TTL'd per-group member cache. */
export class MentionResolver {
  private readonly cache = new Map<number, GroupCache>();
  private readonly inflight = new Map<number, Promise<GroupCache>>();

  constructor(
    private readonly client: MemberListClient,
    private readonly ttlMs: number,
  ) {}

  async displayName(groupId: number, userId: number): Promise<string> {
    const cache = await this.group(groupId);
    return cache.byId.get(userId) ?? (await this.fetchOne(groupId, userId, cache));
  }

  /** Reverse lookup used when converting `@名字` in replies into real mentions. */
  async userIdByName(groupId: number, name: string): Promise<number | null> {
    const cache = await this.group(groupId);
    return cache.byName.get(name.trim()) ?? null;
  }

  private async fetchOne(groupId: number, userId: number, cache: GroupCache): Promise<string> {
    try {
      const info = await this.client.getGroupMemberInfo(groupId, userId);
      const name = pickName(info) ?? String(userId);
      cache.byId.set(userId, name);
      cache.byName.set(name, userId);
      return name;
    } catch {
      return String(userId);
    }
  }

  private group(groupId: number): Promise<GroupCache> {
    const cached = this.cache.get(groupId);
    if (cached && cached.expireAt > Date.now()) return Promise.resolve(cached);

    const running = this.inflight.get(groupId);
    if (running) return running;

    const task = this.load(groupId).finally(() => this.inflight.delete(groupId));
    this.inflight.set(groupId, task);
    return task;
  }

  private async load(groupId: number): Promise<GroupCache> {
    const fresh: GroupCache = { expireAt: Date.now() + this.ttlMs, byId: new Map(), byName: new Map() };
    try {
      const members = await this.client.getGroupMemberList(groupId);
      for (const m of members) {
        const id = Number(m.user_id);
        if (!Number.isFinite(id)) continue;
        const name = pickName(m) ?? String(id);
        fresh.byId.set(id, name);
        fresh.byName.set(name, id);
      }
    } catch (e) {
      log.warn('member list for group %d failed: %s', groupId, (e as Error).message);
    }
    this.cache.set(groupId, fresh);
    return fresh;
  }
}

function pickName(member: Json): string | null {
  const card = typeof member.card === 'string' ? member.card.trim() : '';
  if (card) return card;
  const nickname = typeof member.nickname === 'string' ? member.nickname.trim() : '';
  if (nickname) return nickname;
  return null;
}
