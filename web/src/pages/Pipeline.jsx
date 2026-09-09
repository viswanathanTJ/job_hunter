import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, apiPatch, STATUS_META, PIPELINE_ORDER } from '../api.js';
import { ScoreChip } from '../components.jsx';
import { useOpsContext } from '../App.jsx';

const COLUMNS = [...PIPELINE_ORDER, 'discarded'];

export default function Pipeline() {
  const { pulse } = useOpsContext();
  const { data: jobs, reload } = useApi('/jobs?sort=updated', [pulse]);
  const [dragOver, setDragOver] = useState(null);
  const [error, setError] = useState('');

  const move = async (jobId, status) => {
    setError('');
    try {
      await apiPatch(`/jobs/${jobId}`, { status });
      reload();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Pipeline</h1>
        <p className="page-sub">Drag cards between stages, or use a card's detail page for guarded transitions.</p>
        {error && (
          <div className="error-line" style={{ marginBottom: 12 }}>
            {error}
          </div>
        )}
      </div>

      <div className="kanban">
        {COLUMNS.map((col) => {
          const colJobs = (jobs || []).filter((j) => j.status === col);
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
                <span className="microlabel">{STATUS_META[col].label}</span>
                <span className="count">{colJobs.length}</span>
              </div>
              <div className="col-body">
                {colJobs.map((j) => (
                  <Link
                    key={j.id}
                    to={`/jobs/${j.id}`}
                    className="kcard"
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/job-id', String(j.id))}
                  >
                    <div className="t">{j.title}</div>
                    <div className="c">{j.company}</div>
                    <div className="foot">
                      <ScoreChip score={j.score} />
                      {j.resume_pdf && <span className="tag">CV ✓</span>}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
