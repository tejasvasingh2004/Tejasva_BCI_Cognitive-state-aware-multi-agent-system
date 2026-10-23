import { createHash } from 'node:crypto';
import type { ChatMessage, Usage } from '@neuroflow/contracts';
import type { Redis } from './redis';

export type CachedResponse = {
  text: string;
  finishReason: string;
  /** The model that produced the answer (ref). */
  ref: string;
  usage?: Usage;
  createdAt: string;
};

export type CacheKeyInput = {
  workspaceId: string;
  ref: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningBudget?: string;
  responseFormat?: unknown;
};

export const RESPONSE_CACHE_MAX_TTL_S = 24 * 3600;

/**
 * Exact-match response cache for gateway-mode calls. Opt-in per request, scoped per workspace
 * (the workspace id is part of the key, so one tenant can never read another's answers), and only
 * for single-turn requests without tools, so an answer cannot leak across conversations or depend
 * on tool results. Entries expire after the requested TTL (at most 24 h).
 */
export class ResponseCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'nf:rcache:',
  ) {}

  /** Whether a request may use the cache: exactly one user turn, optional system text, no tools. */
  static eligible(messages: ChatMessage[], hasTools: boolean): boolean {
    if (hasTools) return false;
    const turns = messages.filter((m) => m.role !== 'system');
    return turns.length === 1 && turns[0]!.role === 'user';
  }

  key(input: CacheKeyInput): string {
    const material = JSON.stringify([
      input.workspaceId,
      input.ref,
      input.messages.map((m) => [m.role, m.content]),
      input.temperature ?? null,
      input.maxOutputTokens ?? null,
      input.reasoningBudget ?? null,
      input.responseFormat ?? null,
    ]);
    return `${this.prefix}${input.workspaceId}:${createHash('sha256').update(material).digest('hex')}`;
  }

  async get(key: string): Promise<CachedResponse | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CachedResponse;
    } catch {
      return null;
    }
  }

  async set(key: string, value: CachedResponse, ttlSeconds: number): Promise<void> {
    const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), RESPONSE_CACHE_MAX_TTL_S);
    await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
  }

  /** Removes every cached answer of a workspace (e.g. when a user asks to clear it). */
  async clear(workspaceId: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}${workspaceId}:*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) removed += await this.redis.del(...keys);
    } while (cursor !== '0');
    return removed;
  }
}
