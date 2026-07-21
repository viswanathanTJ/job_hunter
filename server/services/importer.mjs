import { db, nowIso, addEvent } from '../db.mjs';

function normalize(item) {
  const url = (item.jobLink || item.url || item.link || '').trim();
  const title = (item.title || '').trim();
  const company = (item.company || item.companyName || 'Unknown Company').trim();
  if (!url || !title) return null;
  return {
    url,
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
 * Idempotent import: upserts on jobs.url. Re-importing the same job never
 * duplicates; it refreshes description/posted_at if they changed.
 * `matched` marks profile matches (1) vs stored-only rows (0). Re-imports may
 * promote 0→1; they demote 1→0 only while the job has never been analyzed,
 * so rescued and profile-change-surviving jobs stay visible.
 */
export function importJobs(items, source = 'import', { matched = 1 } = {}) {
  const result = { created: 0, updated: 0, skipped: 0, ids: [] };
  const insert = db.prepare(`
    INSERT INTO jobs (source, title, company, location, posted_at, employment_type,
      seniority, url, description, raw_json, status, matched, fetched_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
  `);
  const find = db.prepare('SELECT id, description, posted_at, matched FROM jobs WHERE url = ?');
  const update = db.prepare(
    'UPDATE jobs SET description = ?, posted_at = ?, fetched_at = ?, updated_at = ? WHERE id = ?'
  );
  const setMatched = db.prepare('UPDATE jobs SET matched = ?, updated_at = ? WHERE id = ?');
  const hasAnalysis = db.prepare('SELECT 1 FROM analyses WHERE job_id = ? LIMIT 1');

  for (const item of Array.isArray(items) ? items : []) {
    const j = normalize(item);
    if (!j) {
      result.skipped++;
      continue;
    }
    const now = nowIso();
    const existing = find.get(j.url);
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
      if (matched === 1 && existing.matched === 0) {
        setMatched.run(1, now, existing.id);
      } else if (matched === 0 && existing.matched === 1 && !hasAnalysis.get(existing.id)) {
        setMatched.run(0, now, existing.id);
      }
      result.ids.push(existing.id);
    } else {
      const info = insert.run(
        source, j.title, j.company, j.location, j.posted_at, j.employment_type,
        j.seniority, j.url, j.description, j.raw_json, matched ? 1 : 0, now, now, now
      );
      const id = Number(info.lastInsertRowid);
      addEvent(id, 'job_imported', { source });
      result.created++;
      result.ids.push(id);
    }
  }
  return result;
}
