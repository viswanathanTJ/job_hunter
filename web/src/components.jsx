import React from 'react';
import { STATUS_META, scoreTier, relTime } from './api.js';

export function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status };
  return <span className={`badge s-${status}`}>{meta.label}</span>;
}

const SOURCE_LABELS = { linkedin: 'LinkedIn', naukri: 'Naukri', apify: 'LinkedIn', import: 'Imported' };
export function SourceBadge({ source }) {
  if (!source) return null;
  const label = SOURCE_LABELS[source] || source;
  return <span className={`src-badge src-${source}`}>{label}</span>;
}

export function ScoreChip({ score, verdict }) {
  const tier = scoreTier(score);
  if (tier === 'none') return <span className="score-chip none">not scored</span>;
  return (
    <span className={`score-chip ${tier}`}>
      <span className="dot" />
      {Number(score).toFixed(1)}/5{verdict ? ` · ${verdict}` : ''}
    </span>
  );
}

export function StatTile({ label, value, hint }) {
  return (
    <div className="stat-tile">
      <div className="microlabel">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Modal({ title, children, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function ScoreDial({ score }) {
  const pct = score == null ? 0 : Math.max(0, Math.min(1, score / 5));
  const tier = scoreTier(score);
  const color =
    tier === 'good' ? 'var(--mark-good)' : tier === 'warn' ? 'var(--mark-amber)' : tier === 'bad' ? 'var(--mark-bad)' : 'var(--line-strong)';
  const r = 44;
  const circ = 2 * Math.PI * r;
  const arc = circ * 0.75;
  return (
    <svg width="110" height="110" viewBox="0 0 110 110" role="img" aria-label={`Match score ${score ?? 'not scored'} out of 5`}>
      <g transform="rotate(135 55 55)">
        <circle cx="55" cy="55" r={r} fill="none" stroke="var(--line)" strokeWidth="8" strokeDasharray={`${arc} ${circ}`} strokeLinecap="round" />
        <circle
          cx="55"
          cy="55"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={`${arc * pct} ${circ}`}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
      </g>
      <text x="55" y="52" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="24" fontWeight="600" fill="var(--ink)">
        {score == null ? '—' : Number(score).toFixed(1)}
      </text>
      <text x="55" y="70" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="10" fill="var(--ink-3)" letterSpacing="2">
        / 5.0
      </text>
    </svg>
  );
}

const EVENT_STYLE = {
  job_imported: { dot: 'accent', label: 'Imported' },
  job_updated: { dot: '', label: 'Listing updated' },
  analyzed: { dot: 'good', label: 'Analyzed' },
  analysis_failed: { dot: 'bad', label: 'Analysis failed' },
  analysis_cancelled: { dot: '', label: 'Analysis stopped' },
  resume_generated: { dot: 'good', label: 'Resume generated' },
  resume_failed: { dot: 'bad', label: 'Resume failed' },
  resume_cancelled: { dot: '', label: 'Resume generation stopped' },
  pdf_render_failed: { dot: 'bad', label: 'PDF render failed' },
  status_changed: { dot: 'accent', label: 'Status' },
  note_added: { dot: '', label: 'Note added' },
  applied: { dot: 'good', label: 'Applied' },
  tracker_synced: { dot: 'good', label: 'Tracker synced' },
  tracker_sync_failed: { dot: 'bad', label: 'Tracker sync failed' },
};

export function EventItem({ event }) {
  const style = EVENT_STYLE[event.type] || { dot: '', label: event.type };
  const p = event.payload || {};
  let detail = '';
  if (event.type === 'status_changed') detail = `${p.from} → ${p.to}`;
  else if (event.type === 'analyzed') detail = `score ${p.score}/5 · ${p.verdict}`;
  else if (event.type === 'resume_generated') detail = `v${p.version}${p.pageCount ? ` · ${p.pageCount} page${p.pageCount > 1 ? 's' : ''}` : ''}`;
  else if (event.type === 'tracker_synced') detail = `report #${p.num}`;
  else if (String(event.type).endsWith('_failed')) detail = p.error || '';
  return (
    <div className="tl-item">
      <div className={`tl-dot ${style.dot}`} />
      <div className="tl-body">
        <b>{style.label}</b>
        {detail && <span style={{ color: 'var(--ink-2)' }}> — {detail}</span>}
        <span className="when">{relTime(event.created_at)}</span>
      </div>
    </div>
  );
}
