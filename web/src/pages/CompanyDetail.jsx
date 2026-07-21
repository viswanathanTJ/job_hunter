import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, apiPost, apiPatch, relTime, STATUS_META } from '../api.js';
import { ScoreChip, StatusBadge, Modal } from '../components.jsx';
import { useOpsContext } from '../App.jsx';

export default function CompanyDetail() {
  const { id } = useParams();
  const { ops, pulse } = useOpsContext();
  const [matched, setMatched] = useState('1');
  const [q, setQ] = useState('');
  const [minScore, setMinScore] = useState('');
  const [sort, setSort] = useState('score');
  const [info, setInfo] = useState(null); // job whose full analysis is open

  const { data: company, error } = useApi(`/companies/${id}`, [pulse]);
  const params = new URLSearchParams({ matched, sort });
  if (q) params.set('q', q);
  if (minScore) params.set('minScore', minScore);
  const { data: jobs, reload } = useApi(`/companies/${id}/jobs?${params.toString()}`, [pulse]);

  if (error)
    return (
      <>
        <p className="page-sub">
          <Link to="/companies">← Back to Companies</Link>
        </p>
        <div className="empty">Company not found.</div>
      </>
    );
  if (!company) return <div className="empty">Loading…</div>;

  const scanning = company.scanning || ops.some((o) => o.key === `scan:${company.id}` && ['queued', 'running'].includes(o.state));
  const s = company.last_scan_summary || {};
  const scan = () => apiPost(`/companies/${company.id}/scan`, {}).catch((e) => alert(e.message));
  const setStatus = (jobId, status) => apiPatch(`/jobs/${jobId}`, { status }).then(reload).catch((e) => alert(e.message));
  const analyze = (jobId) => apiPost(`/jobs/${jobId}/analyze`, {}).then(reload).catch((e) => alert(e.message));

  return (
    <>
      <p className="page-sub" style={{ marginBottom: 8 }}>
        <Link to="/companies">← Back to Companies</Link>
      </p>
      <h1 className="page-title">
        <a href={company.careers_url} target="_blank" rel="noreferrer" title="Open careers page">
          {company.name} ↗
        </a>{' '}
        <span className="tag">{company.ats}</span>
      </h1>
      <p className="page-sub">
        {company.job_count} matched · {company.total_count} found
        {company.last_scan_at
          ? ` · last scan ${relTime(company.last_scan_at)} — found ${s.found ?? '?'}, matched ${s.matched ?? '?'}, new ${s.created ?? '?'}`
          : ' · never scanned'}
      </p>

      <div className="toolbar">
        <button className="btn" disabled={scanning} onClick={scan}>
          {scanning ? (
            <>
              <span className="spinner" /> Scanning…
            </>
          ) : (
            'Scan'
          )}
        </button>
        <input className="input grow" placeholder="Search title or location…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={matched} onChange={(e) => setMatched(e.target.value)} title="Which stored jobs to show">
          <option value="1">Matched</option>
          <option value="all">All found</option>
          <option value="0">Unmatched</option>
        </select>
        <select className="input" value={minScore} onChange={(e) => setMinScore(e.target.value)}>
          <option value="">Any score</option>
          <option value="4">≥ 4.0 (good fits)</option>
          <option value="3">≥ 3.0</option>
        </select>
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="score">By score</option>
          <option value="created">Newest added</option>
          <option value="posted">By posted date</option>
          <option value="title">By title</option>
        </select>
      </div>

      <div className="job-rows">
        {!jobs && <div className="empty">Loading…</div>}
        {jobs && jobs.length === 0 && (
          <div className="empty">
            {matched === '1'
              ? 'No matched jobs yet — run a scan, or switch to "All found" to browse every stored posting.'
              : 'Nothing stored here yet — run a scan.'}
          </div>
        )}
        {(jobs || []).map((j) => (
          <div className="job-row" key={j.id}>
            <div>
              <div className="title">
                <Link to={`/jobs/${j.id}`}>{j.title}</Link>
                {!j.matched && (
                  <span className="tag" style={{ marginLeft: 8 }}>
                    not matched
                  </span>
                )}
              </div>
              <div className="meta">
                {j.location && <span>{j.location}</span>}
                {j.posted_at && <span>· posted {j.posted_at}</span>}
                <span>· added {relTime(j.created_at)}</span>
                <a href={j.url} target="_blank" rel="noreferrer">
                  · original posting ↗
                </a>
              </div>
              {(j.pros?.length > 0 || j.cons?.length > 0) && (
                <div className="meta" style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {(j.pros || []).slice(0, 2).map((p, i) => (
                    <span key={`p${i}`} style={{ color: 'var(--mark-good)' }}>
                      + {p}
                    </span>
                  ))}
                  {(j.cons || []).slice(0, 2).map((c, i) => (
                    <span key={`c${i}`} style={{ color: 'var(--mark-bad)' }}>
                      − {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="right" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {j.matched ? (
                <>
                  <ScoreChip score={j.score} verdict={j.verdict} />
                  <StatusBadge status={j.status} />
                  <select
                    className="input"
                    value={j.status}
                    onChange={(e) => setStatus(j.id, e.target.value)}
                    title="Update application status"
                  >
                    {Object.entries(STATUS_META).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <button className="btn small" onClick={() => analyze(j.id)} title="Promote to matched and score with AI">
                  Analyze
                </button>
              )}
              {j.score != null && (
                <button className="btn small" title="Full analysis" onClick={() => setInfo(j)}>
                  i
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {info && (
        <Modal title={`${info.title} — analysis`} onClose={() => setInfo(null)}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <ScoreChip score={info.score} verdict={info.verdict} />
            <span className="meta">added {relTime(info.created_at)}</span>
          </div>
          {info.pros?.length > 0 && (
            <>
              <div className="microlabel">Pros</div>
              <ul>
                {info.pros.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          )}
          {info.cons?.length > 0 && (
            <>
              <div className="microlabel">Cons</div>
              <ul>
                {info.cons.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
          {info.reasoning && (
            <>
              <div className="microlabel">Reasoning</div>
              <p>{info.reasoning}</p>
            </>
          )}
          {info.location_check && (
            <>
              <div className="microlabel">Location check</div>
              <p>{info.location_check}</p>
            </>
          )}
          <p>
            <Link to={`/jobs/${info.id}`} onClick={() => setInfo(null)}>
              Open full job page →
            </Link>
          </p>
        </Modal>
      )}
    </>
  );
}
