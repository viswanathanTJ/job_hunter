// "Company strength" derived purely from what this dashboard already knows.
// It is NOT a measure of the company's standing in the world — no external data
// is available — it is how well this company has historically scored against
// *your* profile, plus whether you track them and how much they post.
//
// Its job is to give unscored postings a sensible provisional rank: a new job
// from a company whose other postings averaged 4.5 deserves your attention
// before one from a company that has only ever scored 1.5.
import { db } from '../db.mjs';

const key = (name) => String(name || '').trim().toLowerCase();

// A company with no analysed jobs yet gets this in place of a score, so it
// ranks above the known-poor and below the known-good rather than at the bottom.
const UNKNOWN_SCORE = 0.5;
const WEIGHT = { score: 0.6, tracked: 0.2, volume: 0.2 };
const VOLUME_CAP = 5;

/**
 * Map of lowercased company name → { strength 0..1, avgScore, postings, tracked }.
 * One pass over the whole table; the list route calls it once per request.
 */
export function companyStrength() {
  const rows = db
    .prepare(
      `SELECT j.company AS company,
              COUNT(*) AS postings,
              AVG(a.score) AS avg_score,
              COUNT(a.score) AS scored
       FROM jobs j
       LEFT JOIN analyses a
         ON a.id = (SELECT MAX(id) FROM analyses WHERE job_id = j.id)
       GROUP BY LOWER(TRIM(j.company))`
    )
    .all();

  // The same lookup also carries the tracked company's identity, so the list
  // can link a job straight to its company page and careers site.
  const tracked = new Map(
    db.prepare('SELECT id, name, careers_url FROM companies').all().map((c) => [key(c.name), c])
  );

  const out = new Map();
  for (const r of rows) {
    const avgScore = r.scored > 0 ? Number(r.avg_score) : null;
    const record = tracked.get(key(r.company));
    const isTracked = Boolean(record);
    const strength =
      WEIGHT.score * (avgScore == null ? UNKNOWN_SCORE : avgScore / 5) +
      WEIGHT.tracked * (isTracked ? 1 : 0) +
      WEIGHT.volume * (Math.min(r.postings, VOLUME_CAP) / VOLUME_CAP);
    out.set(key(r.company), {
      company: r.company,
      strength: Math.round(strength * 1000) / 1000,
      avgScore: avgScore == null ? null : Math.round(avgScore * 100) / 100,
      postings: r.postings,
      tracked: isTracked,
      companyId: record ? record.id : null,
      careersUrl: record ? record.careers_url : '',
    });
  }
  return out;
}
