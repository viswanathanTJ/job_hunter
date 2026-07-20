import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, apiPost, apiDelete, apiPatch, relTime, STATUS_META } from '../api.js';
import { ScoreChip, StatusBadge } from '../components.jsx';
import { useOpsContext } from '../App.jsx';

function CompanyJobs({ company, pulse }) {
  const { data: jobs, reload } = useApi(`/companies/${company.id}/jobs`, [pulse]);
  const setStatus = (jobId, status) =>
    apiPatch(`/jobs/${jobId}`, { status }).then(reload).catch((e) => alert(e.message));

  if (!jobs) return <div className="empty">Loading results…</div>;
  if (jobs.length === 0)
    return <div className="empty">No matching jobs imported yet — run a scan. Only jobs matching your Profile are kept.</div>;
  return (
    <div className="job-rows">
      {jobs.map((j) => (
        <div className="job-row" key={j.id}>
          <div>
            <div className="title">
              <Link to={`/jobs/${j.id}`}>{j.title}</Link>
            </div>
            <div className="meta">
              {j.location && <span>{j.location}</span>}
              {j.posted_at && <span>· posted {j.posted_at}</span>}
              <a href={j.url} target="_blank" rel="noreferrer">
                · original posting ↗
              </a>
            </div>
            {j.reasoning && <div className="meta" style={{ marginTop: 4 }}>{String(j.reasoning).slice(0, 220)}</div>}
          </div>
          <div className="right" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ScoreChip score={j.score} verdict={j.verdict} />
            <StatusBadge status={j.status} />
            <select className="input" value={j.status} onChange={(e) => setStatus(j.id, e.target.value)} title="Update application status">
              {Object.entries(STATUS_META).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Companies() {
  const { ops, pulse } = useOpsContext();
  const { data: companies, reload } = useApi('/companies', [pulse]);
  const [showAdd, setShowAdd] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);

  const scanning = (c) => c.scanning || ops.some((o) => o.key === `scan:${c.id}` && ['queued', 'running'].includes(o.state));

  const addCompany = async () => {
    if (!url.trim()) return alert('Paste the company careers/jobs link first');
    setBusy(true);
    try {
      const created = await apiPost('/companies', { careers_url: url.trim(), name: name.trim() || undefined });
      setUrl('');
      setName('');
      setShowAdd(false);
      reload();
      if (confirm(`${created.name} added (${created.ats}). Scan for jobs now?`)) {
        await apiPost(`/companies/${created.id}/scan`, {});
        setOpen(created.id);
      }
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const scan = (c) =>
    apiPost(`/companies/${c.id}/scan`, {})
      .then(() => setOpen(c.id))
      .catch((e) => alert(e.message));

  const remove = (c) => {
    if (!confirm(`Remove ${c.name} from the company list? (Imported jobs stay.)`)) return;
    apiDelete(`/companies/${c.id}`).then(reload).catch((e) => alert(e.message));
  };

  return (
    <>
      <h1 className="page-title">Companies</h1>
      <p className="page-sub">
        Tracked career sites. Scan pulls every posting, keeps only jobs matching your <Link to="/profile">Profile</Link>, then scores each match with AI.
      </p>

      <div className="toolbar">
        <button className="btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? 'Cancel' : '+ Add Company'}
        </button>
      </div>

      {showAdd && (
        <div className="toolbar" style={{ alignItems: 'center' }}>
          <input
            className="input grow"
            placeholder="Paste the careers/jobs link (Workday, Greenhouse, Lever, Ashby, or jobs.company.com)…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <input className="input" placeholder="Company name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={busy} onClick={addCompany}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      <div className="job-rows">
        {!companies && <div className="empty">Loading…</div>}
        {(companies || []).map((c) => {
          const s = c.last_scan_summary || {};
          return (
            <div key={c.id}>
              <div className="job-row">
                <div>
                  <div className="title">
                    <a href={c.careers_url} target="_blank" rel="noreferrer" title="Open careers page">
                      {c.name} ↗
                    </a>{' '}
                    <span className="tag">{c.ats}</span>
                  </div>
                  <div className="meta">
                    <span>{c.job_count} matched job{c.job_count === 1 ? '' : 's'}</span>
                    {c.last_scan_at ? (
                      <span>
                        · last scan {relTime(c.last_scan_at)} — found {s.found ?? '?'}, matched {s.matched ?? '?'}, new {s.created ?? '?'}
                      </span>
                    ) : (
                      <span>· never scanned</span>
                    )}
                  </div>
                </div>
                <div className="right" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn small" disabled={scanning(c)} onClick={() => scan(c)}>
                    {scanning(c) ? (
                      <>
                        <span className="spinner" /> Scanning…
                      </>
                    ) : (
                      'Scan'
                    )}
                  </button>
                  <button className="btn small" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {open === c.id ? 'Hide results' : 'Results'}
                  </button>
                  <button className="op-x" title="Remove company" onClick={() => remove(c)}>
                    ✕
                  </button>
                </div>
              </div>
              {open === c.id && (
                <div style={{ margin: '4px 0 16px 16px' }}>
                  <CompanyJobs company={c} pulse={pulse} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
