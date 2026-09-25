// User matching profile (data/profile.json) — the single editable source for
// everything the app matches and filters on: languages, target roles/topics,
// include/exclude keywords, locations, work mode, job type. The Profile page
// edits this; the company scanner and the analyzer prompt both read it fresh.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.mjs';

// Overridable so tests never read or write the real user's profile, which
// lives outside the database path.
const PROFILE_PATH = process.env.JOBDASH_PROFILE_PATH || path.join(DATA_DIR, 'profile.json');

/** Defaults seeded from the career-ops profile (config/profile.yml, portals.yml). */
export function profileDefaults() {
  return {
    languages: ['Python', 'Java', 'JavaScript', 'TypeScript', 'SQL', 'Shell'],
    roles: ['Backend Engineer', 'Senior Backend Engineer', 'Full-Stack Engineer', 'Platform Engineer'],
    topics: ['Microservices', 'Distributed Systems', 'REST APIs', 'Kafka', 'CI/CD', 'Agentic AI'],
    match: {
      // Title must contain ≥1 include keyword (word-boundary, case-insensitive) …
      include: [
        'Backend', 'Back End', 'Software Engineer', 'Software Developer', 'SDE',
        'Full Stack', 'Fullstack', 'Full-Stack', 'Platform Engineer', 'DevOps',
        'Site Reliability', 'SRE', 'API', 'Microservices', 'Distributed Systems',
        'Java', 'Spring', 'Python', 'FastAPI', 'Django', 'Flask', 'Go', 'Golang',
      ],
      // … and 0 exclude keywords. Node.js is excluded per user preference
      // (2026-07-20): Node-primary roles are a stack mismatch.
      exclude: [
        'Intern', 'Internship', 'Junior', 'Manager', 'Director', 'Sales',
        'Principal', 'Distinguished', 'Staff', 'Architect',
        '.NET', 'PHP', 'Ruby', 'iOS', 'Android', 'Embedded', 'Salesforce',
        'SAP', 'Mainframe', 'COBOL', 'Node', 'Node.js',
      ],
    },
    locations: {
      country: 'India',
      cities: ['Chennai', 'Bengaluru', 'Bangalore'],
      allowRemote: true,
    },
    workModes: ['remote', 'hybrid', 'on-site'],
    jobTypes: ['full-time'],
    // Drives how the analyzer weighs a posting's years-of-experience ask.
    yearsExperience: 4,
    // Postings asking for MORE than this many years are moved straight to the
    // ignored list on arrival, before any Claude analysis is spent on them.
    // 0 turns the rule off.
    maxYoeAsk: 5,
    minScore: 4,
  };
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function getProfile() {
  const saved = readFile();
  if (!saved) return profileDefaults();
  // Shallow-merge top-level keys over defaults so new fields added in future
  // versions appear without wiping the user's saved values.
  const d = profileDefaults();
  return { ...d, ...saved, match: { ...d.match, ...(saved.match || {}) }, locations: { ...d.locations, ...(saved.locations || {}) } };
}

export function saveProfile(next) {
  const clean = { ...getProfile(), ...(next || {}) };
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(clean, null, 2));
  return getProfile();
}
