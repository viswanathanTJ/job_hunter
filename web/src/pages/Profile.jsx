import React, { useEffect, useState } from 'react';
import { useApi, apiPut, apiPost } from '../api.js';

const WORK_MODES = ['remote', 'hybrid', 'on-site'];
const JOB_TYPES = ['full-time', 'part-time', 'contract', 'internship'];

const toText = (list) => (list || []).join(', ');
const toList = (text) =>
  String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function ListField({ label, hint, value, onChange, rows = 1 }) {
  return (
    <label className="field" style={{ display: 'block', marginBottom: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {hint && <div className="meta" style={{ marginBottom: 4 }}>{hint}</div>}
      {rows > 1 ? (
        <textarea className="input" style={{ width: '100%' }} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input" style={{ width: '100%' }} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function CheckGroup({ label, options, selected, onToggle }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        {options.map((o) => (
          <label key={o} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} />
            {o}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function Profile() {
  const { data: profile, reload } = useApi('/profile');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile && !form) {
      setForm({
        languages: toText(profile.languages),
        roles: toText(profile.roles),
        topics: toText(profile.topics),
        include: toText(profile.match?.include),
        exclude: toText(profile.match?.exclude),
        country: profile.locations?.country || '',
        cities: toText(profile.locations?.cities),
        allowRemote: Boolean(profile.locations?.allowRemote),
        workModes: profile.workModes || [],
        jobTypes: profile.jobTypes || [],
        minScore: profile.minScore ?? 4,
        yearsExperience: profile.yearsExperience ?? 4,
        maxYoeAsk: profile.maxYoeAsk ?? 4,
      });
    }
  }, [profile, form]);

  if (!form) return <div className="empty">Loading profile…</div>;

  const set = (k) => (v) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const toggle = (k) => (opt) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: f[k].includes(opt) ? f[k].filter((x) => x !== opt) : [...f[k], opt] }));
  };

  const save = async () => {
    try {
      await apiPut('/profile', {
        languages: toList(form.languages),
        roles: toList(form.roles),
        topics: toList(form.topics),
        match: { include: toList(form.include), exclude: toList(form.exclude) },
        locations: { country: form.country.trim(), cities: toList(form.cities), allowRemote: form.allowRemote },
        workModes: form.workModes,
        jobTypes: form.jobTypes,
        minScore: Number(form.minScore) || 4,
        yearsExperience: Number(form.yearsExperience) || 0,
        maxYoeAsk: Number(form.maxYoeAsk) || 0,
      });
      setSaved(true);
      reload();
    } catch (e) {
      alert(e.message);
    }
  };

  const reset = async () => {
    if (!confirm('Reset the profile to defaults? Your edits will be lost.')) return;
    await apiPost('/profile/reset', {});
    setForm(null);
    reload();
  };

  return (
    <>
      <h1 className="page-title">Profile</h1>
      <p className="page-sub">
        Everything the app matches and filters on lives here — company scans keep only jobs that pass these rules, and the AI analyzer
        reads this profile on every evaluation.
      </p>

      <div style={{ maxWidth: 760 }}>
        <label className="field" style={{ display: 'block', marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Years of experience</div>
          <div className="meta" style={{ marginBottom: 4 }}>
            The analyzer weighs each posting's experience ask against this — within 2 years over is treated as a normal stretch,
            5+ years over caps the score.
          </div>
          <input
            className="input"
            type="number"
            min="0"
            max="50"
            step="0.5"
            style={{ width: 120 }}
            value={form.yearsExperience ?? 0}
            onChange={(e) => set('yearsExperience')(e.target.value)}
          />
        </label>

        <label className="field" style={{ display: 'block', marginBottom: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Auto-reject above (years)</div>
          <div className="meta" style={{ marginBottom: 4 }}>
            Postings asking for more years than this are discarded the moment they arrive, before any Claude analysis is spent on
            them. Postings that never state a requirement are always kept. Set to 0 to turn the rule off.
          </div>
          <input
            className="input"
            type="number"
            min="0"
            max="50"
            style={{ width: 120 }}
            value={form.maxYoeAsk ?? 0}
            onChange={(e) => set('maxYoeAsk')(e.target.value)}
          />
        </label>

        <ListField label="Languages I know" hint="Programming languages / core stacks, comma-separated." value={form.languages} onChange={set('languages')} />
        <ListField label="Roles I'm interested in" hint="Target role titles, comma-separated." value={form.roles} onChange={set('roles')} />
        <ListField label="Topics I'm interested in" hint="Domains and technologies you want to work on." value={form.topics} onChange={set('topics')} />

        <ListField
          label="Include in job matches"
          hint="A job title must contain at least ONE of these keywords (word match, case-insensitive)."
          value={form.include}
          onChange={set('include')}
          rows={3}
        />
        <ListField
          label="Exclude from job matches"
          hint="A job title containing ANY of these is dropped (e.g. Node — weak stack; Staff/Principal — above band)."
          value={form.exclude}
          onChange={set('exclude')}
          rows={3}
        />

        <ListField label="Job location — country" hint="Used for country-level filtering on portals that support it (e.g. Workday)." value={form.country} onChange={set('country')} />
        <ListField label="Job location — cities" hint="On-site/hybrid jobs must be in one of these cities." value={form.cities} onChange={set('cities')} />
        <CheckGroup label="Work mode" options={WORK_MODES} selected={form.workModes} onToggle={toggle('workModes')} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.allowRemote} onChange={() => set('allowRemote')(!form.allowRemote)} />
          Accept fully-remote jobs from anywhere in my country
        </label>
        <CheckGroup label="Job type" options={JOB_TYPES} selected={form.jobTypes} onToggle={toggle('jobTypes')} />

        <ListField
          label="Minimum score for a 'good fit'"
          hint="Analyses at or above this score count as worth applying (used by dashboards and filters)."
          value={String(form.minScore)}
          onChange={set('minScore')}
        />

        <div className="toolbar">
          <button className="btn" onClick={save}>
            Save Profile
          </button>
          <button className="btn small" onClick={reset}>
            Reset to defaults
          </button>
          {saved && <span style={{ color: 'var(--accent)' }}>Saved ✓</span>}
        </div>
      </div>
    </>
  );
}
