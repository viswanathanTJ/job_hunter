// Shared Apify plumbing + a generic, source-driven background fetch.
// Each provider (LinkedIn, Naukri, …) supplies a descriptor from `sources.mjs`;
// this module owns the Apify run/poll loop, the fetch_runs bookkeeping, and the
// op registry wiring so every source behaves identically.
import { db, nowIso } from '../db.mjs';
import { importJobs } from './importer.mjs';
import { opStart, opEnd, opRunning } from './ops.mjs';

const POLL_MS = 10_000;
const MAX_POLLS = 60; // 10 minutes

export function stripHtml(html) {
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

async function apifyJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Run an Apify actor to completion and return its dataset items. */
export async function runApifyActor({ token, actor, input }) {
  const start = await apifyJson(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const runId = start.data.id;
  const datasetId = start.data.defaultDatasetId;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const status = await apifyJson(`https://api.apify.com/v2/acts/${actor}/runs/${runId}?token=${token}`);
    const s = status.data.status;
    if (s === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(s)) throw new Error(`Apify run ${s}`);
    if (i === MAX_POLLS - 1) throw new Error('Apify run timed out after 10 minutes');
  }
  return apifyJson(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`);
}

/**
 * Starts a background fetch for one source descriptor. Returns the fetch_runs
 * row id immediately. Each source has its own op key, so LinkedIn and Naukri
 * fetches run independently (a second fetch of the *same* source is blocked).
 *
 * @param {{ key: string, config: () => object, buildInput: (cfg: object) => object, parseItems: (items: any[]) => any[] }} source
 */
export function startFetch(source) {
  const c = source.config();
  if (!c.token) throw new Error('APIFY_TOKEN is not set in job-hunter/.env');
  if (!c.actor) throw new Error(`No Apify actor configured for "${source.key}" — set it in job-hunter/.env`);

  const opKey = `fetch:${source.key}`;
  if (opRunning(opKey)) {
    const running = db
      .prepare("SELECT id FROM fetch_runs WHERE status = 'running' AND source = ? ORDER BY id DESC LIMIT 1")
      .get(source.key);
    return { id: running?.id, alreadyRunning: true, source: source.key };
  }
  const info = db
    .prepare('INSERT INTO fetch_runs (started_at, status, source) VALUES (?, ?, ?)')
    .run(nowIso(), 'running', source.key);
  const runRowId = Number(info.lastInsertRowid);
  opStart(opKey, { type: 'fetch', source: source.key, runId: runRowId });

  (async () => {
    try {
      const items = await runApifyActor({ token: c.token, actor: c.actor, input: source.buildInput(c) });
      const parsed = source.parseItems(items);
      const res = importJobs(parsed, source.key);
      db.prepare(
        "UPDATE fetch_runs SET finished_at = ?, status = 'done', found = ?, imported = ?, updated = ? WHERE id = ?"
      ).run(nowIso(), parsed.length, res.created, res.updated, runRowId);
      opEnd(opKey, 'done', { found: parsed.length, imported: res.created, autoRejected: res.autoRejected });
    } catch (e) {
      db.prepare("UPDATE fetch_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?").run(
        nowIso(),
        String(e.message || e).slice(0, 1000),
        runRowId
      );
      opEnd(opKey, 'error', { error: String(e.message || e) });
    }
  })();

  return { id: runRowId, alreadyRunning: false, source: source.key };
}

export function listFetchRuns(limit = 20) {
  return db.prepare('SELECT * FROM fetch_runs ORDER BY id DESC LIMIT ?').all(limit);
}
