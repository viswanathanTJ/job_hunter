import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DASH_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(DASH_ROOT, '..');

const envFile = path.join(DASH_ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const DATA_DIR = path.join(DASH_ROOT, 'data');
export const DB_PATH = process.env.JOBDASH_DB_PATH || path.join(DATA_DIR, 'jobs.db');

// career-ops integration points
export const RESUME_ROOT = path.join(REPO_ROOT, 'Resume');
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
