import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { STATUS_META, scoreTier, relTime } from './api.js';
import { KEY_LABELS, SORT_KEYS, SORT_PRESETS, SORT_LABELS } from './sort.js';

// Age windows, in seconds. "Added" is when the row landed here (always exact);
// "Posted" is the source's own date, which is only as precise as it gave us.
export const AGE_PRESETS = [
  { label: 'Any age', value: '' },
  { label: 'Last 15 min', value: 900 },
  { label: 'Last hour', value: 3600 },
  { label: 'Last 2 hours', value: 7200 },
  { label: 'Last 3 hours', value: 10800 },
  { label: 'Last 4 hours', value: 14400 },
  { label: 'Last 5 hours', value: 18000 },
  { label: 'Last 8 hours', value: 28800 },
  { label: 'Last day', value: 86400 },
  { label: 'Last 3 days', value: 259200 },
];

const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86400 };

export function AgeFilter({ within, withinBy, onChange }) {
  const isCustom = within !== '' && !AGE_PRESETS.some((p) => String(p.value) === String(within));
  const [custom, setCustom] = useState({ n: 30, unit: 'minutes' });
  const [open, setOpen] = useState(isCustom);

  const pick = (v) => {
    if (v === 'custom') {
      setOpen(true);
      onChange({ within: String(custom.n * UNIT_SECONDS[custom.unit]), withinBy });
    } else {
      setOpen(false);
      onChange({ within: String(v), withinBy });
    }
  };
  const setCustomWindow = (next) => {
    setCustom(next);
    onChange({ within: String(Math.max(1, next.n) * UNIT_SECONDS[next.unit]), withinBy });
  };

  return (
    <>
      <select className="input" value={open ? 'custom' : String(within)} onChange={(e) => pick(e.target.value)} title="Only show jobs from this window">
        {AGE_PRESETS.map((p) => (
          <option key={p.label} value={String(p.value)}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>

      {open && (
        <span className="age-custom">
          <input
            className="input"
            type="number"
            min="1"
            value={custom.n}
            onChange={(e) => setCustomWindow({ ...custom, n: Number(e.target.value) || 1 })}
          />
          <select className="input" value={custom.unit} onChange={(e) => setCustomWindow({ ...custom, unit: e.target.value })}>
            {Object.keys(UNIT_SECONDS).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </span>
      )}

      {within !== '' && (
        <span className="seg" role="group" aria-label="Measure the age from">
          {['added', 'posted'].map((mode) => (
            <button
              key={mode}
              type="button"
              className={withinBy === mode ? 'on' : ''}
              onClick={() => onChange({ within, withinBy: mode })}
              title={
                mode === 'added'
                  ? 'Age since the job was fetched into this dashboard — always exact'
                  : "The source's own posting date — some sources only give a day, so short windows skip them"
              }
            >
              {mode}
            </button>
          ))}
        </span>
      )}
    </>
  );
}

/**
 * Where to read more about the company. Tracked companies get their own page
 * (every posting we hold, plus a rescan); everything else falls back to a
 * LinkedIn company search — the scraper does not return company URLs, so a
 * guessed profile link would often be wrong.
 */
export function CompanyLink({ name, companyId, careersUrl }) {
  if (companyId) {
    return (
      <Link className="co-link" to={`/companies/${companyId}`} title="Tracked company — every posting we hold">
        <b>{name}</b>
      </Link>
    );
  }
  const href = careersUrl || `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(name || '')}`;
  return (
    <a className="co-link" href={href} target="_blank" rel="noreferrer" title={careersUrl ? 'Careers site' : `Look up ${name} on LinkedIn`}>
      <b>{name}</b>
      <span className="ext">↗</span>
    </a>
  );
}

/** Which of your role tiers this posting's title falls into. */
export function TierBadge({ tier }) {
  if (!tier) return null;
  return (
    <span className={`tier-badge t-${tier}`} title={`Matches one of your ${tier} roles`}>
      {tier === 'primary' ? 'P1' : 'P2'}
    </span>
  );
}

const MODE_LABEL = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };

/** Facets read out of the posting text. Absent facets render nothing at all —
 *  the extraction is deliberately conservative, so a gap means "not stated". */
export function FacetBadges({ workMode, yoeMin }) {
  return (
    <>
      {workMode && (
        <span className={`facet mode-${workMode}`} title="Taken from the posting text">
          {MODE_LABEL[workMode] || workMode}
        </span>
      )}
      {yoeMin != null && (
        <span className="facet" title="Minimum years of experience named in the posting">
          {yoeMin}+ yrs
        </span>
      )}
    </>
  );
}

/** How this company has historically scored against your profile — local
 *  history only, not any outside measure of the company. */
export function StrengthMeter({ strength = 0, avgScore, postings = 0, tracked }) {
  if (!postings) return null;
  const filled = Math.min(3, Math.max(1, Math.ceil(strength * 3)));
  const detail = [
    avgScore == null ? 'no scores yet' : `avg score ${avgScore}/5`,
    `${postings} posting${postings > 1 ? 's' : ''} seen`,
    tracked ? 'tracked company' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className="strength" title={`Company strength from your own history — ${detail}`}>
      {[0, 1, 2].map((i) => (
        <i key={i} className={i < filled ? 'on' : ''} />
      ))}
    </span>
  );
}

/** Reorderable sort keys. The first key that separates two jobs decides. */
export function SortEditor({ value, onChange, onClose }) {
  const active = value.filter((k) => SORT_KEYS.includes(k));
  const inactive = SORT_KEYS.filter((k) => !active.includes(k));

  const move = (i, delta) => {
    const next = [...active];
    const j = i + delta;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="sort-editor">
      <div className="head">
        <b>Sort order</b>
        <button className="link-btn" onClick={() => onChange(SORT_PRESETS.priority)}>
          reset
        </button>
        <button className="link-btn" onClick={onClose}>
          done
        </button>
      </div>
      <p className="hint">Applied top to bottom — the first rule that separates two jobs wins.</p>
      <ol>
        {active.map((k, i) => (
          <li key={k}>
            <span className="n">{i + 1}</span>
            <span className="grow">{KEY_LABELS[k]}</span>
            <button className="link-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
              ↑
            </button>
            <button className="link-btn" disabled={i === active.length - 1} onClick={() => move(i, 1)} title="Move down">
              ↓
            </button>
            <button className="link-btn" disabled={active.length === 1} onClick={() => onChange(active.filter((x) => x !== k))} title="Remove">
              ✕
            </button>
          </li>
        ))}
      </ol>
      {inactive.length > 0 && (
        <div className="add">
          add:
          {inactive.map((k) => (
            <button key={k} className="link-btn" onClick={() => onChange([...active, k])}>
              + {KEY_LABELS[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  auto_rejected: { dot: 'bad', label: 'Auto-rejected' },
  ignored: { dot: '', label: 'Ignored' },
  restored: { dot: 'accent', label: 'Restored' },
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
  else if (event.type === 'auto_rejected') detail = p.reason || '';
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
