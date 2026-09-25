// In-memory registry of long-running operations, for UI polling + cancellation.
import { getSettings } from './settings.mjs';

const ops = new Map();
const controllers = new Map();

/** Register an op at queue time so it can be cancelled before it even starts. */
export function opQueue(key, meta = {}) {
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  ops.set(key, { key, state: 'queued', queuedAt: new Date().toISOString(), ...meta });
  return ctrl;
}

export function opStart(key, meta = {}) {
  const prev = ops.get(key) || {};
  ops.set(key, { ...prev, key, state: 'running', startedAt: new Date().toISOString(), ...meta });
}

export function opEnd(key, state = 'done', extra = {}) {
  controllers.delete(key);
  const op = ops.get(key);
  if (op) {
    ops.set(key, { ...op, state, finishedAt: new Date().toISOString(), ...extra });
    // Keep terminal states visible briefly, then drop.
    setTimeout(() => {
      const cur = ops.get(key);
      if (cur && cur.state !== 'running') ops.delete(key);
    }, 60_000).unref?.();
  }
}

/** Abort a queued or running op. Returns false if there is nothing to cancel. */
export function cancelOp(key) {
  const ctrl = controllers.get(key);
  if (!ctrl) return false;
  const op = ops.get(key);
  if (op && ['queued', 'running'].includes(op.state)) ops.set(key, { ...op, state: 'cancelling' });
  ctrl.abort();
  return true;
}

/**
 * Abort every op still waiting for a pool slot, leaving in-flight work alone.
 * Returns the number cancelled.
 */
export function cancelQueued() {
  let n = 0;
  for (const op of [...ops.values()]) {
    if (op.state === 'queued' && cancelOp(op.key)) n += 1;
  }
  return n;
}

export function opSnapshot() {
  return [...ops.values()];
}

export function opActive(key) {
  return ['queued', 'running', 'cancelling'].includes(ops.get(key)?.state);
}

export const opRunning = opActive;

// ---------- work pool ----------
// Analyses and resume generations run through one pool, so at most
// `aiConcurrency` (default 10) `claude -p` processes are alive at a time.
// Tasks beyond that wait as `queued` ops and start as slots free up.
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 20;
const CONCURRENCY_FALLBACK = 10;

function limit() {
  const n = Number(getSettings().aiConcurrency);
  if (!Number.isFinite(n)) return CONCURRENCY_FALLBACK;
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, Math.round(n)));
}

/**
 * FIFO pool that keeps at most `limitFn()` tasks in flight. The limit is read
 * on every scheduling pass, so a Settings change applies to the current backlog
 * without a restart.
 */
export function createPool(limitFn) {
  const pending = [];
  let active = 0;

  const pump = () => {
    while (active < limitFn() && pending.length) {
      const task = pending.shift();
      active += 1;
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    /** Run `fn` once a slot is free. Resolves/rejects with fn's result. */
    add(fn) {
      return new Promise((resolve, reject) => {
        pending.push({ fn, resolve, reject });
        // Defer so a synchronous burst of adds all land before the first start.
        queueMicrotask(pump);
      });
    },
    stats() {
      return { active, pending: pending.length, limit: limitFn() };
    },
  };
}

const aiPool = createPool(limit);

/** Queue an AI task (analysis or resume generation) on the shared pool. */
export const enqueue = (fn) => aiPool.add(fn);
export const poolStats = () => aiPool.stats();
