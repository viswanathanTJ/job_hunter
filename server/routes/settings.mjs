import express from 'express';
import { getSettings, saveSettings } from '../services/settings.mjs';
import { CONCURRENCY_MIN, CONCURRENCY_MAX } from '../services/ops.mjs';

export const settingsRouter = express.Router();

const str = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
const bool = (v) => v === true || v === 'true';
const num = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const list = (v) => {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean);
  return String(v || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
};

function maskToken(t) {
  if (!t) return '';
  return t.length <= 10 ? '••••' : `${t.slice(0, 6)}…${t.slice(-4)}`;
}

/** Never send the raw token to the client. */
function present(s) {
  const { apifyToken, ...rest } = s;
  return { ...rest, apifyTokenSet: Boolean(apifyToken), apifyTokenMasked: maskToken(apifyToken) };
}

/** Coerce/validate a client patch into a safe, persistable shape. */
function sanitize(cur, b) {
  const patch = {};
  if (b.claudeModel !== undefined) patch.claudeModel = str(b.claudeModel, cur.claudeModel);
  if (b.resumePdfName !== undefined) patch.resumePdfName = str(b.resumePdfName, cur.resumePdfName);
  if (b.fetchCount !== undefined) patch.fetchCount = num(b.fetchCount, 1, 200, cur.fetchCount);
  if (b.aiConcurrency !== undefined) {
    patch.aiConcurrency = num(b.aiConcurrency, CONCURRENCY_MIN, CONCURRENCY_MAX, cur.aiConcurrency);
  }
  // Only persist a token when a non-empty value is provided (blank = keep existing).
  if (typeof b.apifyToken === 'string' && b.apifyToken.trim()) patch.apifyToken = b.apifyToken.trim();

  if (b.search) {
    const sr = b.search;
    patch.search = {};
    if (sr.primary !== undefined) patch.search.primary = list(sr.primary);
    if (sr.secondary !== undefined) patch.search.secondary = list(sr.secondary);
    if (sr.includeSecondary !== undefined) patch.search.includeSecondary = bool(sr.includeSecondary);
  }
  if (b.linkedin) {
    const l = b.linkedin;
    patch.linkedin = {};
    if (l.actor !== undefined) patch.linkedin.actor = str(l.actor, cur.linkedin.actor);
    if (l.query !== undefined) patch.linkedin.query = str(l.query, cur.linkedin.query);
    if (l.locations !== undefined) patch.linkedin.locations = list(l.locations);
    if (l.lookbackHours !== undefined) patch.linkedin.lookbackHours = num(l.lookbackHours, 1, 720, cur.linkedin.lookbackHours);
    if (l.includeRemoteIndia !== undefined) patch.linkedin.includeRemoteIndia = bool(l.includeRemoteIndia);
    if (l.includeRemoteAnywhere !== undefined) patch.linkedin.includeRemoteAnywhere = bool(l.includeRemoteAnywhere);
  }
  if (b.naukri) {
    const n = b.naukri;
    patch.naukri = {};
    if (n.actor !== undefined) patch.naukri.actor = str(n.actor, cur.naukri.actor);
    if (n.query !== undefined) patch.naukri.query = str(n.query, cur.naukri.query);
    if (n.locations !== undefined) patch.naukri.locations = list(n.locations);
    if (n.includeRemote !== undefined) patch.naukri.includeRemote = bool(n.includeRemote);
  }
  return patch;
}

settingsRouter.get('/settings', (req, res) => {
  res.json(present(getSettings()));
});

settingsRouter.put('/settings', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be a settings object' });
  }
  const saved = saveSettings(sanitize(getSettings(), body));
  res.json(present(saved));
});
