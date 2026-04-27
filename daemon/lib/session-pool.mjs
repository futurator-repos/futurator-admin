// Pipeline v1 — Epic 2, Story 2.1. SessionPool admission control.
//
// Centralizes every Claude spawn through a single class so concurrent
// requests queue instead of self-inflicting 429s. Three slot classes:
//
//   - 'interactive' — operator-driven (party-turn, agent-turn). Has reserved
//     slots; never waits behind background work. Fails fast on saturation.
//   - 'critical'    — pipeline steps in the operator-focused plan.
//     Priority over background; 5-min timeout escalates to attention item.
//   - 'background'  — every other pipeline step. FIFO, waits indefinitely.
//
// Floating-pool model:
//   total ceiling = MAX_CONCURRENT_TOTAL (env, default 2)
//   reserved interactive = MAX_CONCURRENT_INTERACTIVE_RESERVED (env, default 1)
//   critical + background share the remainder, with critical priority.
//
// In-memory state. On daemon restart, callers should walk RUNNING jobs in
// DDB and re-register their tokens via `registerExisting()` so the pool's
// view of "in-flight" matches reality (Story 2.1 AC#5).

import { EventEmitter } from 'node:events';

export const SLOT_CLASSES = Object.freeze(['interactive', 'critical', 'background']);

const DEFAULTS = {
  MAX_CONCURRENT_TOTAL: 2,
  MAX_CONCURRENT_INTERACTIVE_RESERVED: 1,
  INTERACTIVE_QUEUE_TIMEOUT_MS: 30_000,
  CRITICAL_QUEUE_TIMEOUT_MS: 5 * 60_000,
};

function envInt(name, fallback) {
  const raw = process.env?.[name];
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

let _idCounter = 0;
function nextTokenId() {
  _idCounter += 1;
  return `tk-${Date.now().toString(36)}-${_idCounter}`;
}

export class CapacitySaturated extends Error {
  constructor(slotClass, queueDepth) {
    super(`SessionPool: ${slotClass} queue saturated (depth=${queueDepth})`);
    this.name = 'CapacitySaturated';
    this.slotClass = slotClass;
    this.queueDepth = queueDepth;
  }
}

export class CapacityTimeout extends Error {
  constructor(slotClass, waitedMs) {
    super(`SessionPool: ${slotClass} acquire timed out after ${waitedMs}ms`);
    this.name = 'CapacityTimeout';
    this.slotClass = slotClass;
    this.waitedMs = waitedMs;
  }
}

export class SessionPool extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.maxTotal = opts.maxTotal ?? envInt('MAX_CONCURRENT_TOTAL', DEFAULTS.MAX_CONCURRENT_TOTAL);
    this.maxInteractiveReserved =
      opts.maxInteractiveReserved ??
      envInt('MAX_CONCURRENT_INTERACTIVE_RESERVED', DEFAULTS.MAX_CONCURRENT_INTERACTIVE_RESERVED);
    this.interactiveTimeoutMs = opts.interactiveTimeoutMs ?? DEFAULTS.INTERACTIVE_QUEUE_TIMEOUT_MS;
    this.criticalTimeoutMs = opts.criticalTimeoutMs ?? DEFAULTS.CRITICAL_QUEUE_TIMEOUT_MS;
    /** @type {Map<string, { token: object, slotClass: string }>} */
    this.active = new Map();
    /** @type {Array<{ slotClass: string, meta: object, resolve: Function, reject: Function, queuedAt: number, timeoutHandle?: any }>} */
    this.queue = [];
  }

  /**
   * Compute slots used per class from the active map.
   */
  _used() {
    const counts = { interactive: 0, critical: 0, background: 0 };
    for (const { slotClass } of this.active.values()) {
      counts[slotClass] = (counts[slotClass] || 0) + 1;
    }
    return counts;
  }

  /**
   * Decide if a request of the given class can be admitted right now.
   * Floating-pool rules:
   *   - interactive: succeeds if reserved-interactive isn't already at cap,
   *                  OR there's overall headroom and interactive < total.
   *   - critical:    succeeds if total used + reserved-headroom-for-int <= maxTotal
   *                  i.e. don't starve the interactive reserve.
   *   - background:  succeeds only when critical wouldn't be blocked by
   *                  taking this slot (use a strict "no critical waiting" rule)
   *                  AND the interactive reserve would still be honored.
   */
  _canAdmit(slotClass) {
    const used = this._used();
    const usedTotal = used.interactive + used.critical + used.background;
    if (usedTotal >= this.maxTotal) return false;

    if (slotClass === 'interactive') {
      // Honor the reserve.
      return used.interactive < this.maxInteractiveReserved
        ? true
        : usedTotal < this.maxTotal;
    }
    // critical + background must leave room for the interactive reserve.
    const nonInteractiveBudget = Math.max(0, this.maxTotal - this.maxInteractiveReserved);
    const usedNonInteractive = used.critical + used.background;
    if (slotClass === 'critical') {
      return usedNonInteractive < nonInteractiveBudget;
    }
    // background: critical has priority — don't take a slot if a critical is waiting.
    if (this.queue.some((w) => w.slotClass === 'critical')) return false;
    return usedNonInteractive < nonInteractiveBudget;
  }

  /**
   * Acquire a slot. Resolves with a token once admitted. Rejects with
   * `CapacitySaturated` (interactive only after timeout) or `CapacityTimeout`
   * (critical, after 5 min) per the queue policy. Background waits forever.
   */
  acquire(slotClass, meta = {}) {
    if (!SLOT_CLASSES.includes(slotClass)) {
      return Promise.reject(new Error(`SessionPool: unknown slotClass ${slotClass}`));
    }

    if (this._canAdmit(slotClass)) {
      const token = this._mkToken(slotClass, meta);
      return Promise.resolve(token);
    }

    // Queue + maybe timeout.
    return new Promise((resolve, reject) => {
      const waiter = {
        slotClass,
        meta,
        resolve,
        reject,
        queuedAt: Date.now(),
        timeoutHandle: undefined,
      };

      const timeoutMs =
        slotClass === 'interactive'
          ? this.interactiveTimeoutMs
          : slotClass === 'critical'
            ? this.criticalTimeoutMs
            : 0;
      if (timeoutMs > 0) {
        waiter.timeoutHandle = setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx !== -1) this.queue.splice(idx, 1);
          if (slotClass === 'interactive') {
            reject(new CapacitySaturated(slotClass, this.queue.length));
          } else {
            reject(new CapacityTimeout(slotClass, Date.now() - waiter.queuedAt));
          }
          this.emit('queue_changed', { reason: 'timeout', slotClass });
        }, timeoutMs);
      }

      this.queue.push(waiter);
      this.emit('queue_changed', { reason: 'enqueued', slotClass });
    });
  }

  _mkToken(slotClass, meta) {
    const token = {
      id: nextTokenId(),
      class: slotClass,
      jobId: meta.jobId,
      stepId: meta.stepId,
      planId: meta.planId,
      acquiredAt: new Date().toISOString(),
    };
    this.active.set(token.id, { token, slotClass });
    this.emit('queue_changed', { reason: 'acquired', slotClass, tokenId: token.id });
    return token;
  }

  release(token) {
    if (!token || !this.active.has(token.id)) return;
    const { slotClass } = this.active.get(token.id);
    this.active.delete(token.id);
    this.emit('slot_freed', { slotClass, tokenId: token.id });

    // Drain queue in priority order: critical first, then background, then interactive.
    // (interactive only queues when even the reserve is taken — rare; treat
    // it like the others.)
    this._drain();
  }

  _drain() {
    // Loop until no more waiters can be admitted.
    let drainedAny;
    do {
      drainedAny = false;
      const ordered = this._priorityOrderedQueue();
      for (const waiter of ordered) {
        if (this._canAdmit(waiter.slotClass)) {
          const idx = this.queue.indexOf(waiter);
          if (idx !== -1) this.queue.splice(idx, 1);
          if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
          const token = this._mkToken(waiter.slotClass, waiter.meta);
          waiter.resolve(token);
          drainedAny = true;
          break; // restart with fresh ordering
        }
      }
    } while (drainedAny);
  }

  _priorityOrderedQueue() {
    const order = { interactive: 0, critical: 1, background: 2 };
    return this.queue.slice().sort((a, b) => {
      const r = order[a.slotClass] - order[b.slotClass];
      if (r !== 0) return r;
      return a.queuedAt - b.queuedAt;
    });
  }

  /**
   * Story 2.6: snapshot for the /api/health/concurrency endpoint.
   */
  predict() {
    const used = this._used();
    const total = used.interactive + used.critical + used.background;
    return {
      ceiling: this.maxTotal,
      reservedInteractive: this.maxInteractiveReserved,
      slotsByClass: {
        interactive: { used: used.interactive, max: this.maxInteractiveReserved },
        critical: { used: used.critical },
        background: { used: used.background },
      },
      freeSlots: {
        interactive: Math.max(0, this.maxInteractiveReserved - used.interactive),
        critical: Math.max(0, this.maxTotal - total),
        background: Math.max(0, this.maxTotal - this.maxInteractiveReserved - used.critical - used.background),
      },
      queueDepth: this.queue.length,
      activeTokens: Array.from(this.active.values()).map(({ token }) => token),
      queued: this.queue.map((w) => ({
        slotClass: w.slotClass,
        ...w.meta,
        queuedAt: new Date(w.queuedAt).toISOString(),
      })),
    };
  }

  /**
   * Story 2.1 AC#5 — daemon-restart recovery. Caller (daemon startup) walks
   * `RUNNING` jobs in DDB and re-registers each one's token here so the
   * pool's view matches reality.
   */
  registerExisting(slotClass, meta) {
    return this._mkToken(slotClass, meta);
  }

  /**
   * Story 6.3 — promote a queued waiter from one class to another. If
   * the waiter is in `from`, replaces its slotClass with `to` and re-orders
   * the priority queue. Returns true if a promotion was applied.
   */
  promoteQueued(jobId, from, to) {
    if (!SLOT_CLASSES.includes(to)) return false;
    const waiter = this.queue.find((w) => w.slotClass === from && w.meta?.jobId === jobId);
    if (!waiter) return false;
    waiter.slotClass = to;
    this.emit('queue_changed', { reason: 'promoted', jobId, from, to });
    this._drain();
    return true;
  }
}
