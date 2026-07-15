import React, { useEffect, useState } from 'react';
import { useApi, apiPut } from '../api.js';

const asText = (arr) => (Array.isArray(arr) ? arr.join(', ') : arr || '');

/** Seed editable form state from the server settings payload. */
function toForm(s) {
  return {
    apifyToken: '', // never pre-filled; blank means "keep existing"
    claudeModel: s.claudeModel || '',
    resumePdfName: s.resumePdfName || '',
    fetchCount: s.fetchCount ?? 10,
    linkedin: {
      actor: s.linkedin?.actor || '',
      query: s.linkedin?.query || '',
      locations: asText(s.linkedin?.locations),
      lookbackHours: s.linkedin?.lookbackHours ?? 24,
      includeRemoteIndia: Boolean(s.linkedin?.includeRemoteIndia),
      includeRemoteAnywhere: Boolean(s.linkedin?.includeRemoteAnywhere),
    },
    naukri: {
      actor: s.naukri?.actor || '',
      query: s.naukri?.query || '',
      locations: asText(s.naukri?.locations),
      includeRemote: Boolean(s.naukri?.includeRemote),
    },
  };
}

export default function Settings() {
  const { data, reload } = useApi('/settings');
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (data) setForm(toForm(data));
  }, [data]);

  if (!form) return <div className="empty">Loading…</div>;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setIn = (group, k, v) => setForm((f) => ({ ...f, [group]: { ...f[group], [k]: v } }));

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const payload = { ...form };
      if (!payload.apifyToken) delete payload.apifyToken; // blank = keep existing
      await apiPut('/settings', payload);
      setMsg('Saved. Fetches use these settings immediately — no restart needed.');
      reload();
      setForm((f) => ({ ...f, apifyToken: '' }));
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Search config lives here — no more editing <code>.env</code>. Values fall back to{' '}
        <code>.env</code> until you override them.
      </p>

      <div className="panel settings-block">
        <h2 className="section-title">Apify &amp; processing</h2>
        <div className="settings-grid">
          <label className="field">
            <span className="microlabel">Apify token</span>
            <input
              className="input"
              type="password"
              placeholder={data.apifyTokenSet ? `set (${data.apifyTokenMasked}) — leave blank to keep` : 'not set'}
              value={form.apifyToken}
              onChange={(e) => set('apifyToken', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="microlabel">Jobs per fetch</span>
            <input className="input" type="number" min="1" max="200" value={form.fetchCount} onChange={(e) => set('fetchCount', e.target.value)} />
          </label>
          <label className="field">
            <span className="microlabel">Claude model</span>
            <input className="input" value={form.claudeModel} onChange={(e) => set('claudeModel', e.target.value)} />
          </label>
          <label className="field">
            <span className="microlabel">Resume PDF filename</span>
            <input className="input" value={form.resumePdfName} onChange={(e) => set('resumePdfName', e.target.value)} />
          </label>
        </div>
      </div>

      <div className="panel settings-block">
        <h2 className="section-title">LinkedIn</h2>
        <div className="settings-grid">
          <label className="field">
            <span className="microlabel">Actor</span>
            <input className="input" value={form.linkedin.actor} onChange={(e) => setIn('linkedin', 'actor', e.target.value)} />
          </label>
          <label className="field">
            <span className="microlabel">Lookback (hours)</span>
            <input className="input" type="number" min="1" max="720" value={form.linkedin.lookbackHours} onChange={(e) => setIn('linkedin', 'lookbackHours', e.target.value)} />
          </label>
          <label className="field span-2">
            <span className="microlabel">Search query</span>
            <input className="input" value={form.linkedin.query} onChange={(e) => setIn('linkedin', 'query', e.target.value)} />
          </label>
          <label className="field span-2">
            <span className="microlabel">Locations (comma-separated)</span>
            <input className="input" placeholder="Bengaluru, Chennai" value={form.linkedin.locations} onChange={(e) => setIn('linkedin', 'locations', e.target.value)} />
          </label>
        </div>
        <div className="check-row">
          <label className="check">
            <input type="checkbox" checked={form.linkedin.includeRemoteIndia} onChange={(e) => setIn('linkedin', 'includeRemoteIndia', e.target.checked)} />
            Include remote (India)
          </label>
          <label className="check">
            <input type="checkbox" checked={form.linkedin.includeRemoteAnywhere} onChange={(e) => setIn('linkedin', 'includeRemoteAnywhere', e.target.checked)} />
            Include remote (anywhere — brings in US &amp; other countries)
          </label>
        </div>
      </div>

      <div className="panel settings-block">
        <h2 className="section-title">Naukri</h2>
        <div className="settings-grid">
          <label className="field span-2">
            <span className="microlabel">Actor</span>
            <input className="input" placeholder="username~naukri-job-scraper" value={form.naukri.actor} onChange={(e) => setIn('naukri', 'actor', e.target.value)} />
          </label>
          <label className="field span-2">
            <span className="microlabel">Search query</span>
            <input className="input" value={form.naukri.query} onChange={(e) => setIn('naukri', 'query', e.target.value)} />
          </label>
          <label className="field span-2">
            <span className="microlabel">Locations (comma-separated)</span>
            <input className="input" placeholder="Bengaluru, Chennai" value={form.naukri.locations} onChange={(e) => setIn('naukri', 'locations', e.target.value)} />
          </label>
        </div>
        <div className="check-row">
          <label className="check">
            <input type="checkbox" checked={form.naukri.includeRemote} onChange={(e) => setIn('naukri', 'includeRemote', e.target.checked)} />
            Include remote / work-from-home (India)
          </label>
        </div>
      </div>

      <div className="btn-row">
        <button className="btn primary" disabled={saving} onClick={save}>
          {saving ? <span className="spinner" /> : '✓'} Save settings
        </button>
        {msg && <span style={{ color: 'var(--ink-2)', fontSize: 13 }}>{msg}</span>}
      </div>
    </>
  );
}
