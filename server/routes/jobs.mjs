import express from 'express';
import { db, STATUSES, nowIso, addEvent, getJob, jobWithDetails, parseJob, setStatus } from '../db.mjs';

export const jobsRouter = express.Router();

const LIST_SELECT = `
  SELECT j.*,
    (SELECT a.score   FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS score,
    (SELECT a.verdict FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS verdict,
    (SELECT COUNT(*)  FROM analyses a WHERE a.job_id = j.id)                            AS analysis_count,
    (SELECT r.pdf_path FROM resumes r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS resume_pdf,
    (SELECT COUNT(*)  FROM resumes r WHERE r.job_id = j.id)                             AS resume_count,
    (SELECT ap.applied_at FROM applications ap WHERE ap.job_id = j.id)                  AS applied_at
  FROM jobs j
`;

jobsRouter.get('/stats', (req, res) => {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all()) {
    byStatus[row.status] = row.n;
  }
  const total = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
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
  res.json({ total, byStatus, analyzed, avgScore, appliedThisWeek, goodFits, lastFetch, recentEvents });
});

jobsRouter.get('/jobs', (req, res) => {
  const { status, q, tag, minScore, sort = 'created', dir = 'desc' } = req.query;
  const where = [];
  const params = [];
  if (status && STATUSES.includes(status)) {
    where.push('j.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(j.title LIKE ? OR j.company LIKE ? OR j.description LIKE ? OR j.location LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (tag) {
    where.push('j.tags LIKE ?');
    params.push(`%"${tag}"%`);
  }
  let sql = LIST_SELECT + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
  const dirSql = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sorts = {
    created: `j.id ${dirSql}`,
    score: `score IS NULL, score ${dirSql}, j.id DESC`,
    company: `j.company COLLATE NOCASE ${dirSql}`,
    posted: `j.posted_at ${dirSql}`,
    updated: `j.updated_at ${dirSql}`,
  };
  sql += ` ORDER BY ${sorts[sort] || sorts.created} LIMIT 500`;
  let rows = db.prepare(sql).all(...params).map(parseJob);
  if (minScore) rows = rows.filter((r) => r.score != null && r.score >= Number(minScore));
  res.json(rows);
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
