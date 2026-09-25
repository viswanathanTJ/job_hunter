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
export const apiPut = (path, body) =>
  fetch(`/api${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(handle);
export const apiDelete = (path) => fetch(`/api${path}`, { method: 'DELETE' }).then(handle);

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

// Posting dates come in three flavours: a full ISO timestamp (the source knew
// the time), a plain YYYY-MM-DD (it only knew the day), or a raw label it never
// managed to parse. Render each at the precision it actually has.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]/;

function parsePosted(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (DATE_ONLY.test(s)) return { at: new Date(`${s}T00:00:00`), dayOnly: true };
  if (DATE_TIME.test(s)) {
    const at = new Date(s.replace(' ', 'T'));
    return Number.isNaN(at.getTime()) ? null : { at, dayOnly: false };
  }
  return null;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const absDate = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** "just now" · "5m ago" · "3h ago" · "yesterday" · "12 Aug 2026". */
export function postedLabel(v) {
  const p = parsePosted(v);
  if (!p) return v ? String(v) : ''; // Unparseable label — show it verbatim.
  const days = Math.round((startOfDay(new Date()) - startOfDay(p.at)) / 86400000);
  if (p.dayOnly) {
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return absDate(p.at);
  }
  const s = (Date.now() - p.at.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (days < 7) return days === 1 ? 'yesterday' : `${days}d ago`;
  return absDate(p.at);
}

/** Exact posting time for a tooltip, so the relative label stays checkable. */
export function postedExact(v) {
  const p = parsePosted(v);
  if (!p) return v ? String(v) : '';
  return p.dayOnly ? absDate(p.at) : `${absDate(p.at)}, ${p.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
