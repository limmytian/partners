import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

/**
 * WarmPoolManager maintains a pool of pre-warmed sandbox sessions
 * to eliminate cold start queue latency, enabling < 500ms session acquisition.
 */
export class WarmPoolManager {
  /**
   * @param {Object} options
   * @param {Object} options.provider - Sandbox provider (e.g. LocalSandboxProvider, CubeSandboxProvider)
   * @param {number} [options.poolSize=2] - Target warm instances per pool profile
   * @param {number} [options.maxPoolSize=10] - Max total warm instances across all profiles
   * @param {Object} [options.defaultSandbox] - Default sandbox profile to prewarm
   * @param {boolean} [options.autoRefill=true] - Refill pool in background when drained
   * @param {Object} [options.metrics] - Metrics collector
   */
  constructor({
    provider,
    poolSize = 2,
    maxPoolSize = 10,
    defaultSandbox = {},
    autoRefill = true,
    metrics = null,
  } = {}) {
    if (!provider?.createSession) {
      throw new TypeError('WarmPoolManager requires a provider with createSession');
    }

    this.provider = provider;
    this.targetPoolSize = Math.max(0, poolSize);
    this.maxPoolSize = Math.max(this.targetPoolSize, maxPoolSize);
    this.defaultSandbox = defaultSandbox;
    this.autoRefill = autoRefill;
    this.metrics = metrics;

    // profileKey -> Array<PrewarmedSession>
    this.pools = new Map();
    this.isWarming = false;
    this.stats = {
      hits: 0,
      misses: 0,
      totalWarmed: 0,
      totalEvicted: 0,
    };
  }

  get totalWarmCount() {
    let count = 0;
    for (const list of this.pools.values()) {
      count += list.length;
    }
    return count;
  }

  /**
   * Prewarms the pool up to targetPoolSize
   */
  async warmUp({ profileKey = 'default', sandbox = this.defaultSandbox, count = this.targetPoolSize } = {}) {
    const currentList = this.pools.get(profileKey) ?? [];
    const needed = Math.min(count - currentList.length, this.maxPoolSize - this.totalWarmCount);
    if (needed <= 0) return;

    for (let i = 0; i < needed; i++) {
      const start = performance.now();
      const session = await this.provider.createSession({
        sandbox,
        metadata: {
          warmPool: true,
          profileKey,
          warmedAt: new Date().toISOString(),
        },
      });
      const durationMs = Number((performance.now() - start).toFixed(2));
      const entry = {
        session,
        profileKey,
        sandbox,
        durationMs,
        readyAt: Date.now(),
      };
      const list = this.pools.get(profileKey) ?? [];
      list.push(entry);
      this.pools.set(profileKey, list);
      this.stats.totalWarmed += 1;
      this.metrics?.recordWarmInstanceCreated?.({ profileKey, durationMs });
    }
  }

  /**
   * Acquires a prewarmed session from the pool.
   * If a matching warm session is available, binds it to the request and returns within < 50ms.
   * If no warm session is available, falls back to standard provider creation (cache miss).
   */
  async acquireSession(request = {}) {
    // If request specifies snapshotId or templateId, dedicated restoration is required
    if (request.snapshotId || request.templateId) {
      this.stats.misses += 1;
      return this.provider.createSession(request);
    }

    const profileKey = request.sandbox?.profile ?? 'default';
    const list = this.pools.get(profileKey) ?? [];

    if (list.length > 0) {
      const entry = list.shift();
      this.stats.hits += 1;

      // Re-bind warm session metadata and ownership to request
      const session = entry.session;
      const bindStart = performance.now();
      session.tenantId = request.tenantId ?? null;
      session.projectId = request.projectId ?? null;
      session.metadata = {
        ...(session.metadata ?? {}),
        ...(request.metadata ?? {}),
        acquiredFromWarmPool: true,
        warmAcquireLatencyMs: Number((performance.now() - bindStart).toFixed(2)),
      };
      session.updatedAt = new Date().toISOString();

      this.metrics?.recordWarmPoolHit?.({ profileKey, latencyMs: session.metadata.warmAcquireLatencyMs });

      // Trigger asynchronous background refill if enabled
      if (this.autoRefill && list.length < this.targetPoolSize) {
        queueMicrotask(() => {
          this.warmUp({ profileKey, sandbox: entry.sandbox }).catch(() => {});
        });
      }

      return session;
    }

    // Cache miss: fall back to provider creation
    this.stats.misses += 1;
    this.metrics?.recordWarmPoolMiss?.({ profileKey });
    const freshSession = await this.provider.createSession(request);

    // If pool was empty, trigger refill
    if (this.autoRefill && (this.pools.get(profileKey)?.length ?? 0) < this.targetPoolSize) {
      queueMicrotask(() => {
        this.warmUp({ profileKey, sandbox: request.sandbox ?? this.defaultSandbox }).catch(() => {});
      });
    }

    return freshSession;
  }

  /**
   * Drain and destroy all prewarmed sessions in the pool
   */
  async drain() {
    for (const [key, list] of this.pools.entries()) {
      while (list.length > 0) {
        const entry = list.pop();
        if (this.provider.deleteSession) {
          try {
            await this.provider.deleteSession(entry.session.id);
            this.stats.totalEvicted += 1;
          } catch {}
        }
      }
    }
    this.pools.clear();
  }

  getStats() {
    return {
      totalWarm: this.totalWarmCount,
      ...this.stats,
      pools: Object.fromEntries(
        [...this.pools.entries()].map(([k, v]) => [k, v.length])
      ),
    };
  }
}
