// Companies sub-module: scan a company's careers site, keep only jobs that
// match the user's profile, import them, and queue AI analyses.
//
// Supported ATS (auto-detected from the careers URL):
//   workday    {tenant}.{shard}.myworkdayjobs.com — CXS JSON API
//   greenhouse boards.greenhouse.io / job-boards.greenhouse.io
//   lever      jobs.lever.co
//   ashby      jobs.ashbyhq.com
//   jibe       corporate sites with a /api/jobs endpoint (e.g. jobs.comcast.com)
import { db, nowIso, addEvent, parseJob } from '../db.mjs';
import { importJobs } from './importer.mjs';
import { analyzeJob } from './claude.mjs';
import { getProfile } from './profile.mjs';
import { opQueue, opStart, opEnd, opActive } from './ops.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
// Workday's country facet GUIDs are global across tenants.
const WD_COUNTRY = { India: 'c4f78be1a8f14da0ab49ce1162348a5e' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function getCompany(id) {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
  return row ? { ...row, config: safeParse(row.config) } : null;
}

export function listCompanies() {
  return db
    .prepare('SELECT * FROM companies ORDER BY name COLLATE NOCASE')
    .all()
    .map((c) => ({
      ...c,
      config: safeParse(c.config),
      last_scan_summary: safeParse(c.last_scan_summary),
      job_count: db.prepare('SELECT COUNT(*) n FROM jobs WHERE source = ? AND matched = 1').get(`company:${c.name}`).n,
      total_count: db.prepare('SELECT COUNT(*) n FROM jobs WHERE source = ?').get(`company:${c.name}`).n,
      scanning: opActive(`scan:${c.id}`),
    }));
}

function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

/** Detect the ATS + derive adapter config from a pasted careers/jobs URL. */
export function detectAts(careersUrl) {
  const u = new URL(careersUrl);
  const host = u.hostname.toLowerCase();
  if (host.endsWith('.myworkdayjobs.com')) {
    const [tenant, shard] = host.split('.');
    // Path: /{locale?}/{site}/... — locale looks like en-US.
    const segs = u.pathname.split('/').filter(Boolean);
    const site = segs.find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s)) || '';
    if (!site) throw new Error('Could not derive the Workday site name from the URL');
    return { ats: 'workday', config: { tenant, shard, site } };
  }
  if (host.includes('greenhouse.io')) {
    const slug = u.pathname.split('/').filter(Boolean)[0];
    if (!slug) throw new Error('Could not derive the Greenhouse board slug from the URL');
    return { ats: 'greenhouse', config: { slug } };
  }
  if (host === 'jobs.lever.co') {
    const slug = u.pathname.split('/').filter(Boolean)[0];
    if (!slug) throw new Error('Could not derive the Lever slug from the URL');
    return { ats: 'lever', config: { slug } };
  }
  if (host === 'jobs.ashbyhq.com') {
    const slug = u.pathname.split('/').filter(Boolean)[0];
    if (!slug) throw new Error('Could not derive the Ashby slug from the URL');
    return { ats: 'ashby', config: { slug } };
  }
  // Fallback: many corporate "jobs.company.com" sites run Jibe/iCIMS with a
  // JSON API at /api/jobs. Confirmed at scan time; recorded optimistically here.
  return { ats: 'jibe', config: { origin: u.origin } };
}

/** Derive a display name from the careers URL when the user does not give one. */
export function deriveName(careersUrl) {
  const host = new URL(careersUrl).hostname;
  const parts = host.split('.');
  let word = parts[0];
  if (['jobs', 'careers', 'www', 'boards', 'job-boards'].includes(word)) word = parts[1] || word;
  if (host.endsWith('.myworkdayjobs.com')) word = parts[0];
  if (host.includes('greenhouse.io') || host === 'jobs.lever.co' || host === 'jobs.ashbyhq.com') {
    word = new URL(careersUrl).pathname.split('/').filter(Boolean)[0] || word;
  }
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ---------- adapters ----------

async function fetchWorkday(cfg, profile, signal) {
  const base = `https://${cfg.tenant}.${cfg.shard}.myworkdayjobs.com`;
  const pub = `${base}/en-US/${cfg.site}`;
  const cxs = `${base}/wday/cxs/${cfg.tenant}/${cfg.site}/jobs`;
  const page0 = await fetch(pub, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal });
  const cookie = (page0.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const headers = {
    'User-Agent': UA,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: base,
    Referer: `${pub}/jobs`,
    Cookie: cookie,
  };
  const appliedFacets = {};
  const countryId = WD_COUNTRY[profile.locations?.country];
  if (countryId) appliedFacets.locationCountry = [countryId];

  const out = [];
  for (let offset = 0; offset < 2000; offset += 20) {
    let postings = null;
    for (let a = 0; a < 3 && !postings; a++) {
      const res = await fetch(cxs, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({ appliedFacets, limit: 20, offset, searchText: '' }),
      });
      // Quirk: paginated responses can report total=0 while still returning
      // jobPostings — gate on the array, never on total.
      if (res.ok) postings = (await res.json()).jobPostings || [];
      else await sleep(1200);
    }
    if (!postings || !postings.length) break;
    for (const p of postings) {
      out.push({
        title: p.title,
        url: pub + p.externalPath,
        location: (p.locationsText || '').trim(),
        postedAt: (p.postedOn || '').replace('Posted ', ''),
        reqId: (p.bulletFields || [])[0] || '',
      });
    }
    await sleep(350);
  }
  return out;
}

async function fetchGreenhouse(cfg, _profile, signal) {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${cfg.slug}/jobs`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Greenhouse API ${res.status} for board "${cfg.slug}"`);
  const data = await res.json();
  return (data.jobs || []).map((j) => ({
    title: j.title,
    url: j.absolute_url,
    location: j.location?.name || '',
    postedAt: (j.updated_at || '').slice(0, 10),
  }));
}

async function fetchLever(cfg, _profile, signal) {
  const res = await fetch(`https://api.lever.co/v0/postings/${cfg.slug}?mode=json`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Lever API ${res.status} for "${cfg.slug}"`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((j) => ({
    title: j.text,
    url: j.hostedUrl || j.applyUrl,
    location: j.categories?.location || '',
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : '',
    employmentType: j.categories?.commitment || '',
  }));
}

async function fetchAshby(cfg, _profile, signal) {
  const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      operationName: 'ApiJobBoardWithTeams',
      variables: { organizationHostedJobsPageName: cfg.slug },
      query: `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
        jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
          jobPostings { id title locationName employmentType }
        }
      }`,
    }),
  });
  if (!res.ok) throw new Error(`Ashby API ${res.status} for "${cfg.slug}"`);
  const data = await res.json();
  return (data.data?.jobBoard?.jobPostings || []).map((j) => ({
    title: j.title,
    url: `https://jobs.ashbyhq.com/${cfg.slug}/${j.id}`,
    location: j.locationName || '',
    employmentType: j.employmentType || '',
  }));
}

/** Generic corporate careers site: try the Jibe JSON API, then fall back to
 *  sitemap.xml job URLs (Radancy pattern /job/{location}/{title-slug}/{id}/{id},
 *  e.g. jobs.comcast.com). */
async function fetchCareerSite(cfg, _profile, signal) {
  // Attempt 1 — Jibe: /api/jobs?page=N
  try {
    const out = [];
    let total = Infinity;
    for (let page = 1; page <= 20 && out.length < total; page++) {
      const res = await fetch(`${cfg.origin}/api/jobs?page=${page}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal,
      });
      if (!res.ok) throw new Error(`jibe HTTP ${res.status}`);
      const data = await res.json(); // throws on HTML → fallback below
      const jobs = data.jobs || [];
      total = Number(data.totalCount ?? data.total ?? Infinity);
      if (!jobs.length) break;
      for (const item of jobs) {
        const d = item.data || item;
        const url = d.apply_url || d.canonical_url || d.absolute_url || d.url;
        if (!url || !d.title) continue;
        out.push({
          title: d.title,
          url,
          location: [d.city, d.state, d.country].filter(Boolean).join(', ') || d.full_location || '',
          postedAt: (d.posted_date || d.create_date || '').slice(0, 10),
          employmentType: d.employment_type || '',
        });
      }
      await sleep(250);
    }
    if (out.length) return out;
  } catch {
    /* fall through to sitemap */
  }

  // Attempt 2 — Radancy sitemap: /job/{location}/{title-slug}/{siteId}/{jobId}
  const res = await fetch(`${cfg.origin}/sitemap.xml`, { headers: { 'User-Agent': UA }, signal });
  if (!res.ok) throw new Error(`Unsupported careers site: no JSON jobs API and no sitemap.xml at ${cfg.origin} (HTTP ${res.status})`);
  const xml = await res.text();
  const titleCase = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const out = [];
  for (const m of xml.matchAll(/<url>\s*<loc>([^<]+\/job\/[^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) {
    const [, url, lastmod] = m;
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    if (segs[0] !== 'job' || segs.length < 3) continue;
    out.push({
      title: titleCase(segs[2]),
      url,
      location: titleCase(segs[1]),
      postedAt: (lastmod || '').slice(0, 10),
    });
  }
  if (!out.length) throw new Error(`Sitemap at ${cfg.origin} contains no /job/ URLs — unsupported careers site`);
  return out;
}

const ADAPTERS = {
  workday: fetchWorkday,
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  jibe: fetchCareerSite,
  careersite: fetchCareerSite,
};

// ---------- profile matching ----------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (k) => new RegExp(`\\b${esc(k)}\\b`, 'i');

export function matchJob(job, profile) {
  const include = (profile.match?.include || []).filter(Boolean);
  const exclude = (profile.match?.exclude || []).filter(Boolean);
  if (include.length && !include.some((k) => wordRe(k).test(job.title))) return { ok: false, why: 'no include keyword in title' };
  const hit = exclude.find((k) => wordRe(k).test(job.title));
  if (hit) return { ok: false, why: `excluded keyword "${hit}"` };

  const loc = (job.location || '').toLowerCase();
  if (loc) {
    const cities = (profile.locations?.cities || []).map((c) => c.toLowerCase());
    const isRemote = /remote|work from home|wfh/.test(loc);
    const cityOk = cities.length === 0 || cities.some((c) => loc.includes(c));
    const remoteOk = profile.locations?.allowRemote && isRemote;
    if (!cityOk && !remoteOk) return { ok: false, why: `location "${job.location}" outside preferences` };
    if (isRemote && !profile.locations?.allowRemote) return { ok: false, why: 'remote not allowed by profile' };
  }

  const type = (job.employmentType || '').toLowerCase().replace(/[_\s]/g, '-');
  const types = (profile.jobTypes || []).map((t) => t.toLowerCase());
  if (type && types.length && !types.some((t) => type.includes(t.replace(/[_\s]/g, '-')))) {
    return { ok: false, why: `job type "${job.employmentType}" not in preferences` };
  }
  return { ok: true };
}

// ---------- scan orchestration ----------

/**
 * Scan one company: fetch → profile-match → import → (optionally) queue
 * analyses for the newly imported jobs. Runs async; progress via /api/ops.
 */
export function scanCompany(companyId, { analyze = true } = {}) {
  const company = getCompany(companyId);
  if (!company) throw new Error(`Company ${companyId} not found`);
  const key = `scan:${company.id}`;
  if (opActive(key)) return { alreadyRunning: true, opKey: key };

  const ctrl = opQueue(key, { type: 'scan', company: company.name, companyId: company.id });
  (async () => {
    opStart(key);
    try {
      const profile = getProfile();
      // Seeded rows may lack adapter config — derive it from the careers URL
      // once and persist, so pre-seeded and hand-added companies behave alike.
      let { ats, config } = company;
      if (!config || Object.keys(config).length === 0) {
        ({ ats, config } = detectAts(company.careers_url));
        db.prepare('UPDATE companies SET ats = ?, config = ?, updated_at = ? WHERE id = ?').run(
          ats,
          JSON.stringify(config),
          nowIso(),
          company.id
        );
      }
      const adapter = ADAPTERS[ats];
      if (!adapter) throw new Error(`Unsupported ATS "${ats}"`);
      const found = await adapter(config, profile, ctrl.signal);

      const seen = new Set();
      const unique = found.filter((j) => j.url && j.title && !seen.has(j.url) && seen.add(j.url));
      const withCompany = (j) => ({ ...j, company: company.name, jobLink: j.url });
      const matched = [];
      const unmatched = [];
      for (const j of unique) (matchJob(j, profile).ok ? matched : unmatched).push(j);
      const source = `company:${company.name}`;
      // Store everything: matches full-fat (and analyzed), the rest browsable
      // under "All found" — never auto-analyzed, so they cost no AI tokens.
      const result = importJobs(matched.map(withCompany), source, { matched: 1 });
      const rest = importJobs(unmatched.map(withCompany), source, { matched: 0 });

      let queued = 0;
      if (analyze) {
        for (const id of result.ids) {
          analyzeJob(id).catch(() => {}); // self-skips jobs that already have an analysis
          queued++;
        }
      }
      const summary = {
        at: nowIso(),
        found: unique.length,
        matched: matched.length,
        created: result.created,
        updated: result.updated,
        unmatchedStored: rest.created,
        analysesQueued: queued,
      };
      db.prepare('UPDATE companies SET last_scan_at = ?, last_scan_summary = ?, updated_at = ? WHERE id = ?').run(
        nowIso(),
        JSON.stringify(summary),
        nowIso(),
        company.id
      );
      addEvent(null, 'company_scan', { company: company.name, ...summary });
      opEnd(key, 'done', summary);
    } catch (e) {
      if (e.name === 'AbortError' || ctrl.signal.aborted) {
        opEnd(key, 'cancelled');
      } else {
        addEvent(null, 'company_scan_failed', { company: company.name, error: String(e.message || e).slice(0, 300) });
        opEnd(key, 'error', { error: String(e.message || e) });
      }
    }
  })();
  return { opKey: key };
}

/** Queue a scan for every enabled company. Returns queue counts. */
export function scanAllCompanies({ analyze = true } = {}) {
  const rows = db.prepare('SELECT id FROM companies WHERE enabled = 1 ORDER BY name COLLATE NOCASE').all();
  let queued = 0;
  let skipped = 0;
  for (const { id } of rows) {
    const r = scanCompany(id, { analyze });
    if (r.alreadyRunning) skipped++;
    else queued++;
  }
  return { queued, skipped };
}

function safeParseArr(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Jobs stored for one company, newest analysis attached — the detail view.
 *  matched: '1' (default) | '0' | 'all'. q: title/location substring.
 *  minScore: numeric floor — when set, unscored rows are excluded.
 *  sort: score (default, unscored last) | created | posted | title. */
export function companyJobs(company, { matched = '1', q = '', minScore = '', sort = 'score' } = {}) {
  const where = ['j.source = ?'];
  const params = [`company:${company.name}`];
  if (matched === '1' || matched === '0') {
    where.push('j.matched = ?');
    params.push(Number(matched));
  }
  if (q) {
    where.push('(j.title LIKE ? OR j.location LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const sorts = {
    score: 'score IS NULL, score DESC, j.id DESC',
    created: 'j.id DESC',
    posted: "j.posted_at = '', j.posted_at DESC, j.id DESC",
    title: 'j.title COLLATE NOCASE ASC',
  };
  let rows = db
    .prepare(
      `SELECT j.*,
        (SELECT a.score     FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS score,
        (SELECT a.verdict   FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS verdict,
        (SELECT a.reasoning FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS reasoning,
        (SELECT a.pros      FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS pros,
        (SELECT a.cons      FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS cons,
        (SELECT a.location_check FROM analyses a WHERE a.job_id = j.id ORDER BY a.id DESC LIMIT 1) AS location_check
       FROM jobs j WHERE ${where.join(' AND ')}
       ORDER BY ${sorts[sort] || sorts.score}`
    )
    .all(...params)
    .map(parseJob)
    .map((r) => ({ ...r, pros: safeParseArr(r.pros), cons: safeParseArr(r.cons) }));
  if (minScore) rows = rows.filter((r) => r.score != null && r.score >= Number(minScore));
  return rows;
}
