import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, apiPost, relTime } from '../api.js';
import { useOpsContext } from '../App.jsx';
import JobList from '../JobList.jsx';

export default function CompanyDetail() {
  const { id } = useParams();
  const { ops, pulse } = useOpsContext();
  const { data: company, error, reload: reloadCompany } = useApi(`/companies/${id}`, [pulse]);

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
      </div>

      {/* The same list the Jobs page uses, scoped to this company — identical
          filters, facets, bulk actions and ignored handling. */}
      <JobList path={`/companies/${id}/jobs`} storageKey="company" showCompanyPicker={false} onChanged={reloadCompany} />
    </>
  );
}
