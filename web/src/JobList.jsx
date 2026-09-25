import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, apiGet, apiPost, STATUS_META, relTime, postedLabel, postedExact } from './api.js';
import { sortJobs, SORT_LABELS, SORT_PRESETS } from './sort.js';
import {
  StatusBadge, ScoreChip, SourceBadge, AgeFilter, FacetBadges, StrengthMeter, SortEditor, TierBadge, CompanyLink,
} from './components.jsx';
import { useOpsContext } from './App.jsx';

const PAGE_SIZES = [10, 25, 50, 100, 0]; // 0 = show everything
const SORT_OPTIONS = ['priority', 'tier', 'created', 'score', 'strength', 'company', 'posted', 'updated'];
const THRESHOLDS = [
  { label: '\u2265 4.0', value: 4 },
  { label: '\u2265 3.0', value: 3 },
  { label: 'any score', value: 0 },
];

/**
 * The job list — filters, selection, bulk actions and rows. Shared by the Jobs
 * page and a company's detail page so both behave identically; `path` decides
 * which endpoint backs it, and `storageKey` keeps their sort preferences apart.
 */
export default function JobList({ path = '/jobs', storageKey = 'jobs', showCompanyPicker = true, onChanged }) {
  const { ops, pulse } = useOpsContext();
  const SORT_STORE = `${storageKey}.sortKeys`;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [minScore, setMinScore] = useState('');
  const [tier, setTier] = useState('');
  const [maxYoe, setMaxYoe] = useState('');
  const [view, setView] = useState('active'); // active | ignored | all
  const [matched, setMatched] = useState('1'); // profile matches vs stored-only rows
  const [companyPick, setCompanyPick] = useState('');
  const [age, setAge] = useState({ within: '', withinBy: 'posted' });
  const [sort, setSort] = useState('priority');
  // A hand-ordered key list overrides the preset dropdown; kept across reloads.
  const [customSort, setCustomSort] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SORT_STORE) || 'null');
      return Array.isArray(saved) && saved.length ? saved : null;
    } catch {
      return null;
    }
  });
  const [editSort, setEditSort] = useState(false);
  const [selected, setSelected] = useState([]);
  const [anchor, setAnchor] = useState(null); // last row clicked, for shift-ranges
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [threshold, setThreshold] = useState(4);
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(0);

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (minScore) params.set('minScore', minScore);
  if (tier) params.set('tier', tier);
  if (maxYoe) params.set('maxYoe', maxYoe);
  if (view !== 'active') params.set('ignored', view === 'ignored' ? '1' : 'all');
  if (matched !== '1') params.set('matched', matched);
  if (showCompanyPicker && companyPick) params.set('company', companyPick);
  if (age.within) {
    params.set('within', age.within);
    params.set('withinBy', age.withinBy);
  }
  if (pageSize) {
    params.set('limit', String(pageSize));
    params.set('offset', String(page * pageSize));
  }
  const query = params.toString();

  const { data: payload, reload } = useApi(`${path}?${query}`, [pulse]);
  const jobs = payload?.rows;
  const total = payload?.total ?? 0;
  const { data: companies } = useApi(showCompanyPicker ? `/company-names?matched=${matched}` : '/company-names?matched=all', [pulse]);
  const rows = useMemo(() => sortJobs(jobs || [], customSort || sort), [jobs, sort, customSort]);

  // Paging is over the sorted result, so "top 10" means the ten that your sort
  // actually ranks highest — not the first ten the database happened to return.
  const pageCount = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const current = Math.min(page, pageCount - 1);
  const pageRows = pageSize ? rows.slice(current * pageSize, current * pageSize + pageSize) : rows;

  const applyCustomSort = (keys) => {
    setCustomSort(keys);
    try {
      localStorage.setItem(SORT_STORE, JSON.stringify(keys));
    } catch {
      /* private windows and blocked storage just lose the preference */
    }
  };
  const runningFor = (id) => ops.find((o) => o.jobId === id && ['running', 'queued', 'cancelling'].includes(o.state));

  // Acting on rows you can no longer see would be a nasty surprise, so a change
  // of filters drops the selection rather than carrying it along invisibly.
  // Changing what we are looking at resets to the first page and drops a
  // selection that may no longer be on screen. `page` is excluded on purpose.
  const filterKey = [q, status, minScore, tier, maxYoe, view, matched, companyPick, age.within, age.withinBy].join('|');
  useEffect(() => {
    setSelected([]);
    setAnchor(null);
    setPage(0);
  }, [filterKey, pageSize]);

  const selectedSet = new Set(selected);
  const allShown = pageRows.length > 0 && pageRows.every((j) => selectedSet.has(j.id));

  // Shift-click extends from the last row you clicked to this one, applying
  // that row's new state across the range — the usual file-list behaviour.
  const toggle = (id, shiftKey) => {
    const index = pageRows.findIndex((j) => j.id === id);
    if (shiftKey && anchor !== null && index !== -1) {
      const from = pageRows.findIndex((j) => j.id === anchor);
      if (from !== -1) {
        const [lo, hi] = from < index ? [from, index] : [index, from];
        const range = pageRows.slice(lo, hi + 1).map((j) => j.id);
        const turningOn = !selectedSet.has(id);
        setSelected((prev) =>
          turningOn ? [...new Set([...prev, ...range])] : prev.filter((x) => !range.includes(x))
        );
        setAnchor(id);
        return;
      }
    }
    setAnchor(id);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleAll = () => {
    setAnchor(null);
    setSelected(allShown ? [] : pageRows.map((j) => j.id));
  };

  const runBulk = async (action, opts = {}) => {
    setBusy(true);
    setNotice('');
    try {
      const r = await apiPost('/jobs/bulk', { ids: selected, action, ...opts });
      const parts = [];
      if (r.changed) parts.push(`${r.changed} moved`);
      if (r.queued) parts.push(`${r.queued} queued`);
      if (r.skipped) {
        const why = [...new Set(r.results.filter((x) => x.skipped).map((x) => x.reason))].join('; ');
        parts.push(`${r.skipped} skipped (${why})`);
      }
      setNotice(parts.join(' · ') || 'Nothing to do');
      if (r.changed) setSelected([]);
      reload();
      onChanged?.();
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  };

  const unscored = rows.filter((j) => selectedSet.has(j.id) && j.score == null).length;
  // These act on every row the filters match, which is more than this page —
  // so fetch the full id list on demand rather than using what is on screen.
  const allMatchingIds = async () => {
    const p = new URLSearchParams(query);
    p.delete('limit');
    p.delete('offset');
    const all = await apiGet(`${path}?${p.toString()}`);
    return (all.rows || []).map((j) => j.id);
  };

  return (
    <>
      <div className="toolbar">
        <button
          className="btn"
          disabled={busy || !total}
          onClick={scoreAllMatching}
          title="Score every unscored job matching the current filters, across all pages"
        >
          Score unscored
        </button>
        <button
          className="btn"
          disabled={busy || !total}
          onClick={scoreAndResumeAllMatching}
          title="Score anything unscored in this filter, then draft a resume for every job that clears the threshold"
        >
          Score &amp; draft resumes for all {total} matching
        </button>
        <select
          className="input"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          title="Only draft a resume at or above this score"
        >
          {THRESHOLDS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {busy && <span className="spinner" />}
      </div>

      <div className="toolbar">
        <input className="input grow" placeholder="Search title, company, location, description…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select
          className="input"
          value={view}
          onChange={(e) => setView(e.target.value)}
          title="Ignored jobs were filtered out on arrival — usually by the experience cap in your Profile"
        >
          <option value="active">Active jobs</option>
          <option value="ignored">Ignored</option>
          <option value="all">Active + ignored</option>
        </select>
        <select
          className="input"
          value={matched}
          onChange={(e) => setMatched(e.target.value)}
          title="Company scans store every posting they find; only profile matches are surfaced by default"
        >
          <option value="1">Matched</option>
          <option value="all">All found</option>
          <option value="0">Unmatched only</option>
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_META).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select className="input" value={minScore} onChange={(e) => setMinScore(e.target.value)}>
          <option value="">Any score</option>
          <option value="4">≥ 4.0 (good fits)</option>
          <option value="3">≥ 3.0</option>
        </select>
        <select className="input" value={tier} onChange={(e) => setTier(e.target.value)} title="Primary and secondary come from your role lists in Settings">
          <option value="">All roles</option>
          <option value="primary">Primary roles</option>
          <option value="secondary">Secondary roles</option>
          <option value="none">Off-target</option>
        </select>
        <select
          className="input"
          value={maxYoe}
          onChange={(e) => setMaxYoe(e.target.value)}
          title="Hide postings asking for more experience than this. Postings that never state a requirement always stay."
        >
          <option value="">Any experience</option>
          <option value="4">≤ 4 yrs asked</option>
          <option value="6">≤ 6 yrs asked</option>
          <option value="8">≤ 8 yrs asked</option>
        </select>
        {showCompanyPicker && (
          <span className="company-pick">
            <input
              className="input"
              list={`${storageKey}-companies`}
              placeholder="Any company"
              value={companyPick}
              onChange={(e) => setCompanyPick(e.target.value)}
              title="Type to narrow, or pick from every company that has jobs"
            />
            <datalist id={`${storageKey}-companies`}>
              {(companies || []).map((c) => (
                <option key={c.name} value={c.name}>
                  {c.count} job{c.count > 1 ? 's' : ''}
                </option>
              ))}
            </datalist>
            {companyPick && (
              <button className="link-btn" onClick={() => setCompanyPick('')} title="Clear the company filter">
                ✕
              </button>
            )}
          </span>
        )}
        <AgeFilter within={age.within} withinBy={age.withinBy} onChange={setAge} />
        <select
          className="input"
          value={customSort ? 'custom' : sort}
          onChange={(e) => {
            setCustomSort(null);
            try {
              localStorage.removeItem(SORT_STORE);
            } catch {}
            setSort(e.target.value);
          }}
        >
          {SORT_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
          {customSort && <option value="custom">Custom order</option>}
        </select>
        <button className="btn" onClick={() => setEditSort(!editSort)} title="Build your own sort order">
          ⚙
        </button>
      </div>

      {editSort && (
        <SortEditor
          value={customSort || SORT_PRESETS[sort] || SORT_PRESETS.priority}
          onChange={applyCustomSort}
          onClose={() => setEditSort(false)}
        />
      )}

      {selected.length > 0 && (
        <div className="bulk-bar">
          <b>{selected.length} selected</b>
          <button className="link-btn" onClick={() => setSelected([])}>
            clear
          </button>

          <span className="spacer" />

          {view === 'ignored' ? (
            <button className="btn" disabled={busy} onClick={() => runBulk('restore')} title="Put these back in the active list">
              ↩ Restore
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => runBulk('ignore')} title="Move these out of the active list">
              Ignore
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => runBulk('advance')} title="Move each job one stage further along the pipeline">
            Next step →
          </button>
          <select
            className="input"
            value=""
            disabled={busy}
            onChange={(e) => e.target.value && runBulk('status', { to: e.target.value })}
            title="Set every selected job to one status"
          >
            <option value="">Set status…</option>
            {Object.entries(STATUS_META).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <button className="btn" disabled={busy || !unscored} onClick={() => runBulk('analyze')} title="Score the selected jobs that have no score yet">
            Score unscored{unscored ? ` (${unscored})` : ''}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => runBulk('score_and_resume', { threshold })}
            title="Score whatever is unscored, then draft a resume for the jobs that clear the threshold"
          >
            Score &amp; draft resumes
          </button>
          <select className="input" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} title="Only draft a resume at or above this score">
            {THRESHOLDS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {notice && <div className="notice-line">{notice}</div>}

      <div className="job-rows">
        {!jobs && <div className="empty">Loading…</div>}
        {jobs && rows.length === 0 && (
          <div className="empty">
            {view === 'ignored'
              ? 'Nothing ignored. Postings asking for more years than your Profile cap land here automatically.'
              : 'No jobs match. Try clearing filters, or fetch new jobs from the dashboard.'}
          </div>
        )}
        {rows.length > 0 && (
          <div className="list-head">
            <label className="select-all">
              <input type="checkbox" checked={allShown} onChange={toggleAll} />
              select all {pageRows.length} on this page <span style={{ opacity: 0.7 }}>· shift-click for a range</span>
            </label>
            <span className="spacer" />
            <span className="range">
              {total === 0 ? '0' : `${current * (pageSize || total) + 1}–${current * (pageSize || total) + pageRows.length}`} of {total}
            </span>
            <select className="input" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} title="Rows per page">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n ? `top ${n}` : 'show all'}
                </option>
              ))}
            </select>
            {pageSize > 0 && pageCount > 1 && (
              <>
                <button className="btn" disabled={current === 0} onClick={() => setPage(current - 1)}>
                  ‹
                </button>
                <span className="range">
                  {current + 1}/{pageCount}
                </span>
                <button className="btn" disabled={current >= pageCount - 1} onClick={() => setPage(current + 1)}>
                  ›
                </button>
              </>
            )}
          </div>
        )}
        {pageRows.map((j) => {
          const op = runningFor(j.id);
          return (
            <div className={`job-row ${selectedSet.has(j.id) ? 'picked' : ''}`} key={j.id}>
              <label className="pick" title="Select for a bulk action — shift-click to extend from the last one">
                <input
                  type="checkbox"
                  checked={selectedSet.has(j.id)}
                  onChange={() => {}}
                  onClick={(e) => toggle(j.id, e.shiftKey)}
                />
              </label>
              <div>
                <div className="title">
                  <Link to={`/jobs/${j.id}`}>{j.title}</Link>
                  <a className="open-link" href={j.url} target="_blank" rel="noreferrer" title="Open the original posting">
                    posting ↗
                  </a>
                </div>
                <div className="meta">
                  <SourceBadge source={j.source} />
                  <TierBadge tier={j.tier} />
                  {j.ignored ? <span className="facet mode-ignored">ignored</span> : null}
                  <CompanyLink name={j.company} companyId={j.company_id} careersUrl={j.company_careers_url} />
                  {j.location && <span>· {j.location}</span>}
                  <StrengthMeter
                    strength={j.company_strength}
                    avgScore={j.company_avg_score}
                    postings={j.company_postings}
                    tracked={j.company_tracked}
                  />
                  <FacetBadges workMode={j.work_mode} yoeMin={j.yoe_min} />
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
                <div className="stamps">
                  <span title={j.posted_at ? postedExact(j.posted_at) : 'The source did not give a posting date'}>
                    posted <b>{postedLabel(j.posted_at) || '—'}</b>
                  </span>
                  <span>added {relTime(j.created_at)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
