// Job-source descriptors. Each one knows how to configure itself from env,
// build the Apify actor input for its provider, and parse that actor's dataset
// items into the importer's canonical shape. Add a provider by adding a
// descriptor here and registering it in SOURCES.
import { stripHtml } from './apify.mjs';
import { getSettings } from './settings.mjs';

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
      count: s.fetchCount,
    };
  },
  buildInput: (c) => ({ urls: linkedinUrls(c), scrapeCompany: false, count: c.count }),
  parseItems(items) {
    const jobs = [];
    const seen = new Set();
    const cutoff = recentCutoff();
    for (const j of items || []) {
      const jobLink = j.link || j.jobUrl || j.url || '';
      if (!jobLink || seen.has(jobLink)) continue;
      const postedAt = j.postedAt || '';
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

function naukriUrl(query, location) {
  // Naukri search URLs look like: naukri.com/full-stack-developer-jobs-in-bengaluru
  const slug = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const kSlug = slug(query);
  const loc = (location || '').trim();
  const path = loc ? `${kSlug}-jobs-in-${slug(loc)}` : `${kSlug}-jobs`;
  const qs = new URLSearchParams({ k: query, ...(loc ? { l: loc } : {}) });
  return `https://www.naukri.com/${path}?${qs.toString()}`;
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
      count: s.fetchCount,
    };
  },
  buildInput: (c) => {
    const locs = c.locations.length ? c.locations : [''];
    const urls = locs.map((loc) => naukriUrl(c.query, loc));
    return {
      // Different Naukri actors accept different keys — provide the common ones.
      startUrls: urls.map((url) => ({ url })),
      urls,
      keyword: c.query,
      location: locs.join(', '),
      maxItems: c.count,
      count: c.count,
    };
  },
  parseItems(items) {
    const jobs = [];
    const seen = new Set();
    const cutoff = recentCutoff();
    for (const j of items || []) {
      const jobLink = j.jdURL || j.jobUrl || j.url || j.link || j.jobLink || '';
      if (!jobLink || seen.has(jobLink)) continue;
      const rawDesc = j.jobDescription || j.description || j.jobDescriptionHtml || j.jd || '';
      const jobDescription = /<[a-z][\s\S]*>/i.test(rawDesc) ? stripHtml(rawDesc) : String(rawDesc).trim();
      if (!jobDescription || jobDescription.length < 50) continue;
      const postedAt = normalizeNaukriDate(j.createdDate || j.postedAt || j.footerPlaceholderLabel || '');
      if (postedAt && postedAt < cutoff) continue;
      const location = Array.isArray(j.placeholders)
        ? (j.placeholders.find((p) => p?.type === 'location')?.label || '')
        : j.location || j.jobLocation || '';
      jobs.push({
        title: j.title || j.jobTitle || j.designation || 'No Title',
        company: j.companyName || j.company || 'Unknown Company',
        location,
        postedAt,
        employmentType: j.employmentType || j.jobType || '',
        seniorityLevel: j.experience || j.seniorityLevel || '',
        jobLink,
        jobDescription,
      });
      seen.add(jobLink);
      if (jobs.length >= MAX_ITEMS) break;
    }
    return jobs;
  },
};

/** Naukri exposes posted dates as ISO, epoch ms, or "3 Days Ago" labels. */
function normalizeNaukriDate(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10);
  if (/^\d{10,}$/.test(String(v))) return new Date(Number(v)).toISOString().slice(0, 10);
  const m = String(v).match(/(\d+)\s*(day|hour|week|month)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const days = unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : unit === 'hour' ? 0 : n;
    return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  }
  return ''; // Unknown format — let it through (no recency filter) rather than drop.
}

export const SOURCES = {
  [linkedinSource.key]: linkedinSource,
  [naukriSource.key]: naukriSource,
};

export function getSource(key) {
  return SOURCES[key] || null;
}
