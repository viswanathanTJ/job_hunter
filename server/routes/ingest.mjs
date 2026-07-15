import express from 'express';
import { importJobs } from '../services/importer.mjs';
import { startFetch, listFetchRuns } from '../services/apify.mjs';
import { getSource, SOURCES } from '../services/sources.mjs';

export const ingestRouter = express.Router();

// Accepts { jobs: [...] } or a bare array — shape-compatible with the parsed
// output of the old n8n workflow (title/company/jobLink/jobDescription/...).
ingestRouter.post('/import', (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : Array.isArray(body?.jobs) ? body.jobs : null;
  if (!items) return res.status(400).json({ error: 'Body must be an array of jobs or { jobs: [...] }' });
  const result = importJobs(items, typeof body?.source === 'string' ? body.source : 'import');
  res.json(result);
});

ingestRouter.post('/fetch', (req, res) => {
  const key = (req.query.source || req.body?.source || 'linkedin').toString();
  const source = getSource(key);
  if (!source) {
    return res.status(400).json({ error: `Unknown source "${key}". Known: ${Object.keys(SOURCES).join(', ')}` });
  }
  try {
    res.status(202).json(startFetch(source));
  } catch (e) {
    res.status(409).json({ error: String(e.message) });
  }
});

ingestRouter.get('/fetch/runs', (req, res) => {
  res.json(listFetchRuns());
});
