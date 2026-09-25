import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DASH_ROOT = path.resolve(__dirname, '..');

const envFile = path.join(DASH_ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Where the career-ops checkout lives. This used to assume the dashboard sat
// inside it (DASH_ROOT/..), which silently produced paths that did not exist
// when career-ops is nested inside the dashboard instead — every read returned
// '' and, for resume generation, the model got an empty master resume to tailor
// and answered in prose. Look for the checkout rather than assuming where it is.
const CAREER_OPS_MARKERS = ['cv.md', 'merge-tracker.mjs'];
const looksLikeCareerOps = (dir) => CAREER_OPS_MARKERS.every((m) => fs.existsSync(path.join(dir, m)));

function findCareerOpsRoot() {
  const candidates = [
    process.env.CAREER_OPS_ROOT,       // explicit wins
    path.join(DASH_ROOT, 'career-ops'), // nested inside the dashboard
    path.resolve(DASH_ROOT, '..'),      // dashboard inside the checkout
    DASH_ROOT,                          // same directory
  ].filter(Boolean);
  for (const dir of candidates) {
    if (looksLikeCareerOps(dir)) return dir;
  }
  // Nothing matched: keep the historical value so behaviour is unchanged rather
  // than surprising, and let the callers' existence checks report the problem.
  return path.resolve(DASH_ROOT, '..');
}

export const REPO_ROOT = findCareerOpsRoot();

export const DATA_DIR = path.join(DASH_ROOT, 'data');
export const DB_PATH = process.env.JOBDASH_DB_PATH || path.join(DATA_DIR, 'jobs.db');

// Resumes live in the dashboard's own Resume/ tree (the one carrying resume.html,
// resume.css and the LaTeX build scripts), which is mirrored into career-ops
// rather than being the same directory. Fall back to the career-ops copy only if
// that tree is absent.
const DASH_RESUME = path.join(DASH_ROOT, 'Resume');
export const RESUME_ROOT =
  process.env.RESUME_ROOT ||
  (fs.existsSync(DASH_RESUME) ? DASH_RESUME : path.join(REPO_ROOT, 'Resume'));
export const MASTER_RESUME = path.join(RESUME_ROOT, 'resume.html');
export const CV_MD = path.join(REPO_ROOT, 'cv.md');
export const PROFILE_YML = path.join(REPO_ROOT, 'config', 'profile.yml');
export const PROFILE_MD = path.join(REPO_ROOT, 'modes', '_profile.md');
export const RULES_MD = path.join(DASH_ROOT, 'config', 'match-rules.md');
export const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
export const TRACKER_ADD_DIR = path.join(REPO_ROOT, 'batch', 'tracker-additions');
export const MERGE_TRACKER = path.join(REPO_ROOT, 'merge-tracker.mjs');
export const WEB_DIST = path.join(DASH_ROOT, 'web', 'dist');

fs.mkdirSync(DATA_DIR, { recursive: true });

export function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
