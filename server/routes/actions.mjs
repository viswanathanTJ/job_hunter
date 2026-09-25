import fs from 'node:fs';
import express from 'express';
import { db, nowIso, getJob, latestAnalysis, latestResume, setStatus, jobWithDetails } from '../db.mjs';
import { analyzeJob, analyzeAll } from '../services/claude.mjs';
import { generateResume } from '../services/resume.mjs';
import { markApplied } from '../services/tracker.mjs';
import { opSnapshot, cancelOp, cancelQueued, poolStats } from '../services/ops.mjs';
import { BULK_ACTIONS } from '../services/bulk.mjs';

export const actionsRouter = express.Router();

actionsRouter.get('/ops', (req, res) => {
  res.json(opSnapshot());
});

actionsRouter.get('/ops/pool', (req, res) => {
  res.json(poolStats());
});

actionsRouter.post('/ops/cancel', (req, res) => {
  const key = String(req.body?.key || '');
  if (!key) return res.status(400).json({ error: 'key required' });
  if (!cancelOp(key)) return res.status(404).json({ error: 'No cancellable operation with that key' });
  res.json({ ok: true });
});

actionsRouter.post('/ops/cancel-queued', (req, res) => {
  res.json({ cancelled: cancelQueued() });
});

// One endpoint for every selection-wide action, so the UI can report exactly
// what happened to each job rather than a bare count.
actionsRouter.post('/jobs/bulk', (req, res) => {
  const { ids, action, ...opts } = req.body || {};
  const run = BULK_ACTIONS[action];
  if (!run) return res.status(400).json({ error: `Unknown bulk action: ${action}` });
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Select at least one job' });
  try {
    const results = run(ids, opts);
    const queued = results.filter((r) => r.queued).length;
    res.status(queued ? 202 : 200).json({
      results,
      changed: results.filter((r) => r.to).length,
      queued,
      skipped: results.filter((r) => r.skipped).length,
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

actionsRouter.post('/jobs/:id/analyze', (req, res) => {
  const id = Number(req.params.id);
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  // Rescue flow: explicitly analyzing a stored-only job promotes it to matched.
  if (!job.matched) db.prepare('UPDATE jobs SET matched = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  const force = Boolean(req.body?.force);
  if (!force && latestAnalysis(id)) {
    return res.json({ skipped: true, analysis: latestAnalysis(id) });
  }
  analyzeJob(id, { force }).catch(() => {}); // completion visible via events/ops
  res.status(202).json({ queued: true });
});

actionsRouter.post('/analyze-all', (req, res) => {
  const queued = analyzeAll({ force: Boolean(req.body?.force) });
  res.status(202).json({ queued });
});

actionsRouter.post('/jobs/:id/resume', (req, res) => {
  const id = Number(req.params.id);
  if (!getJob(id)) return res.status(404).json({ error: 'Job not found' });
  const force = Boolean(req.body?.force);
  const existing = latestResume(id);
  if (!force && existing && fs.existsSync(existing.html_path)) {
    return res.json({ skipped: true, resume: existing });
  }
  generateResume(id, { force }).catch(() => {});
  res.status(202).json({ queued: true });
});

actionsRouter.get('/jobs/:id/resume/file', (req, res) => {
  const id = Number(req.params.id);
  const resume = latestResume(id);
  if (!resume) return res.status(404).json({ error: 'No resume for this job' });
  const type = req.query.type === 'html' ? 'html' : 'pdf';
  const file = type === 'html' ? resume.html_path : resume.pdf_path;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: `No ${type} file on disk` });
  if (type === 'pdf') res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(file);
});

actionsRouter.post('/jobs/:id/proceed', (req, res) => {
  const id = Number(req.params.id);
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'applied') return res.status(400).json({ error: 'Already applied' });
  setStatus(id, 'ready_to_apply', { by: 'user', action: 'proceed' });
  res.json(jobWithDetails(id));
});

actionsRouter.post('/jobs/:id/applied', async (req, res) => {
  const id = Number(req.params.id);
  if (!getJob(id)) return res.status(404).json({ error: 'Job not found' });
  try {
    const result = await markApplied(id, {
      notes: String(req.body?.notes || ''),
      method: req.body?.method === 'assisted' ? 'assisted' : 'manual',
    });
    res.json({ ...result, job: jobWithDetails(id) });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});
