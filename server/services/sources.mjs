// Job-source descriptors. Each one knows how to configure itself from env,
// build the Apify actor input for its provider, and parse that actor's dataset
// items into the importer's canonical shape. Add a provider by adding a
// descriptor here and registering it in SOURCES.
import { stripHtml } from './apify.mjs';
import { getSettings } from './settings.mjs';
import { normalizePosted } from './posted.mjs';
import { tierQuery } from './tiers.mjs';

const RECENT_DAYS = 7;
const recentCutoff = () => new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
const MAX_ITEMS = 50;

// --- LinkedIn (via curious_coder~linkedin-jobs-scraper) --------------------

function linkedinUrls({ query, locations, lookbackHours, includeRemoteIndia, includeRemoteAnywhere }) {
  const k = encodeURIComponent(query);
  const r = lookbackHours * 3600;
  const urls = [];
  // On-site (1) + hybrid (3) in each configured location.
  for (const loc of locations.length ? locations : ['India']) {
    urls.push(
      `https://www.linkedin.com/jobs/search/?keywords=${k}&location=${encodeURIComponent(loc)}&f_TPR=r${r}&f_WT=1%2C3&sortBy=DD`
    );
  }
  // Remote within India.
  if (includeRemoteIndia) {
    urls.push(`https://www.linkedin.com/jobs/search/?keywords=${k}&location=India&f_TPR=r${r}&f_WT=2&sortBy=DD`);
  }
  // Remote anywhere (no location) — off by default; this is what returned US jobs.
  if (includeRemoteAnywhere) {
    urls.push(`https://www.linkedin.com/jobs/search/?keywords=${k}&f_TPR=r${r}&f_WT=2&sortBy=DD`);
  }
  return urls;
}

/** URLs for every enabled tier. Falls back to the plain query when no roles are set. */
function tieredLinkedinUrls(c) {
  const queries = [];
  const primary = tierQuery(c.search?.primary);
  const secondary = tierQuery(c.search?.secondary);
  if (primary) queries.push(primary);
  else if (c.query) queries.push(c.query);
  if (c.search?.includeSecondary && secondary) queries.push(secondary);
  return queries.flatMap((query) => linkedinUrls({ ...c, query }));
}

export const linkedinSource = {
  key: 'linkedin',
  label: 'LinkedIn',
  config: () => {
    const s = getSettings();
    return {
      token: s.apifyToken,
      actor: s.linkedin.actor,
      query: s.linkedin.query,
      locations: s.linkedin.locations,
      lookbackHours: s.linkedin.lookbackHours,
      includeRemoteIndia: s.linkedin.includeRemoteIndia,
      includeRemoteAnywhere: s.linkedin.includeRemoteAnywhere,
      search: s.search,
      count: s.fetchCount,
    };
  },
  // Each tier is one OR-joined keyword search, so adding secondary roles costs
  // one extra URL per location rather than one per role.
  buildInput: (c) => ({ urls: tieredLinkedinUrls(c), scrapeCompany: false, count: c.count }),
  parseItems(items) {
    const jobs = [];
    const seen = new Set();
    const cutoff = recentCutoff();
    for (const j of items || []) {
      const jobLink = j.link || j.jobUrl || j.url || '';
      if (!jobLink || seen.has(jobLink)) continue;
      const postedAt = normalizePosted(j.postedAt || j.postedDate || j.postedTime);
      if (postedAt && postedAt < cutoff) continue;
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
      if (jobs.length >= MAX_ITEMS) break;
    }
    return jobs;
  },
};

// --- Naukri (via a configurable Apify Naukri scraper) ----------------------
//
// Naukri Apify actors vary in their input schema and output field names, so we
// (a) build a Naukri search URL AND pass keyword/location fields, covering the
// two common input styles, and (b) read a wide set of possible output keys.
// The actor id is required (no safe default) — set APIFY_NAUKRI_ACTOR in .env.

const NAUKRI_BASE = 'https://www.naukri.com';

// The scraper reports jdURL as a site-relative path ("/job-listings-…"). Stored
// as-is it resolves against the dashboard's own origin, so "Open posting" lands
// on localhost. Absolutize on the way in, where the base is known.
const naukriAbs = (u) => {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return s.startsWith('/') ? NAUKRI_BASE + s : `${NAUKRI_BASE}/${s}`;
};

const naukriSlug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function naukriUrl(query, location) {
  // Naukri search URLs look like: naukri.com/full-stack-developer-jobs-in-bengaluru
  const loc = (location || '').trim();
  const path = loc ? `${naukriSlug(query)}-jobs-in-${naukriSlug(loc)}` : `${naukriSlug(query)}-jobs`;
  const qs = new URLSearchParams({ k: query, ...(loc ? { l: loc } : {}) });
  return `https://www.naukri.com/${path}?${qs.toString()}`;
}

// Naukri's work-from-home filter is wfhType=2 (remote within India).
function naukriRemoteUrl(query) {
  const qs = new URLSearchParams({ k: query, wfhType: '2' });
  return `https://www.naukri.com/${naukriSlug(query)}-jobs?${qs.toString()}`;
}

export const naukriSource = {
  key: 'naukri',
  label: 'Naukri',
  config: () => {
    const s = getSettings();
    return {
      token: s.apifyToken,
      actor: s.naukri.actor,
      query: s.naukri.query,
      locations: s.naukri.locations,
      includeRemote: s.naukri.includeRemote,
      search: s.search,
      count: s.fetchCount,
    };
  },
  buildInput: (c) => {
    const locs = c.locations.length ? c.locations : [''];
    const queries = [tierQuery(c.search?.primary) || c.query];
    if (c.search?.includeSecondary && tierQuery(c.search?.secondary)) queries.push(tierQuery(c.search.secondary));
    const urls = queries.flatMap((query) => locs.map((loc) => naukriUrl(query, loc)));
    if (c.includeRemote) for (const query of queries) urls.push(naukriRemoteUrl(query));
    return {
      // Naukri actors disagree on input shape, so send every common spelling and
      // let the actor pick out what it understands.
      startUrls: urls.map((url) => ({ url })),
      urls,
      keyword: queries[0],
      location: locs.join(', '),
      maxItems: c.count,
      count: c.count,
      // epicscrapers~naukri-scraper keys. Search results carry only a summary
      // description, and this app needs the full text to score and to read
      // years/work-mode out of, so the extra detail fetch is required.
      maxResultsPerQuery: c.count,
      fetchAdditionalDetails: true,
      sort: 'date',
    };
  },
  parseItems(items) {
    const jobs = [];
    const seen = new Set();
    const cutoff = recentCutoff();
    for (const j of items || []) {
      const jobLink = naukriAbs(j.jdURL || j.jobUrl || j.url || j.link || j.jobLink || '');
      if (!jobLink || seen.has(jobLink)) continue;
      const rawDesc = j.jobDescription || j.description || j.jobDescriptionHtml || j.jd || '';
      const jobDescription = /<[a-z][\s\S]*>/i.test(rawDesc) ? stripHtml(rawDesc) : String(rawDesc).trim();
      if (!jobDescription || jobDescription.length < 50) continue;
      const postedAt = normalizePosted(j.createdDate || j.postedAt || j.footerPlaceholderLabel);
      if (postedAt && postedAt < cutoff) continue;
      const location = Array.isArray(j.placeholders)
        ? (j.placeholders.find((p) => p?.type === 'location')?.label || '')
        : j.locationLabel || j.location || j.jobLocation || '';
      // Some actors state the minimum years outright — far better than reading
      // it back out of the prose.
      const stated = Number(j.minimumExperience);
      const yoeMin = Number.isFinite(stated) && stated >= 0 && stated <= 25 ? stated : null;
      jobs.push({
        title: j.title || j.jobTitle || j.designation || 'No Title',
        company: j.companyName || j.company || 'Unknown Company',
        location,
        postedAt,
        employmentType: j.employmentType || j.jobType || '',
        seniorityLevel: j.experienceLabel || j.experience || j.seniorityLevel || '',
        yoeMin,
        jobLink,
        jobDescription,
      });
      seen.add(jobLink);
      if (jobs.length >= MAX_ITEMS) break;
    }
    return jobs;
  },
};

export const SOURCES = {
  [linkedinSource.key]: linkedinSource,
  [naukriSource.key]: naukriSource,
};

export function getSource(key) {
  return SOURCES[key] || null;
}
