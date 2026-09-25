import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi, apiPost, apiPatch, relTime, postedLabel, postedExact } from '../api.js';
import { StatusBadge, ScoreChip, ScoreDial, Modal, EventItem } from '../components.jsx';
import { useOpsContext } from '../App.jsx';

export default function JobDetail() {
  const { id } = useParams();
  const { ops, pulse } = useOpsContext();
  const { data: job, reload } = useApi(`/jobs/${id}`, [pulse]);
  const [error, setError] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [showApplied, setShowApplied] = useState(false);
  const [appliedNotes, setAppliedNotes] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  const [copied, setCopied] = useState(false);

  const myOp = ops.find((o) => o.jobId === Number(id) && ['running', 'queued', 'cancelling'].includes(o.state));
  useEffect(() => {
    if (!myOp) setFrameKey((k) => k + 1); // refresh the PDF frame when work lands
  }, [!!myOp]);

  if (!job) return <div className="empty">Loading…</div>;

  const a = job.analysis;
  const call = (fn) => async () => {
    setError('');
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e.message);
    }
  };

  const analyzing = myOp?.type === 'analyze';
  const generating = myOp?.type === 'resume';
  const cancelling = myOp?.state === 'cancelling';
  const hasPdf = job.resume?.pdf_path;

  const StopButton = () =>
    myOp ? (
      <button
        className="btn small danger"
        style={{ marginLeft: 10 }}
        disabled={cancelling}
        onClick={call(() => apiPost('/ops/cancel', { key: myOp.key }))}
      >
        {cancelling ? 'Stopping…' : '■ Stop'}
      </button>
    ) : null;

  const addTag = call(async () => {
    const t = tagDraft.trim().replace(/^#/, '');
    if (!t) return;
    await apiPatch(`/jobs/${id}`, { tags: [...new Set([...(job.tags || []), t])] });
    setTagDraft('');
  });

  const markApplied = call(async () => {
    const r = await apiPost(`/jobs/${id}/applied`, { notes: appliedNotes, method: 'manual' });
    setShowApplied(false);
    setAppliedNotes('');
    if (r.trackerSynced) setError('');
    else if (r.error) setError(`Applied recorded, but tracker sync failed: ${r.error}`);
  });

  return (
    <>
      <div className="detail-head">
        <div>
          <div className="microlabel" style={{ marginBottom: 6 }}>
            <Link to="/jobs" style={{ textDecoration: 'none', color: 'inherit' }}>
              ← jobs
            </Link>{' '}
            / #{job.id}
          </div>
          <h1 className="page-title">{job.title}</h1>
          <div className="page-sub" style={{ marginBottom: 10 }}>
            <b>{job.company}</b>
            {job.location && ` · ${job.location}`}
            {job.posted_at && (
              <span title={postedExact(job.posted_at)}> · posted {postedLabel(job.posted_at)}</span>
            )}
            {job.seniority && ` · ${job.seniority}`}
            {job.employment_type && ` · ${job.employment_type}`}
          </div>
          <div className="btn-row">
            <StatusBadge status={job.status} />
            <ScoreChip score={a?.score} verdict={a?.verdict} />
            {(job.tags || []).map((t) => (
              <span
                className="tag"
                key={t}
                title="Click to remove"
                style={{ cursor: 'pointer' }}
                onClick={call(() => apiPatch(`/jobs/${id}`, { tags: job.tags.filter((x) => x !== t) }))}
              >
                #{t} ×
              </span>
            ))}
            <input
              className="input"
              style={{ padding: '3px 8px', fontSize: 12, width: 90 }}
              placeholder="+ tag"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTag()}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'flex-end' }}>
          <div className="btn-row">
            <a className="btn" href={job.url} target="_blank" rel="noreferrer">
              Open posting ↗
            </a>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(job.url);
                } catch {
                  const ta = document.createElement('textarea');
                  ta.value = job.url;
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  ta.remove();
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? '✓ Copied' : '⧉ Copy link'}
            </button>
          </div>
          <div className="btn-row">
            <button className="btn small" disabled={!!myOp} onClick={call(() => apiPost(`/jobs/${id}/analyze`, { force: !!a }))}>
              {analyzing ? <span className="spinner" /> : '◈'} {a ? 'Re-analyze' : 'Analyze'}
            </button>
            <button className="btn small" disabled={!!myOp} onClick={call(() => apiPost(`/jobs/${id}/resume`, { force: !!job.resume }))}>
              {generating ? <span className="spinner" /> : '⎘'} {job.resume ? 'Regenerate resume' : 'Generate resume'}
            </button>
          </div>
          <div className="btn-row">
            {job.status !== 'applied' && (
              <>
                <button className="btn small primary" onClick={call(() => apiPost(`/jobs/${id}/proceed`))} disabled={job.status === 'ready_to_apply'}>
                  Proceed →
                </button>
                <button className="btn small" onClick={() => setShowApplied(true)}>
                  Mark applied
                </button>
              </>
            )}
            <button className="btn small danger" onClick={call(() => apiPatch(`/jobs/${id}`, { status: 'rejected' }))}>
              Reject
            </button>
            <button className="btn small danger" onClick={call(() => apiPatch(`/jobs/${id}`, { status: 'discarded' }))}>
              Discard
            </button>
          </div>
        </div>
      </div>

      {error && <div className="error-line" style={{ marginBottom: 14 }}>{error}</div>}
      {job.application && (
        <div className="panel" style={{ marginBottom: 16, borderColor: 'var(--mark-good)' }}>
          <span className="microlabel">Application</span>{' '}
          <span style={{ fontSize: 13.5 }}>
            applied {relTime(job.application.applied_at)} · {job.application.method}
            {job.application.tracker_num
              ? ` · tracker report #${job.application.tracker_num}`
              : ' · not yet in tracker'}
            {job.application.notes && ` — ${job.application.notes}`}
          </span>
        </div>
      )}

      <div className="detail-grid">
        <div className="stack">
          <div className="panel">
            <h2 className="section-title">AI match analysis</h2>
            {analyzing && (
              <p style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="spinner" />
                {myOp.state === 'queued' ? 'Queued for analysis…' : 'Claude is scoring this job against your profile…'}
                <StopButton />
              </p>
            )}
            {!a && !analyzing && <p style={{ color: 'var(--ink-3)' }}>Not analyzed yet — hit Analyze above.</p>}
            {a && (
              <>
                <div className="dial-wrap" style={{ marginBottom: 14 }}>
                  <ScoreDial score={a.score} />
                  <div className="dial-meta">
                    <ScoreChip score={a.score} verdict={a.verdict} />
                    {a.location_check && <span style={{ fontSize: 13, color: 'var(--ink-2)' }}>{a.location_check}</span>}
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                      {a.model} · {relTime(a.created_at)}
                      {job.analyses.length > 1 ? ` · ${job.analyses.length} versions` : ''}
                    </span>
                    {a.score < 4 && (
                      <span style={{ fontSize: 12.5, color: 'var(--warn)' }}>
                        Below 4.0 — career-ops guidance is to skip unless you have a specific reason.
                      </span>
                    )}
                  </div>
                </div>
                <p style={{ fontSize: 14, lineHeight: 1.65 }}>{a.reasoning}</p>
                <div className="proscons">
                  <div>
                    <span className="microlabel pro-head">Pros</span>
                    <ul>
                      {a.pros.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <span className="microlabel con-head">Cons</span>
                    <ul>
                      {a.cons.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="panel">
            <h2 className="section-title">Job description</h2>
            <div className="jd-box">{job.description || '(no description stored)'}</div>
          </div>

          <div className="panel">
            <h2 className="section-title">Notes</h2>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <textarea
                className="input"
                style={{ minHeight: 44 }}
                placeholder="Add a note (interview intel, referral, salary info…)"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
              />
              <button
                className="btn"
                onClick={call(async () => {
                  if (!noteDraft.trim()) return;
                  await apiPost(`/jobs/${id}/notes`, { body: noteDraft.trim() });
                  setNoteDraft('');
                })}
              >
                Add
              </button>
            </div>
            {job.notes.map((n) => (
              <div className="note-item" key={n.id}>
                {n.body}
                <span className="when mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginLeft: 8 }}>
                  {relTime(n.created_at)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h2 className="section-title">Tailored resume</h2>
            {generating && (
              <p style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="spinner" />
                {myOp.state === 'queued' ? 'Queued for resume generation…' : 'Claude is tailoring your resume for this role…'}
                <StopButton />
              </p>
            )}
            {!job.resume && !generating && (
              <p style={{ color: 'var(--ink-3)', fontSize: 13.5 }}>
                No resume yet. Generation tailors <span className="mono">Resume/resume.html</span> to this JD — truthfully,
                one page, saved to <span className="mono">Resume/&lt;Company&gt;/</span>.
              </p>
            )}
            {job.resume && (
              <>
                <div className="btn-row" style={{ marginBottom: 10 }}>
                  <span className="tag">v{job.resume.version}</span>
                  {job.resume.page_count != null && (
                    <span className="tag" style={job.resume.page_count > 1 ? { color: 'var(--bad)', borderColor: 'var(--bad)' } : {}}>
                      {job.resume.page_count} page{job.resume.page_count > 1 ? 's ⚠ trim needed' : ' ✓'}
                    </span>
                  )}
                  {hasPdf && (
                    <a className="btn small" href={`/api/jobs/${id}/resume/file?type=pdf`} target="_blank" rel="noreferrer">
                      PDF ↗
                    </a>
                  )}
                  <a className="btn small" href={`/api/jobs/${id}/resume/file?type=html`} target="_blank" rel="noreferrer">
                    HTML ↗
                  </a>
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 10, wordBreak: 'break-all' }}>
                  {job.resume.dir}
                </div>
                {hasPdf && <iframe key={frameKey} className="resume-frame" title="Resume preview" src={`/api/jobs/${id}/resume/file?type=pdf#toolbar=0`} />}
              </>
            )}
          </div>

          <div className="panel">
            <h2 className="section-title">History</h2>
            <div className="timeline">
              {job.events.map((e) => (
                <EventItem event={e} key={e.id} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {showApplied && (
        <Modal title="Mark as applied" onClose={() => setShowApplied(false)}>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-2)' }}>
            This records the application, and syncs it into the career-ops tracker
            (<span className="mono">data/applications.md</span>) with an auto-generated report.
          </p>
          <textarea
            className="input"
            placeholder="Notes — where/how you applied, referral, anything worth remembering…"
            value={appliedNotes}
            onChange={(e) => setAppliedNotes(e.target.value)}
          />
          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setShowApplied(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={markApplied}>
              Confirm applied
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
