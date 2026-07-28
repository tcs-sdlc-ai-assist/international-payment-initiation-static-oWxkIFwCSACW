/**
 * Namespaced storage gateway with in-memory fallback.
 *
 * StorageAdapter is a thin wrapper over the Web Storage API
 * (`sessionStorage`/`localStorage`) that keeps all persisted keys under a
 * consistent, versioned namespace of the form:
 *
 *   `ipi-demo:v1:{org}:{user}:{domain}`
 *
 * Every read is validated with a caller-supplied Zod schema (via the shared
 * safe-parse helpers) so malformed or tampered records never leak into the app;
 * invalid entries resolve to a fallback rather than throwing. When the backing
 * storage is unavailable (private mode, disabled storage, quota exceeded) the
 * adapter transparently degrades to an in-memory map so the demo keeps working.
 *
 * The adapter intentionally never calls `localStorage.clear()`; removal is
 * always scoped to explicit keys or to the adapter's own namespaced prefix.
 */

import {
  STORAGE_NAMESPACE,
  STORAGE_VERSION,
  buildStorageKey,
} from '@/shared/config/constants';
import { safeParseWith } from '@/shared/schemas/schemas';
import { safeLogger } from '@/shared/logging/safeLogger';

/** Sentinel used for the org/user segment when none is supplied. */
const DEFAULT_SEGMENT = 'shared';

/** Matches a safe key segment (org/user/domain) to avoid delimiter injection. */
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Supported backing store kinds.
 * @type {{ SESSION: 'session', LOCAL: 'local' }}
 */
export const STORAGE_KINDS = Object.freeze({
  SESSION: 'session',
  LOCAL: 'local',
});

/**
 * Normalizes a raw key segment into a safe, delimiter-free token.
 * @param {unknown} value - The raw segment value.
 * @param {string} fallback - Returned when the value is empty/unsafe.
 * @returns {string} A safe segment token.
 */
function normalizeSegment(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const compact = trimmed.replace(/\s+/g, '-');
  return SAFE_SEGMENT_PATTERN.test(compact) ? compact : fallback;
}

/**
 * Resolves the native storage object for a given kind, or `null` when the
 * environment does not expose it.
 * @param {string} kind - One of {@link STORAGE_KINDS}.
 * @returns {Storage | null} The native storage, or `null`.
 */
function resolveNativeStorage(kind) {
  try {
    if (typeof globalThis === 'undefined') {
      return null;
    }
    const store = kind === STORAGE_KINDS.LOCAL ? globalThis.localStorage : globalThis.sessionStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

/**
 * Probes a native storage object to confirm it is readable and writable.
 * @param {Storage | null} store - The candidate native storage.
 * @returns {boolean} `true` when the store can be used safely.
 */
function isStorageUsable(store) {
  if (!store) {
    return false;
  }
  const probeKey = `${STORAGE_NAMESPACE}:${STORAGE_VERSION}:__probe__`;
  try {
    store.setItem(probeKey, '1');
    store.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * A minimal in-memory implementation of the storage surface used as a fallback
 * when the native store is blocked or throws.
 */
class MemoryStore {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }

  /**
   * @param {string} key - The key to read.
   * @returns {string | null} The stored value, or `null`.
   */
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  /**
   * @param {string} key - The key to write.
   * @param {string} value - The value to store.
   * @returns {void}
   */
  setItem(key, value) {
    this.map.set(key, value);
  }

  /**
   * @param {string} key - The key to remove.
   * @returns {void}
   */
  removeItem(key) {
    this.map.delete(key);
  }

  /**
   * @returns {number} The number of stored entries.
   */
  get length() {
    return this.map.size;
  }

  /**
   * @param {number} index - The entry index.
   * @returns {string | null} The key at `index`, or `null`.
   */
  key(index) {
    if (index < 0 || index >= this.map.size) {
      return null;
    }
    let cursor = 0;
    for (const key of this.map.keys()) {
      if (cursor === index) {
        return key;
      }
      cursor += 1;
    }
    return null;
  }
}

/**
 * A namespaced storage gateway with Zod-validated reads and in-memory fallback.
 */
export class StorageAdapter {
  /**
   * @param {{
   *   kind?: string,
   *   org?: string,
   *   user?: string,
   *   store?: Storage,
   * }} [options] - Adapter options.
   */
  constructor(options) {
    const source = options ?? {};
    this.kind = source.kind === STORAGE_KINDS.LOCAL ? STORAGE_KINDS.LOCAL : STORAGE_KINDS.SESSION;
    this.org = normalizeSegment(source.org, DEFAULT_SEGMENT);
    this.user = normalizeSegment(source.user, DEFAULT_SEGMENT);

    const injected = source.store ?? null;
    const native = injected ?? resolveNativeStorage(this.kind);

    if (isStorageUsable(native)) {
      /** @type {Storage | MemoryStore} */
      this.store = native;
      /** @type {boolean} */
      this.usingMemory = false;
    } else {
      this.store = new MemoryStore();
      this.usingMemory = true;
      safeLogger.warn('storageAdapter: native storage unavailable; using in-memory fallback', {
        kind: this.kind,
      });
    }

    /** Fully-qualified prefix shared by all keys managed by this adapter. */
    this.prefix = `${this.org}:${this.user}`;
  }

  /**
   * Whether this adapter is currently degraded to the in-memory fallback.
   * @returns {boolean} `true` when using the memory fallback.
   */
  isInMemory() {
    return this.usingMemory;
  }

  /**
   * Builds a fully-qualified storage key for a domain suffix.
   * @param {string} domain - A domain suffix (typically from STORAGE_DOMAINS).
   * @returns {string} The namespaced key (`ipi-demo:{org}:{user}:{domain}`).
   */
  buildKey(domain) {
    const safeDomain = normalizeSegment(domain, DEFAULT_SEGMENT);
    return buildStorageKey(`${this.prefix}:${safeDomain}`);
  }

  /**
   * Switches the active store to the in-memory fallback, preserving nothing.
   * @returns {void}
   */
  degradeToMemory() {
    if (!this.usingMemory) {
      this.store = new MemoryStore();
      this.usingMemory = true;
      safeLogger.warn('storageAdapter: degraded to in-memory fallback', { kind: this.kind });
    }
  }

  /**
   * Reads and validates a value for the given domain.
   * @template T
   * @param {string} domain - The domain suffix.
   * @param {import('zod').ZodType<T>} schema - Schema to validate the value.
   * @param {T} [fallback] - Value returned when missing or invalid.
   * @returns {T | undefined} The validated value, or `fallback`.
   */
  read(domain, schema, fallback) {
    const key = this.buildKey(domain);
    let raw;
    try {
      raw = this.store.getItem(key);
    } catch (error) {
      safeLogger.warn('storageAdapter: read failed; degrading to memory', {
        kind: this.kind,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      this.degradeToMemory();
      return fallback;
    }

    if (raw === null || raw === undefined) {
      return fallback;
    }

    let parsedJson;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      safeLogger.warn('storageAdapter: stored value is not valid JSON', { kind: this.kind });
      return fallback;
    }

    const result = safeParseWith(schema, parsedJson);
    if (!result.ok) {
      safeLogger.warn('storageAdapter: stored value failed schema validation', {
        kind: this.kind,
        reason: result.error,
      });
      return fallback;
    }
    return result.value;
  }

  /**
   * Serializes and writes a value for the given domain.
   * @param {string} domain - The domain suffix.
   * @param {unknown} value - The value to persist.
   * @returns {boolean} `true` when the write succeeded.
   */
  write(domain, value) {
    const key = this.buildKey(domain);
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      safeLogger.error('storageAdapter: value could not be serialized', { kind: this.kind });
      return false;
    }

    try {
      this.store.setItem(key, serialized);
      return true;
    } catch (error) {
      safeLogger.warn('storageAdapter: write failed; retrying in memory', {
        kind: this.kind,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      this.degradeToMemory();
      try {
        this.store.setItem(key, serialized);
        return true;
      } catch {
        safeLogger.error('storageAdapter: in-memory write failed', { kind: this.kind });
        return false;
      }
    }
  }

  /**
   * Removes the value stored for the given domain.
   * @param {string} domain - The domain suffix.
   * @returns {boolean} `true` when the removal succeeded.
   */
  remove(domain) {
    const key = this.buildKey(domain);
    try {
      this.store.removeItem(key);
      return true;
    } catch (error) {
      safeLogger.warn('storageAdapter: remove failed; degrading to memory', {
        kind: this.kind,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      this.degradeToMemory();
      try {
        this.store.removeItem(key);
        return true;
      } catch {
        safeLogger.error('storageAdapter: in-memory remove failed', { kind: this.kind });
        return false;
      }
    }
  }

  /**
   * Enumerates all fully-qualified keys managed by this adapter's prefix.
   * @returns {string[]} The matching namespaced keys.
   */
  keys() {
    const prefix = buildStorageKey(`${this.prefix}:`);
    const output = [];
    try {
      const total = this.store.length;
      for (let index = 0; index < total; index += 1) {
        const key = this.store.key(index);
        if (typeof key === 'string' && key.startsWith(prefix)) {
          output.push(key);
        }
      }
    } catch (error) {
      safeLogger.warn('storageAdapter: enumeration failed', {
        kind: this.kind,
        reason: error instanceof Error ? error.name : 'unknown',
      });
    }
    return output;
  }

  /**
   * Removes every key managed by this adapter's prefix. Never calls
   * `Storage.clear()`, so keys outside the adapter's namespace are untouched.
   * @returns {number} The number of keys removed.
   */
  clearNamespace() {
    const matching = this.keys();
    let removed = 0;
    for (const key of matching) {
      try {
        this.store.removeItem(key);
        removed += 1;
      } catch {
        safeLogger.warn('storageAdapter: failed to remove key during namespace clear', {
          kind: this.kind,
        });
      }
    }
    return removed;
  }
}

/**
 * Creates a session-scoped storage adapter.
 * @param {{ org?: string, user?: string, store?: Storage }} [options] - Adapter options.
 * @returns {StorageAdapter} A configured session adapter.
 */
export function createSessionStorageAdapter(options) {
  return new StorageAdapter({ ...(options ?? {}), kind: STORAGE_KINDS.SESSION });
}

/**
 * Creates a local-scoped storage adapter.
 * @param {{ org?: string, user?: string, store?: Storage }} [options] - Adapter options.
 * @returns {StorageAdapter} A configured local adapter.
 */
export function createLocalStorageAdapter(options) {
  return new StorageAdapter({ ...(options ?? {}), kind: STORAGE_KINDS.LOCAL });
}

/**
 * The storage adapter contract, exposed as a single frozen object.
 * @type {{
 *   StorageAdapter: typeof StorageAdapter,
 *   createSessionStorageAdapter: typeof createSessionStorageAdapter,
 *   createLocalStorageAdapter: typeof createLocalStorageAdapter,
 *   STORAGE_KINDS: typeof STORAGE_KINDS,
 * }}
 */
export const storageAdapter = Object.freeze({
  StorageAdapter,
  createSessionStorageAdapter,
  createLocalStorageAdapter,
  STORAGE_KINDS,
});

export default storageAdapter;