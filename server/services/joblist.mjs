// The /jobs list query, extracted from the route so it can be exercised
// directly in tests (the same shape companyJobs already follows).
import { db, STATUSES, parseJob } from '../db.mjs';
import { ageFilter } from './filters.mjs';
import { companyStrength } from './strength.mjs';
import { classifyTier } from './tiers.mjs';
import { getSettings } from './settings.mjs';

const LIST_SELECT = `
  SELECT j.*,
    (SELECT a.score   FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS score,
    (SELECT a.verdict FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS verdict,
    (SELECT COUNT(*)  FROM analyses a WHERE a.job_id = j.id)                            AS analysis_count,
    (SELECT r.pdf_path FROM resumes r WHERE r.job_id = j.id ORDER BY r.id DESC LIMIT 1) AS resume_pdf,
    (SELECT COUNT(*)  FROM resumes r WHERE r.job_id = j.id)                             AS resume_count,
    (SELECT a.reasoning FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS reasoning,
    (SELECT a.pros      FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS pros,
    (SELECT a.cons      FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS cons,
    (SELECT a.location_check FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS location_check,
    (SELECT ap.applied_at FROM applications ap WHERE ap.job_id = j.id)                  AS applied_at
  FROM jobs j
`;

// Hard ceiling on rows pulled from SQL in one go. The tier and score filters
// run in JS, so paging has to happen after them — which means the candidate set
// must be fetched whole. Generous enough for a scanned careers site.
const MAX_ROWS = 20000;

/**
 * One page of the job list, plus the true total after every filter. Paging is
 * applied last, after the JS-side tier and score filters, so `total` is the
 * number you would actually see rather than the number SQL happened to return.
 */
export function listJobsPage(query = {}) {
  const { status, q, tag, minScore, within, withinBy, tier, maxYoe, ignored, company, limit, offset, sort = 'created', dir = 'desc', matched = '1' } = query;
  const where = [];
  const params = [];

  // Ignored postings are out of the way unless you ask for them by name.
  if (ignored === '1') where.push('j.ignored = 1');
  else if (ignored !== 'all') where.push('j.ignored = 0');

  if (matched !== 'all') {
    where.push('j.matched = ?');
    params.push(Number(matched) ? 1 : 0);
  }
  // A company's jobs arrive two ways: from scanning its careers site (tagged
  // source "company:<name>") and from a board search that happened to surface
  // it. The company view wants both.
  if (company) {
    where.push('(LOWER(TRIM(j.company)) = LOWER(TRIM(?)) OR j.source = ?)');
    params.push(company, `company:${company}`);
  }
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
  // Postings that never state a requirement stay visible — hiding them would
  // drop a third of the list on a guess.
  if (maxYoe) {
    where.push('(j.yoe_min IS NULL OR j.yoe_min <= ?)');
    params.push(Number(maxYoe));
  }
  const age = ageFilter(within, withinBy);
  if (age) {
    where.push(age.sql);
    params.push(age.param);
  }

  const dirSql = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sorts = {
    created: `j.id ${dirSql}`,
    score: `score IS NULL, score ${dirSql}, j.id DESC`,
    company: `j.company COLLATE NOCASE ${dirSql}`,
    posted: `j.posted_at ${dirSql}`,
    updated: `j.updated_at ${dirSql}`,
  };
  const sql =
    LIST_SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${sorts[sort] || sorts.created} LIMIT ${MAX_ROWS}`;

  const safeArr = (v) => {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  let rows = db
    .prepare(sql)
    .all(...params)
    .map(parseJob)
    .map((r) => ({ ...r, pros: safeArr(r.pros), cons: safeArr(r.cons) }));
  if (minScore) rows = rows.filter((r) => r.score != null && r.score >= Number(minScore));

  // Tier is derived from the title, not a column, so it filters here.
  const roles = getSettings().search;
  rows = rows.map((r) => ({ ...r, tier: classifyTier(r.title, roles) }));
  if (tier === 'primary' || tier === 'secondary') rows = rows.filter((r) => r.tier === tier);
  else if (tier === 'none') rows = rows.filter((r) => !r.tier);

  const total = rows.length;
  const size = Number(limit) > 0 ? Number(limit) : 0;
  const start = Math.max(0, Number(offset) || 0);
  const page = size ? rows.slice(start, start + size) : rows.slice(start);

  // Enrich only what is actually being returned.
  const strength = companyStrength();
  const enriched = page.map((r) => {
    const s = strength.get(String(r.company || '').trim().toLowerCase());
    return {
      ...r,
      company_strength: s ? s.strength : 0,
      company_avg_score: s ? s.avgScore : null,
      company_postings: s ? s.postings : 0,
      company_tracked: s ? s.tracked : false,
      company_id: s ? s.companyId : null,
      company_careers_url: s ? s.careersUrl : '',
    };
  });

  return { rows: enriched, total, limit: size, offset: start };
}

/** The rows alone — the long-standing shape, kept for callers that want a list. */
export function listJobs(query = {}) {
  return listJobsPage(query).rows;
}

/**
 * Companies that actually have jobs, busiest first — the option list behind the
 * company picker. Ignored rows are excluded so the picker matches what the list
 * will show; pass { ignored: 'all' } to include them.
 */
export function companyNames({ ignored = '0', matched = 'all' } = {}) {
  const where = ["TRIM(company) != ''"];
  if (ignored !== 'all') where.push('ignored = 0');
  if (matched === '1' || matched === '0') where.push(`matched = ${Number(matched)}`);
  return db
    .prepare(
      `SELECT TRIM(company) AS name, COUNT(*) AS count
       FROM jobs WHERE ${where.join(' AND ')}
       GROUP BY LOWER(TRIM(company))
       ORDER BY count DESC, name COLLATE NOCASE ASC`
    )
    .all();
}
