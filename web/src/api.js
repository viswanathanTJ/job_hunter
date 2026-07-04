import { useCallback, useEffect, useRef, useState } from 'react';

async function handle(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const apiGet = (path) => fetch(`/api${path}`).then(handle);
export const apiPost = (path, body) =>
  fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(handle);
export const apiPatch = (path, body) =>
  fetch(`/api${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(handle);

/** Generic data hook with manual + automatic (pulse) refresh. */
export function useApi(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    let alive = true;
    apiGet(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => reload(), [reload]);
  return { data, error, loading, reload };
}

/**
 * Polls /api/ops. `pulse` increments whenever an operation finishes,
 * letting views refetch exactly when background work lands.
 */
export function useOps() {
  const [ops, setOps] = useState([]);
  const [pulse, setPulse] = useState(0);
  const prevRunning = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const snapshot = await apiGet('/ops');
        if (!alive) return;
        setOps(snapshot);
        const running = snapshot.filter((o) => o.state === 'running').length;
        if (running < prevRunning.current) setPulse((p) => p + 1);
        prevRunning.current = running;
      } catch {}
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return { ops, pulse };
}

export const STATUS_META = {
  new: { label: 'New', short: 'NEW' },
  reviewed: { label: 'Reviewed', short: 'RVW' },
  resume_generated: { label: 'Resume Ready', short: 'CV' },
  ready_to_apply: { label: 'Ready to Apply', short: 'RDY' },
  applied: { label: 'Applied', short: 'APP' },
  rejected: { label: 'Rejected', short: 'REJ' },
  discarded: { label: 'Discarded', short: 'DIS' },
};

export const PIPELINE_ORDER = [
  'new',
  'reviewed',
  'resume_generated',
  'ready_to_apply',
  'applied',
  'rejected',
];

export function scoreTier(score) {
  if (score == null) return 'none';
  if (score >= 4) return 'good';
  if (score >= 3) return 'warn';
  return 'bad';
}

export function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
