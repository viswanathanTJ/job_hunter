import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, apiPatch, apiPost, STATUS_META, PIPELINE_ORDER, postedLabel } from '../api.js';
import { sortJobs, SORT_LABELS } from '../sort.js';
import { ScoreChip, AgeFilter, TierBadge } from '../components.jsx';
import { useOpsContext } from '../App.jsx';

const COLUMNS = [...PIPELINE_ORDER, 'discarded'];
const COL_SIZES = [10, 25, 50, 0]; // 0 = no limit
const SORT_OPTIONS = ['priority', 'tier', 'created', 'score', 'strength', 'company', 'posted', 'updated'];

export default function Pipeline() {
  const { pulse } = useOpsContext();
  const [age, setAge] = useState({ within: '', withinBy: 'posted' });
  const [sort, setSort] = useState('priority');
  const [dragOver, setDragOver] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Per-column overrides. A column with nothing set follows the board defaults.
  const [colSort, setColSort] = useState({});
  const [colFilter, setColFilter] = useState({});
  const [colLimit, setColLimit] = useState({});
  const [openPanel, setOpenPanel] = useState(null);

  // Selection is board-wide, but ranges only make sense inside one column, so
  // each column keeps its own shift-click anchor.
  const [selected, setSelected] = useState([]);
  const [anchors, setAnchors] = useState({});

  const params = new URLSearchParams();
  if (age.within) {
    params.set('within', age.within);
    params.set('withinBy', age.withinBy);
  }
  // /jobs is paged now, so the payload is { rows, total } rather than an array.
  const { data: payload, reload } = useApi(`/jobs?${params.toString()}`, [pulse]);
  const jobs = payload?.rows;

  const move = async (jobId, status) => {
    setError('');
    try {
      await apiPatch(`/jobs/${jobId}`, { status });
      reload();
    } catch (e) {
      setError(e.message);
    }
  };

  const columnJobs = useMemo(() => {
    const out = {};
    for (const col of COLUMNS) {
      const needle = (colFilter[col] || '').trim().toLowerCase();
      const rows = (jobs || []).filter(
        (j) =>
          j.status === col &&
          (!needle || `${j.title} ${j.company} ${j.location || ''}`.toLowerCase().includes(needle))
      );
      out[col] = sortJobs(rows, colSort[col] || sort);
    }
    return out;
  }, [jobs, sort, colSort, colFilter]);

  const selectedSet = new Set(selected);

  const toggle = (col, id, shiftKey) => {
    const limit = colLimit[col] ?? 10;
    const rows = limit ? columnJobs[col].slice(0, limit) : columnJobs[col];
    const index = rows.findIndex((j) => j.id === id);
    const anchor = anchors[col];
    if (shiftKey && anchor != null) {
      const from = rows.findIndex((j) => j.id === anchor);
      if (from !== -1 && index !== -1) {
        const [lo, hi] = from < index ? [from, index] : [index, from];
        const range = rows.slice(lo, hi + 1).map((j) => j.id);
        const turningOn = !selectedSet.has(id);
        setSelected((prev) => (turningOn ? [...new Set([...prev, ...range])] : prev.filter((x) => !range.includes(x))));
        setAnchors((a) => ({ ...a, [col]: id }));
        return;
      }
    }
    setAnchors((a) => ({ ...a, [col]: id }));
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleColumn = (col) => {
    const limit = colLimit[col] ?? 10;
    const rows = limit ? columnJobs[col].slice(0, limit) : columnJobs[col];
    const ids = rows.map((j) => j.id);
    const allOn = ids.length > 0 && ids.every((id) => selectedSet.has(id));
    setAnchors((a) => ({ ...a, [col]: null }));
    setSelected((prev) => (allOn ? prev.filter((x) => !ids.includes(x)) : [...new Set([...prev, ...ids])]));
  };

  const runOnColumn = async (col, action, opts = {}) => {
    const ids = columnJobs[col].map((j) => j.id).filter((id) => selectedSet.has(id));
    if (!ids.length) return;
    setBusy(true);
    setNotice('');
    try {
      const r = await apiPost('/jobs/bulk', { ids, action, ...opts });
      const parts = [];
      if (r.changed) parts.push(`${r.changed} moved`);
      if (r.queued) parts.push(`${r.queued} queued`);
      if (r.skipped) {
        const why = [...new Set(r.results.filter((x) => x.skipped).map((x) => x.reason))].join('; ');
        parts.push(`${r.skipped} skipped (${why})`);
      }
      setNotice(parts.join(' · ') || 'Nothing to do');
      if (r.changed) setSelected((prev) => prev.filter((x) => !ids.includes(x)));
      reload();
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Pipeline</h1>
        <p className="page-sub">Drag cards between stages, or select some and move them together.</p>
        {error && (
          <div className="error-line" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
      </div>

      <div className="toolbar">
        <AgeFilter within={age.within} withinBy={age.withinBy} onChange={setAge} />
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} title="Default card order in every column">
          {SORT_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        {selected.length > 0 && (
          <button className="link-btn" onClick={() => setSelected([])}>
            clear {selected.length} selected
          </button>
        )}
        {busy && <span className="spinner" />}
      </div>

      {notice && <div className="notice-line">{notice}</div>}

      <div className="kanban">
        {COLUMNS.map((col) => {
          const colJobs = columnJobs[col];
          const limit = colLimit[col] ?? 10;
          const shown = limit ? colJobs.slice(0, limit) : colJobs;
          // Selecting and acting applies to what you can actually see.
          const ids = shown.map((j) => j.id);
          const picked = ids.filter((id) => selectedSet.has(id));
          const allOn = ids.length > 0 && picked.length === ids.length;
          const tuned = Boolean(colSort[col] || colFilter[col] || colLimit[col] !== undefined);
          return (
            <div
              key={col}
              className={`col ${dragOver === col ? 'drag-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(col);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const id = e.dataTransfer.getData('text/job-id');
                if (id) move(Number(id), col);
              }}
            >
              <div className="col-head">
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={() => toggleColumn(col)}
                  title="Select every card in this stage"
                  disabled={!ids.length}
                />
                <span className="microlabel">{STATUS_META[col].label}</span>
                <span className="count">{limit && colJobs.length > limit ? `${limit}/${colJobs.length}` : colJobs.length}</span>
                <button
                  className={`link-btn ${tuned ? 'on' : ''}`}
                  onClick={() => setOpenPanel(openPanel === col ? null : col)}
                  title="Sort and filter just this stage"
                >
                  ⚙
                </button>
              </div>

              {openPanel === col && (
                <div className="col-tools">
                  <input
                    className="input"
                    placeholder="Filter this stage…"
                    value={colFilter[col] || ''}
                    onChange={(e) => setColFilter((f) => ({ ...f, [col]: e.target.value }))}
                  />
                  <select
                    className="input"
                    value={colLimit[col] ?? 10}
                    onChange={(e) => setColLimit((c) => ({ ...c, [col]: Number(e.target.value) }))}
                    title="How many cards to show in this stage"
                  >
                    {COL_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n ? `top ${n}` : 'show all'}
                      </option>
                    ))}
                  </select>
                  <select
                    className="input"
                    value={colSort[col] || ''}
                    onChange={(e) => setColSort((c) => ({ ...c, [col]: e.target.value || undefined }))}
                  >
                    <option value="">Board default</option>
                    {SORT_OPTIONS.map((k) => (
                      <option key={k} value={k}>
                        {SORT_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {picked.length > 0 && (
                <div className="col-actions">
                  <b>{picked.length} selected</b>
                  <button className="btn" disabled={busy} onClick={() => runOnColumn(col, 'advance')} title="Move these one stage further">
                    Next →
                  </button>
                  <button className="btn" disabled={busy} onClick={() => runOnColumn(col, 'analyze')} title="Score the unscored ones">
                    Score
                  </button>
                </div>
              )}

              <div className="col-body">
                {shown.map((j) => (
                  <div
                    key={j.id}
                    className={`kcard ${selectedSet.has(j.id) ? 'picked' : ''}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/job-id', String(j.id))}
                  >
                    <div className="t">
                      <input
                        type="checkbox"
                        checked={selectedSet.has(j.id)}
                        onChange={() => {}}
                        onClick={(e) => toggle(col, j.id, e.shiftKey)}
                        title="Select — shift-click to extend the range"
                      />
                      <Link to={`/jobs/${j.id}`}>{j.title}</Link>
                    </div>
                    <div className="c">
                      <TierBadge tier={j.tier} />
                      {j.company}
                    </div>
                    <div className="foot">
                      <ScoreChip score={j.score} />
                      {j.resume_pdf && <span className="tag">CV ✓</span>}
                      <span className="age">{postedLabel(j.posted_at) || '—'}</span>
                    </div>
                  </div>
                ))}
                {limit > 0 && colJobs.length > limit && (
                  <button className="link-btn" onClick={() => setColLimit((c) => ({ ...c, [col]: limit + 25 }))}>
                    show {Math.min(25, colJobs.length - limit)} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
