import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiPost } from '../api.js';
import JobList from '../JobList.jsx';

export default function Jobs() {
  const navigate = useNavigate();
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

  return (
    <>
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

      <JobList path="/jobs" storageKey="jobs" />
    </>
  );
}
