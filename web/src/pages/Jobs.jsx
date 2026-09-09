import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useApi, apiPost, STATUS_META, relTime } from '../api.js';
import { StatusBadge, ScoreChip, SourceBadge } from '../components.jsx';
import { useOpsContext } from '../App.jsx';

/** Filters live in the URL so back-navigation (and reload, and sharing) keeps them. */
export const JOBS_FILTER_KEY = 'jobs:filters';

export default function Jobs() {
  const { ops, pulse } = useOpsContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') || '';
  const status = searchParams.get('status') || '';
  const minScore = searchParams.get('minScore') || '';
  const sort = searchParams.get('sort') || 'created';

  // Local draft keeps typing snappy; the URL is updated on a short debounce.
  const [qDraft, setQDraft] = useState(q);
  useEffect(() => setQDraft(q), [q]); // external URL change (back/forward) wins

  // Reads the live URL rather than a render snapshot, so a debounced search write
  // can't clobber a filter that changed while the timer was pending.
  const setFilter = (key, value) => {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    if (qDraft === q) return;
    const t = setTimeout(() => setFilter('q', qDraft), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft, q]);

  // Remembered so the "← jobs" link on a job detail page returns to these filters.
  const search = searchParams.toString();
  useEffect(() => {
    try {
      sessionStorage.setItem(JOBS_FILTER_KEY, search);
    } catch {}
  }, [search]);

  const [showAdd, setShowAdd] = useState(false);
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);

  const addJob = async () => {
    if (!addUrl.trim()) return;
    setAdding(true);
    try {
      const r = await apiPost('/jobs/add', { url: addUrl.trim() });
      setAddUrl('');
      setShowAdd(false);
      navigate(`/jobs/${r.job.id}`);
    } catch (e) {
      alert(e.message);
    } finally {
      setAdding(false);
    }
  };

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (minScore) params.set('minScore', minScore);
  params.set('sort', sort);

  const { data: jobs } = useApi(`/jobs?${params.toString()}`, [pulse]);
  const runningFor = (id) => ops.find((o) => o.jobId === id && ['running', 'queued', 'cancelling'].includes(o.state));
  const hasFilters = Boolean(q || status || minScore || sort !== 'created');

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Jobs</h1>
        <p className="page-sub">Everything fetched or imported — search, filter, and drill in.</p>

        <div className="toolbar">
          <button className="btn" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? 'Cancel' : '+ Add Job URL'}
          </button>
        </div>

        {showAdd && (
          <div className="toolbar" style={{ alignItems: 'center' }}>
            <input
              className="input grow"
              placeholder="Paste a job posting URL (Workday, Greenhouse, Lever, Ashby, or any job page)…"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addJob()}
            />
            <button className="btn" disabled={adding} onClick={addJob}>
              {adding ? 'Fetching…' : 'Add & Analyze'}
            </button>
          </div>
        )}

        <div className="toolbar">
          <input
            className="input grow"
            placeholder="Search title, company, location, description…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
          />
          <select className="input" value={status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <select className="input" value={minScore} onChange={(e) => setFilter('minScore', e.target.value)}>
            <option value="">Any score</option>
            <option value="4">≥ 4.0 (good fits)</option>
            <option value="3">≥ 3.0</option>
          </select>
          <select className="input" value={sort} onChange={(e) => setFilter('sort', e.target.value)}>
            <option value="created">Newest first</option>
            <option value="score">By score</option>
            <option value="company">By company</option>
            <option value="posted">By posted date</option>
            <option value="updated">Recently updated</option>
          </select>
          {hasFilters && (
            <button className="btn small" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
              Clear filters
            </button>
          )}
          {jobs && <span className="result-count mono">{jobs.length} shown</span>}
        </div>
      </div>

      <div className="scroll-box job-rows">
        {!jobs && <div className="empty">Loading…</div>}
        {jobs && jobs.length === 0 && <div className="empty">No jobs match. Try clearing filters, or fetch new jobs from the dashboard.</div>}
        {(jobs || []).map((j) => {
          const op = runningFor(j.id);
          return (
            <Link className="job-row" to={`/jobs/${j.id}`} key={j.id}>
              <div>
                <div className="title">{j.title}</div>
                <div className="meta">
                  <SourceBadge source={j.source} />
                  <b>{j.company}</b>
                  {j.location && <span>· {j.location}</span>}
                  {j.posted_at && <span>· posted {j.posted_at}</span>}
                  {j.resume_count > 0 && <span className="tag">CV ×{j.resume_count}</span>}
                  {(j.tags || []).map((t) => (
                    <span className="tag" key={t}>
                      #{t}
                    </span>
                  ))}
                  {op && (
                    <span style={{ color: 'var(--accent)' }}>
                      <span className="spinner" /> {op.type === 'analyze' ? 'analyzing…' : 'generating resume…'}
                    </span>
                  )}
                </div>
              </div>
              <div className="right">
                <ScoreChip score={j.score} verdict={j.verdict} />
                <StatusBadge status={j.status} />
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                  {relTime(j.created_at)}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
