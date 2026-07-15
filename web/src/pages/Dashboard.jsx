import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, apiPost, STATUS_META, PIPELINE_ORDER, relTime } from '../api.js';
import { StatTile } from '../components.jsx';
import { useOpsContext } from '../App.jsx';

export default function Dashboard() {
  const { ops, pulse } = useOpsContext();
  const { data: stats, reload } = useApi('/stats', [pulse]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const fetchingSource = (src) =>
    ops.some((o) => o.type === 'fetch' && o.source === src && o.state === 'running');
  const analyzing = ops.filter((o) => o.type === 'analyze' && o.state === 'running').length;

  const act = async (name, fn) => {
    setBusy(name);
    setMsg('');
    try {
      const r = await fn();
      setMsg(
        name.startsWith('fetch')
          ? r.alreadyRunning
            ? 'A fetch is already running for that source.'
            : 'Fetch started — new jobs will appear as soon as Apify finishes (~1-3 min).'
          : `${r.queued} job(s) queued for analysis.`
      );
      reload();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  if (!stats) return <div className="empty">Loading…</div>;

  const funnel = PIPELINE_ORDER.map((s) => ({ status: s, n: stats.byStatus[s] || 0 }));
  const maxN = Math.max(1, ...funnel.map((f) => f.n));

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Your job search at a glance — fetched, scored, and tracked in one place.</p>

      <div className="tile-row">
        <StatTile label="Tracked jobs" value={stats.total} hint={`${stats.analyzed} analyzed`} />
        <StatTile label="Good fits" value={stats.goodFits} hint="score ≥ 4.0 — worth applying" />
        <StatTile label="Avg score" value={stats.avgScore ? stats.avgScore.toFixed(1) : '—'} hint="across latest analyses" />
        <StatTile label="Applied · 7d" value={stats.appliedThisWeek} hint={`${stats.byStatus.applied} applied total`} />
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="microlabel">Pipeline</div>
        <div className="funnel">
          {funnel.map((f) => (
            <div
              key={f.status}
              className="seg"
              title={`${STATUS_META[f.status].label}: ${f.n}`}
              style={{ flex: `${Math.max(f.n, 0.15)} 1 0`, opacity: 0.45 + 0.55 * (f.n / maxN) }}
            />
          ))}
        </div>
        <div className="funnel-labels">
          {funnel.map((f) => (
            <div key={f.status} className="fl" style={{ flex: `${Math.max(f.n, 0.15)} 1 0` }}>
              <span className="n">{f.n}</span>
              <span className="s">{STATUS_META[f.status].short}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 20 }}>
        <button
          className="btn primary"
          disabled={busy === 'fetch:linkedin' || fetchingSource('linkedin')}
          onClick={() => act('fetch:linkedin', () => apiPost('/fetch?source=linkedin'))}
        >
          {fetchingSource('linkedin') ? <span className="spinner" /> : '⟳'} Fetch LinkedIn
        </button>
        <button
          className="btn primary"
          disabled={busy === 'fetch:naukri' || fetchingSource('naukri')}
          onClick={() => act('fetch:naukri', () => apiPost('/fetch?source=naukri'))}
        >
          {fetchingSource('naukri') ? <span className="spinner" /> : '⟳'} Fetch Naukri
        </button>
        <button className="btn" disabled={busy === 'analyze'} onClick={() => act('analyze', () => apiPost('/analyze-all'))}>
          {analyzing > 0 ? <span className="spinner" /> : '◈'} Analyze all unscored
          {analyzing > 0 ? ` (${analyzing} running)` : ''}
        </button>
        <Link className="btn" to="/jobs">
          Browse jobs →
        </Link>
        {msg && <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>{msg}</span>}
      </div>

      <div className="detail-grid">
        <div className="panel">
          <h2 className="section-title">Recent activity</h2>
          <div className="activity">
            {(stats.recentEvents || []).length === 0 && <span style={{ color: 'var(--ink-3)' }}>Nothing yet — fetch or import some jobs.</span>}
            {(stats.recentEvents || []).map((e) => (
              <div className="line" key={e.id}>
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                  {relTime(e.created_at)}
                </span>
                <span>
                  {e.type.replace(/_/g, ' ')}
                  {e.company ? (
                    <>
                      {' — '}
                      <b>
                        <Link to={`/jobs/${e.job_id}`} style={{ textDecoration: 'none' }}>
                          {e.company}
                        </Link>
                      </b>
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2 className="section-title">Last fetch</h2>
          {stats.lastFetch ? (
            <div className="activity">
              <div className="line">
                <b>{stats.lastFetch.status.toUpperCase()}</b>
                {stats.lastFetch.source && <span className="mono" style={{ fontSize: 11 }}>{stats.lastFetch.source}</span>}
                <span className="mono" style={{ fontSize: 11 }}>{relTime(stats.lastFetch.started_at)}</span>
              </div>
              <div className="line">found {stats.lastFetch.found} · new {stats.lastFetch.imported} · updated {stats.lastFetch.updated}</div>
              {stats.lastFetch.error && <div className="error-line">{stats.lastFetch.error}</div>}
            </div>
          ) : (
            <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>
              No fetches yet. "Fetch new jobs" runs the same LinkedIn search your old n8n workflow did.
            </span>
          )}
        </div>
      </div>
    </>
  );
}
