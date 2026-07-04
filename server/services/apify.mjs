// Port of the n8n "job-alerts" fetch pipeline: Apify LinkedIn scraper → parse → import.
import { db, nowIso } from '../db.mjs';
import { importJobs } from './importer.mjs';
import { opStart, opEnd, opRunning } from './ops.mjs';

const POLL_MS = 10_000;
const MAX_POLLS = 60; // 10 minutes

function cfg() {
  return {
    token: process.env.APIFY_TOKEN || '',
    actor: process.env.APIFY_ACTOR || 'curious_coder~linkedin-jobs-scraper',
    query: process.env.JOB_SEARCH_QUERY || 'Backend Engineer OR Senior Backend Engineer',
    lookbackHours: Number(process.env.LOOKBACK_HOURS || 24),
    count: Number(process.env.FETCH_COUNT || 10),
  };
}

export function buildSearchUrls({ query, lookbackHours }) {
  const k = encodeURIComponent(query);
  const r = lookbackHours * 3600;
  return [
    // On-site/hybrid in the two allowed cities
    `https://www.linkedin.com/jobs/search/?keywords=${k}&location=Bengaluru&f_TPR=r${r}&f_WT=1%2C3&sortBy=DD`,
    `https://www.linkedin.com/jobs/search/?keywords=${k}&location=Chennai&f_TPR=r${r}&f_WT=1%2C3&sortBy=DD`,
    // Remote (India + anywhere)
    `https://www.linkedin.com/jobs/search/?keywords=${k}&location=India&f_TPR=r${r}&f_WT=2&sortBy=DD`,
    `https://www.linkedin.com/jobs/search/?keywords=${k}&f_TPR=r${r}&f_WT=2&sortBy=DD`,
  ];
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(li|p|div|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseApifyItems(items) {
  const jobs = [];
  const seen = new Set();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const j of items) {
    const jobLink = j.link || j.jobUrl || j.url || '';
    if (!jobLink || seen.has(jobLink)) continue;
    const postedAt = j.postedAt || '';
    if (postedAt && postedAt < sevenDaysAgo) continue;
    const jobDescription = j.descriptionHtml ? stripHtml(j.descriptionHtml) : j.descriptionText || '';
    if (!jobDescription || jobDescription.length < 50) continue;
    jobs.push({
      title: j.title || 'No Title',
      company: j.companyName || 'Unknown Company',
      location: j.location || '',
      postedAt,
      employmentType: j.employmentType || '',
      seniorityLevel: j.seniorityLevel || '',
      jobLink,
      jobDescription,
    });
    seen.add(jobLink);
    if (jobs.length >= 50) break;
  }
  return jobs;
}

async function apifyJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function runApify(c) {
  const urls = buildSearchUrls(c);
  const start = await apifyJson(
    `https://api.apify.com/v2/acts/${c.actor}/runs?token=${c.token}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls, scrapeCompany: false, count: c.count }),
    }
  );
  const runId = start.data.id;
  const datasetId = start.data.defaultDatasetId;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const status = await apifyJson(`https://api.apify.com/v2/acts/${c.actor}/runs/${runId}?token=${c.token}`);
    const s = status.data.status;
    if (s === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(s)) throw new Error(`Apify run ${s}`);
    if (i === MAX_POLLS - 1) throw new Error('Apify run timed out after 10 minutes');
  }
  return apifyJson(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${c.token}`);
}

/** Starts a fetch in the background. Returns the fetch_runs row id immediately. */
export function startFetch() {
  const c = cfg();
  if (!c.token) throw new Error('APIFY_TOKEN is not set in job-hunter/.env');
  if (opRunning('fetch')) {
    const running = db
      .prepare("SELECT id FROM fetch_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1")
      .get();
    return { id: running?.id, alreadyRunning: true };
  }
  const info = db
    .prepare('INSERT INTO fetch_runs (started_at, status) VALUES (?, ?)')
    .run(nowIso(), 'running');
  const runRowId = Number(info.lastInsertRowid);
  opStart('fetch', { type: 'fetch', runId: runRowId });

  (async () => {
    try {
      const items = await runApify(c);
      const parsed = parseApifyItems(items);
      const res = importJobs(parsed, 'apify');
      db.prepare(
        "UPDATE fetch_runs SET finished_at = ?, status = 'done', found = ?, imported = ?, updated = ? WHERE id = ?"
      ).run(nowIso(), parsed.length, res.created, res.updated, runRowId);
      opEnd('fetch', 'done', { found: parsed.length, imported: res.created });
    } catch (e) {
      db.prepare("UPDATE fetch_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?").run(
        nowIso(),
        String(e.message || e).slice(0, 1000),
        runRowId
      );
      opEnd('fetch', 'error', { error: String(e.message || e) });
    }
  })();

  return { id: runRowId, alreadyRunning: false };
}

export function listFetchRuns(limit = 20) {
  return db.prepare('SELECT * FROM fetch_runs ORDER BY id DESC LIMIT ?').all(limit);
}
