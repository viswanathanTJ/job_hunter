// File-backed app settings (data/settings.json, gitignored with the rest of
// data/). Env vars in .env remain the fallback defaults, so existing setups
// keep working; the UI writes overrides on top. config() in sources.mjs reads
// getSettings() fresh on every fetch, so edits take effect without a restart.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.mjs';
import { tierQuery } from './tiers.mjs';

// Overridable so tests (and any throwaway instance) never read or write the
// real user's settings file, which lives outside the database path.
const SETTINGS_PATH = process.env.JOBDASH_SETTINGS_PATH || path.join(DATA_DIR, 'settings.json');

const splitList = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

// Roles you hunt for, in two tiers. Primary is what you actually want;
// secondary is adjacent work worth seeing but ranked below it.
const DEFAULT_PRIMARY = ['Backend Engineer', 'Full Stack Developer', 'Python Developer', 'Java Developer'];
const DEFAULT_SECONDARY = ['DevOps Engineer', 'Cloud Architect'];

/** Defaults derived from .env so pre-existing env config is honoured. */
function envDefaults() {
  const search = {
    primary: splitList(process.env.JOB_SEARCH_PRIMARY).length
      ? splitList(process.env.JOB_SEARCH_PRIMARY)
      : DEFAULT_PRIMARY,
    secondary: splitList(process.env.JOB_SEARCH_SECONDARY).length
      ? splitList(process.env.JOB_SEARCH_SECONDARY)
      : DEFAULT_SECONDARY,
    // Secondary roles double the searches per fetch, so they are opt-in.
    includeSecondary: process.env.FETCH_SECONDARY === 'true',
  };
  return {
    search,
    apifyToken: process.env.APIFY_TOKEN || '',
    claudeModel: process.env.CLAUDE_MODEL || 'sonnet',
    resumePdfName: process.env.RESUME_PDF_NAME || 'Resume.pdf',
    fetchCount: Number(process.env.FETCH_COUNT || 10),
    // How many analyses / resume generations may run at once (1-20).
    aiConcurrency: Number(process.env.AI_CONCURRENCY || 10),
    linkedin: {
      actor: process.env.APIFY_ACTOR || 'curious_coder~linkedin-jobs-scraper',
      query: process.env.JOB_SEARCH_QUERY || tierQuery(search.primary),
      locations: splitList(process.env.LINKEDIN_LOCATION || 'Bengaluru, Chennai'),
      lookbackHours: Number(process.env.LOOKBACK_HOURS || 24),
      includeRemoteIndia: true,
      includeRemoteAnywhere: false, // OFF by default — this is what leaked US jobs.
    },
    naukri: {
      actor: process.env.APIFY_NAUKRI_ACTOR || '',
      query: process.env.NAUKRI_SEARCH_QUERY || process.env.JOB_SEARCH_QUERY || tierQuery(search.primary),
      locations: splitList(process.env.NAUKRI_LOCATION || 'Bengaluru, Chennai'),
      includeRemote: true, // Naukri is India-only, so "remote" = work-from-home in India.
    },
  };
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) continue;
    const b = base?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(b, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Effective settings: env defaults with the persisted overrides layered on top. */
export function getSettings() {
  return deepMerge(envDefaults(), readFile());
}

/** Persist an override patch (merged into the file, not the env defaults). */
export function saveSettings(patch) {
  const merged = deepMerge(readFile(), patch || {});
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return getSettings();
}
