// In-memory registry of long-running operations, for UI polling + cancellation.
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

export function opSnapshot() {
  return [...ops.values()];
}

export function opActive(key) {
  return ['queued', 'running', 'cancelling'].includes(ops.get(key)?.state);
}

export const opRunning = opActive;

// Sequential queue so we never run parallel `claude -p` spawns.
let chain = Promise.resolve();
export function enqueue(fn) {
  const run = () => fn();
  const p = chain.then(run, run);
  chain = p.then(
    () => {},
    () => {}
  );
  return p;
}
