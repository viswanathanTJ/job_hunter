import { db, nowIso, addEvent } from '../db.mjs';
import { urlKey } from './url-key.mjs';

function normalize(item) {
  const url = (item.jobLink || item.url || item.link || '').trim();
  const title = (item.title || '').trim();
  const company = (item.company || item.companyName || 'Unknown Company').trim();
  if (!url || !title) return null;
  return {
    url,
    url_key: urlKey(url),
    title,
    company,
    location: (item.location || '').trim(),
    posted_at: (item.postedAt || item.posted_at || '').trim(),
    employment_type: (item.employmentType || item.employment_type || '').trim(),
    seniority: (item.seniorityLevel || item.seniority || '').trim(),
    description: (item.jobDescription || item.description || '').trim(),
    raw_json: JSON.stringify(item),
  };
}

/**
 * Idempotent import: upserts on a canonical url_key (tracking params stripped),
 * so the same posting fetched under different tracking URLs never duplicates;
 * it refreshes description/posted_at if they changed.
 */
export function importJobs(items, source = 'import') {
  const result = { created: 0, updated: 0, skipped: 0, ids: [] };
  const insert = db.prepare(`
    INSERT INTO jobs (source, title, company, location, posted_at, employment_type,
      seniority, url, url_key, description, raw_json, status, fetched_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `);
  const find = db.prepare('SELECT id, description, posted_at FROM jobs WHERE url_key = ?');
  const update = db.prepare(
    'UPDATE jobs SET description = ?, posted_at = ?, fetched_at = ?, updated_at = ? WHERE id = ?'
  );

  for (const item of Array.isArray(items) ? items : []) {
    const j = normalize(item);
    if (!j || !j.url_key) {
      result.skipped++;
      continue;
    }
    const now = nowIso();
    const existing = find.get(j.url_key);
    if (existing) {
      const changed =
        (j.description && j.description !== existing.description) ||
        (j.posted_at && j.posted_at !== existing.posted_at);
      if (changed) {
        update.run(j.description || existing.description, j.posted_at || existing.posted_at, now, now, existing.id);
        addEvent(existing.id, 'job_updated', { source });
        result.updated++;
      } else {
        result.skipped++;
      }
      result.ids.push(existing.id);
    } else {
      const info = insert.run(
        source, j.title, j.company, j.location, j.posted_at, j.employment_type,
        j.seniority, j.url, j.url_key, j.description, j.raw_json, now, now, now
      );
      const id = Number(info.lastInsertRowid);
      addEvent(id, 'job_imported', { source });
      result.created++;
      result.ids.push(id);
    }
  }
  return result;
}
