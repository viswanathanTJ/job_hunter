import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, apiPost, apiDelete, relTime } from '../api.js';
import { useOpsContext } from '../App.jsx';

export default function Companies() {
  const { ops, pulse } = useOpsContext();
  const { data: companies, reload } = useApi('/companies', [pulse]);
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const scanning = (c) => c.scanning || ops.some((o) => o.key === `scan:${c.id}` && ['queued', 'running'].includes(o.state));
  const anyScanning = (companies || []).some(scanning);

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
      }
      navigate(`/companies/${created.id}`);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  const scan = (c, e) => {
    e.stopPropagation();
    apiPost(`/companies/${c.id}/scan`, {}).catch((err) => alert(err.message));
  };

  const scanAll = () =>
    apiPost('/companies/scan-all', {})
      .then(({ queued, skipped }) => {
        if (skipped) alert(`${queued} scan${queued === 1 ? '' : 's'} queued · ${skipped} already running`);
      })
      .catch((e) => alert(e.message));

  const remove = (c, e) => {
    e.stopPropagation();
    if (!confirm(`Remove ${c.name} from the company list? (Imported jobs stay.)`)) return;
    apiDelete(`/companies/${c.id}`).then(reload).catch((err) => alert(err.message));
  };

  return (
    <>
      <h1 className="page-title">Companies</h1>
      <p className="page-sub">
        Tracked career sites. Scan pulls every posting, stores it all, and scores the ones matching your{' '}
        <Link to="/profile">Profile</Link> with AI. Click a company to browse its jobs.
      </p>

      <div className="toolbar">
        <button className="btn" onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? 'Cancel' : '+ Add Company'}
        </button>
        <button className="btn" disabled={anyScanning || !(companies || []).length} onClick={scanAll} title="Queue a scan for every company">
          {anyScanning ? (
            <>
              <span className="spinner" /> Scanning…
            </>
          ) : (
            'Scan All'
          )}
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
        {companies && companies.length === 0 && <div className="empty">No companies yet — add a careers link above.</div>}
        {(companies || []).map((c) => {
          const s = c.last_scan_summary || {};
          return (
            <div
              className="job-row"
              key={c.id}
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/companies/${c.id}`)}
              title="Open company jobs"
            >
              <div>
                <div className="title">
                  {c.name} <span className="tag">{c.ats}</span>
                </div>
                <div className="meta">
                  <span>
                    {c.job_count} matched · {c.total_count} found
                  </span>
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
                <button className="btn small" disabled={scanning(c)} onClick={(e) => scan(c, e)}>
                  {scanning(c) ? (
                    <>
                      <span className="spinner" /> Scanning…
                    </>
                  ) : (
                    'Scan'
                  )}
                </button>
                <button className="op-x" title="Remove company" onClick={(e) => remove(c, e)}>
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
