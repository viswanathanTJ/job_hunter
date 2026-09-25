import { db, nowIso, addEvent } from '../db.mjs';
import { normalizePosted } from './posted.mjs';
import { extractFacets } from './facets.mjs';
import { getProfile } from './profile.mjs';

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
    posted_at: normalizePosted(item.postedAt || item.posted_at),
    yoe_min: Number.isFinite(Number(item.yoeMin)) ? Number(item.yoeMin) : null,
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
  const result = { created: 0, updated: 0, skipped: 0, autoRejected: 0, ids: [] };
  // Filter on arrival when the posting asks for more years than the profile
  // allows — cheap text extraction, so no Claude run is wasted on it. The row is
  // flagged ignored rather than deleted, so it stays auditable and restorable.
  // Applied to new rows only: a job you restore by hand stays restored.
  const maxYoeAsk = Number(getProfile().maxYoeAsk) || 0;
  const insert = db.prepare(`
    INSERT INTO jobs (source, title, company, location, posted_at, employment_type,
      seniority, url, description, raw_json, work_mode, yoe_min, ignored, matched, fetched_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const find = db.prepare('SELECT id, description, posted_at, matched FROM jobs WHERE url = ?');
  const update = db.prepare(
    'UPDATE jobs SET description = ?, posted_at = ?, work_mode = ?, yoe_min = ?, fetched_at = ?, updated_at = ? WHERE id = ?'
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
        // A refreshed description can change the facets, so re-read them.
        const description = j.description || existing.description;
        const facets = extractFacets(description, j.location);
        update.run(description, j.posted_at || existing.posted_at, facets.workMode, facets.yoeMin, now, now, existing.id);
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
      const facets = extractFacets(j.description, j.location);
      // A minimum the source stated outright beats one read out of the prose.
      if (j.yoe_min != null) facets.yoeMin = j.yoe_min;
      const tooSenior = maxYoeAsk > 0 && facets.yoeMin != null && facets.yoeMin > maxYoeAsk;
      const info = insert.run(
        source, j.title, j.company, j.location, j.posted_at, j.employment_type,
        j.seniority, j.url, j.description, j.raw_json, facets.workMode, facets.yoeMin,
        tooSenior ? 1 : 0, matched ? 1 : 0, now, now, now
      );
      const id = Number(info.lastInsertRowid);
      addEvent(id, 'job_imported', { source });
      if (tooSenior) {
        addEvent(id, 'auto_rejected', {
          reason: `Asks for ${facets.yoeMin}+ years; your cap is ${maxYoeAsk}`,
          yoeMin: facets.yoeMin,
          maxYoeAsk,
        });
        result.autoRejected++;
      }
      result.created++;
      result.ids.push(id);
    }
  }
  return result;
}
