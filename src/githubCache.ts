export interface CacheStorage {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface CachedResponse<T> {
  body: T;
  etag?: string;
  lastModified?: string;
  validatedAt: number;
  persistent: boolean;
}

const STORAGE_KEY = "githubIssueFinder.responseCache.v1";
const MAX_PERSISTED_ENTRIES = 80;

class ResponseCache {
  private readonly entries = new Map<string, CachedResponse<unknown>>();

  constructor(private readonly storage?: CacheStorage) {
    const persisted = storage?.get<Record<string, CachedResponse<unknown>>>(STORAGE_KEY, {});
    for (const [key, entry] of Object.entries(persisted ?? {})) {
      if (entry && typeof entry.validatedAt === "number") this.entries.set(key, entry);
    }
  }

  get<T>(key: string): CachedResponse<T> | undefined {
    return this.entries.get(key) as CachedResponse<T> | undefined;
  }

  set<T>(key: string, entry: CachedResponse<T>): void {
    this.entries.set(key, entry as CachedResponse<unknown>);
    if (entry.persistent) this.persist();
  }

  invalidate(predicate: (key: string) => boolean): void {
    let changed = false;
    for (const key of this.entries.keys()) {
      if (predicate(key)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    if (!this.storage) return;
    const persistentEntries = [...this.entries.entries()]
      .filter(([, entry]) => entry.persistent)
      .slice(-MAX_PERSISTED_ENTRIES);
    void this.storage.update(STORAGE_KEY, Object.fromEntries(persistentEntries));
  }
}

let responseCache = new ResponseCache();

export function configureResponseCache(storage: CacheStorage): void {
  responseCache = new ResponseCache(storage);
}

export function getResponseCache(): ResponseCache {
  return responseCache;
}

export function isPersistentIssueUrl(url: string): boolean {
  return /\/repos\/[^/]+\/[^/]+\/issues\/\d+(?:\/|\?|$)/.test(url);
}
