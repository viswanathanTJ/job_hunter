import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './paths.mjs';
import { urlKey } from './services/url-key.mjs';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL DEFAULT 'import',
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT DEFAULT '',
  posted_at TEXT DEFAULT '',
  employment_type TEXT DEFAULT '',
  seniority TEXT DEFAULT '',
  url TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  raw_json TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  tags TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  score REAL,
  verdict TEXT,
  pros TEXT DEFAULT '[]',
  cons TEXT DEFAULT '[]',
  reasoning TEXT DEFAULT '',
  location_check TEXT DEFAULT '',
  model TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  version INTEGER NOT NULL DEFAULT 1,
  dir TEXT NOT NULL,
  html_path TEXT NOT NULL,
  pdf_path TEXT,
  page_count INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  applied_at TEXT NOT NULL,
  method TEXT DEFAULT 'manual',
  notes TEXT DEFAULT '',
  tracker_num INTEGER,
  tracker_synced_at TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id),
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_key TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  rating REAL,
  rating_source TEXT DEFAULT '',
  headcount TEXT DEFAULT '',
  founded TEXT DEFAULT '',
  hq TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  verdict TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  pros TEXT DEFAULT '[]',
  cons TEXT DEFAULT '[]',
  metrics TEXT DEFAULT '[]',
  sources TEXT DEFAULT '[]',
  model TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  found INTEGER DEFAULT 0,
  imported INTEGER DEFAULT 0,
  updated INTEGER DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_analyses_job ON analyses(job_id);
CREATE INDEX IF NOT EXISTS idx_resumes_job ON resumes(job_id);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);
`);

// Migration: label each fetch run with the source that produced it (LinkedIn,
// Naukri, …). Guarded so existing databases upgrade in place.
const fetchRunCols = db.prepare('PRAGMA table_info(fetch_runs)').all().map((c) => c.name);
if (!fetchRunCols.includes('source')) {
  db.exec("ALTER TABLE fetch_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'linkedin'");
}

// Migration: dedup jobs on a canonical url_key (tracking params stripped) rather
// than the raw URL, which varies per fetch and caused duplicate rows. Written to
// be self-healing: it (re)runs the backfill/collapse whenever any row still has a
// NULL url_key, so a partially-applied migration recovers on the next boot.
const jobCols = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
if (!jobCols.includes('url_key')) {
  db.exec('ALTER TABLE jobs ADD COLUMN url_key TEXT');
}
const needsKeyBackfill = db.prepare("SELECT COUNT(*) n FROM jobs WHERE url_key IS NULL OR url_key = ''").get().n > 0;
if (needsKeyBackfill) {
  db.exec('BEGIN');
  try {
    // Backfill keys for rows that don't have one yet.
    const setKey = db.prepare('UPDATE jobs SET url_key = ? WHERE id = ?');
    for (const r of db.prepare("SELECT id, url FROM jobs WHERE url_key IS NULL OR url_key = ''").all()) {
      setKey.run(urlKey(r.url), r.id);
    }
    // Collapse duplicates: keep the lowest id per url_key, repoint child rows, delete losers.
    const groups = db
      .prepare('SELECT url_key, MIN(id) keep, COUNT(*) n FROM jobs GROUP BY url_key HAVING n > 1')
      .all();
    for (const g of groups) {
      const losers = db
        .prepare('SELECT id FROM jobs WHERE url_key = ? AND id != ?')
        .all(g.url_key, g.keep)
        .map((r) => r.id);
      for (const loser of losers) {
        for (const tbl of ['analyses', 'resumes', 'notes', 'events']) {
          db.prepare(`UPDATE ${tbl} SET job_id = ? WHERE job_id = ?`).run(g.keep, loser);
        }
        // applications is UNIQUE(job_id): move only if the keeper has none.
        const keeperApp = db.prepare('SELECT 1 FROM applications WHERE job_id = ?').get(g.keep);
        if (keeperApp) db.prepare('DELETE FROM applications WHERE job_id = ?').run(loser);
        else db.prepare('UPDATE applications SET job_id = ? WHERE job_id = ?').run(g.keep, loser);
        db.prepare('DELETE FROM jobs WHERE id = ?').run(loser);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_url_key ON jobs(url_key)');

export const STATUSES = [
  'new',
  'reviewed',
  'resume_generated',
  'ready_to_apply',
  'applied',
  'rejected',
  'discarded',
];

export const nowIso = () => new Date().toISOString();

export function addEvent(jobId, type, payload = null) {
  db.prepare('INSERT INTO events (job_id, type, payload, created_at) VALUES (?, ?, ?, ?)').run(
    jobId,
    type,
    payload ? JSON.stringify(payload) : null,
    nowIso()
  );
}

export function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function setStatus(jobId, status, extra = null) {
  if (!STATUSES.includes(status)) throw new Error(`Invalid status: ${status}`);
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status === status) return job;
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), jobId);
  addEvent(jobId, 'status_changed', { from: job.status, to: status, ...(extra || {}) });
  return getJob(jobId);
}

export function latestAnalysis(jobId) {
  const row = db.prepare('SELECT * FROM analyses WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId);
  return row ? parseAnalysis(row) : null;
}

export function latestResume(jobId) {
  return db.prepare('SELECT * FROM resumes WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId);
}

export function parseAnalysis(row) {
  return { ...row, pros: safeParse(row.pros, []), cons: safeParse(row.cons, []) };
}

export function parseJob(row) {
  return { ...row, tags: safeParse(row.tags, []) };
}

export const companyKey = (c) => String(c || '').trim().toLowerCase();

export function parseCompanyReport(row) {
  return {
    ...row,
    pros: safeParse(row.pros, []),
    cons: safeParse(row.cons, []),
    metrics: safeParse(row.metrics, []),
    sources: safeParse(row.sources, []),
  };
}

export function latestCompanyReport(company) {
  const row = db.prepare('SELECT * FROM company_reports WHERE company_key = ?').get(companyKey(company));
  return row ? parseCompanyReport(row) : null;
}

function safeParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function jobWithDetails(id) {
  const job = getJob(id);
  if (!job) return null;
  const analyses = db
    .prepare('SELECT * FROM analyses WHERE job_id = ? ORDER BY id DESC')
    .all(id)
    .map(parseAnalysis);
  const resumes = db.prepare('SELECT * FROM resumes WHERE job_id = ? ORDER BY id DESC').all(id);
  const noteRows = db.prepare('SELECT * FROM notes WHERE job_id = ? ORDER BY id DESC').all(id);
  const eventRows = db
    .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id DESC LIMIT 200')
    .all(id)
    .map((e) => ({ ...e, payload: safeParse(e.payload, null) }));
  const application = db.prepare('SELECT * FROM applications WHERE job_id = ?').get(id) || null;
  return {
    ...parseJob(job),
    analysis: analyses[0] || null,
    analyses,
    resume: resumes[0] || null,
    resumes,
    notes: noteRows,
    events: eventRows,
    application,
    companyReport: latestCompanyReport(job.company),
  };
}
