import { ResponseCacheYDB, ResponseCacheYDBOptions } from './cache-ydb.js';

export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
  expiresAt?: number;
  tags?: string[];
}

export interface ResponseCache {
  get(key: string): Promise<CachedResponse | null>;
  set(
    key: string,
    response: CachedResponse,
    options?: {
      ttlSeconds?: number;
      tags?: string[];
    },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  purgeTag(tag: string): Promise<void>;
  close?(): Promise<void>;
}

export interface ResponseCacheOptions {
  enabled: boolean;
  driver?: 'memory' | 'ydb';
  defaultTtlSeconds?: number;
  ydb?: ResponseCacheYDBOptions;
}

interface MemoryEntry {
  value: CachedResponse;
  expiresAt: number;
}

export class InMemoryResponseCache implements ResponseCache {
  private readonly cache = new Map<string, MemoryEntry>();
  private readonly defaultTtlSeconds: number;

  constructor(defaultTtlSeconds = 60) {
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  async get(key: string): Promise<CachedResponse | null> {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(
    key: string,
    response: CachedResponse,
    options?: {
      ttlSeconds?: number;
      tags?: string[];
    },
  ): Promise<void> {
    const ttlMs = (options?.ttlSeconds ?? this.defaultTtlSeconds) * 1000;
    this.cache.set(key, {
      value: {
        ...response,
        tags: options?.tags ?? response.tags,
        expiresAt: Date.now() + ttlMs,
      },
      expiresAt: Date.now() + ttlMs,
    });
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async purgeTag(tag: string): Promise<void> {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.value.tags?.includes(tag)) {
        this.cache.delete(key);
      }
    }
  }
}

export function createResponseCache(options: ResponseCacheOptions): ResponseCache {
  if (!options.enabled) {
    return new InMemoryResponseCache(1);
  }

  if (options.driver === 'ydb' && options.ydb) {
    return new ResponseCacheYDB(options.ydb);
  }

  return new InMemoryResponseCache(options.defaultTtlSeconds ?? 60);
}
