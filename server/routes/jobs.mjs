import express from 'express';
import { db, STATUSES, nowIso, addEvent, getJob, jobWithDetails, setStatus } from '../db.mjs';
import { fetchJobFromUrl } from '../services/jobfetch.mjs';
import { importJobs } from '../services/importer.mjs';
import { analyzeJob } from '../services/claude.mjs';
import { listJobsPage, companyNames } from '../services/joblist.mjs';

export const jobsRouter = express.Router();

// Manual add: paste any job URL — the posting is fetched (ATS detail API or
// page fallback), imported as matched, and queued for analysis.
jobsRouter.post('/jobs/add', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Paste a full job posting URL (https://…)' });
  }
  try {
    const fetched = await fetchJobFromUrl(url);
    if (req.body?.company) fetched.company = String(req.body.company).trim();
    const result = importJobs([{ ...fetched, url }], 'manual', { matched: 1 });
    const id = result.ids[0];
    if (!id) return res.status(422).json({ error: 'Could not extract a title from that posting' });
    if (req.body?.analyze !== false) analyzeJob(id).catch(() => {});
    res.status(result.created ? 201 : 200).json({ created: result.created > 0, job: jobWithDetails(id) });
  } catch (e) {
    res.status(422).json({ error: String(e.message || e) });
  }
});

jobsRouter.get('/stats', (req, res) => {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) n FROM jobs WHERE matched = 1 AND ignored = 0 GROUP BY status').all()) {
    byStatus[row.status] = row.n;
  }
  const total = db.prepare('SELECT COUNT(*) n FROM jobs WHERE matched = 1 AND ignored = 0').get().n;
  const ignoredCount = db.prepare('SELECT COUNT(*) n FROM jobs WHERE ignored = 1').get().n;
  const analyzed = db.prepare('SELECT COUNT(DISTINCT job_id) n FROM analyses').get().n;
  const avgScore =
    db
      .prepare(
        `SELECT AVG(score) avg FROM analyses a
         WHERE a.id = (SELECT MAX(id) FROM analyses WHERE job_id = a.job_id)`
      )
      .get().avg || 0;
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const appliedThisWeek = db
    .prepare('SELECT COUNT(*) n FROM applications WHERE applied_at >= ?')
    .get(weekAgo).n;
  const goodFits = db
    .prepare(
      `SELECT COUNT(*) n FROM analyses a
       WHERE a.id = (SELECT MAX(id) FROM analyses WHERE job_id = a.job_id) AND a.score >= 4`
    )
    .get().n;
  const lastFetch = db.prepare('SELECT * FROM fetch_runs ORDER BY id DESC LIMIT 1').get() || null;
  const recentEvents = db
    .prepare(
      `SELECT e.*, j.title, j.company FROM events e LEFT JOIN jobs j ON j.id = e.job_id
       ORDER BY e.id DESC LIMIT 15`
    )
    .all();
  res.json({ total, ignored: ignoredCount, byStatus, analyzed, avgScore, appliedThisWeek, goodFits, lastFetch, recentEvents });
});

jobsRouter.get('/jobs', (req, res) => {
  res.json(listJobsPage(req.query));
});

// Option list for the company picker on the jobs list.
jobsRouter.get('/company-names', (req, res) => {
  res.json(companyNames(req.query));
});

jobsRouter.get('/jobs/:id', (req, res) => {
  const job = jobWithDetails(Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

jobsRouter.patch('/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { status, tags } = req.body || {};
  try {
    if (status) setStatus(id, status, { by: 'user' });
    if (Array.isArray(tags)) {
      db.prepare('UPDATE jobs SET tags = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(tags.map(String)),
        nowIso(),
        id
      );
    }
    res.json(jobWithDetails(id));
  } catch (e) {
    res.status(400).json({ error: String(e.message) });
  }
});

jobsRouter.post('/jobs/:id/notes', (req, res) => {
  const id = Number(req.params.id);
  if (!getJob(id)) return res.status(404).json({ error: 'Job not found' });
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note body required' });
  db.prepare('INSERT INTO notes (job_id, body, created_at) VALUES (?, ?, ?)').run(id, body, nowIso());
  addEvent(id, 'note_added', null);
  res.json(jobWithDetails(id));
});

jobsRouter.get('/jobs/:id/events', (req, res) => {
  const id = Number(req.params.id);
  if (!getJob(id)) return res.status(404).json({ error: 'Job not found' });
  const events = db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id DESC').all(id);
  res.json(events);
});
