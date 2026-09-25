// Bulk operations over a selection of jobs. Status changes are synchronous and
// report per id; analysis and resume runs are queued onto the existing
// sequential op chain and report what was queued rather than waiting.
import { db, STATUSES, nowIso, addEvent, getJob, latestAnalysis, setStatus } from '../db.mjs';
import { analyzeJob } from './claude.mjs';
import { generateResume } from './resume.mjs';

/** The stages a job walks through when you keep pressing "next step". */
export const ADVANCE_ORDER = ['new', 'reviewed', 'resume_generated', 'ready_to_apply', 'applied'];

const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
const missing = (id) => ({ id, skipped: true, reason: 'No such job' });

/**
 * Move each job one stage along ADVANCE_ORDER. Off-pipeline and final stages
 * are left alone, and an unscored job is refused: every stage past "new" claims
 * the job has been reviewed, so advancing one that was never scored quietly
 * fills the pipeline with lies. Pass force to override.
 */
export function bulkAdvance(ids, { force = false } = {}) {
  return cleanIds(ids).map((id) => {
    const job = getJob(id);
    if (!job) return missing(id);
    if (!force && !latestAnalysis(id)) return { id, skipped: true, reason: 'Not scored yet — score it first' };
    const at = ADVANCE_ORDER.indexOf(job.status);
    if (at === -1) return { id, skipped: true, reason: `"${job.status}" is not on the pipeline` };
    if (at === ADVANCE_ORDER.length - 1) return { id, skipped: true, reason: 'Already at the last stage' };
    const to = ADVANCE_ORDER[at + 1];
    setStatus(id, to, { by: 'user', action: 'bulk_advance' });
    return { id, from: job.status, to };
  });
}

/** Set one status across the whole selection. */
export function bulkStatus(ids, to) {
  if (!STATUSES.includes(to)) throw new Error(`Invalid status: ${to}`);
  return cleanIds(ids).map((id) => {
    const job = getJob(id);
    if (!job) return missing(id);
    if (job.status === to) return { id, skipped: true, reason: `Already ${to}` };
    setStatus(id, to, { by: 'user', action: 'bulk_status' });
    return { id, from: job.status, to };
  });
}

/** Queue an analysis for every selected job that has no score yet. */
export function bulkAnalyze(ids, { force = false } = {}) {
  return cleanIds(ids).map((id) => {
    const job = getJob(id);
    if (!job) return missing(id);
    if (!force && latestAnalysis(id)) return { id, skipped: true, reason: 'Already scored' };
    if (!job.matched) db.prepare('UPDATE jobs SET matched = 1 WHERE id = ?').run(id);
    analyzeJob(id, { force }).catch(() => {}); // progress shows via ops + events
    return { id, queued: 'analyze' };
  });
}

/**
 * Score whatever is unscored, then draft a resume only for the jobs that come
 * back at or above `threshold`. Both halves ride the existing sequential queue,
 * so this adds no parallelism — it just chains resume work onto each result.
 */
export function bulkScoreAndResume(ids, { threshold = 4, force = false } = {}) {
  return cleanIds(ids).map((id) => {
    const job = getJob(id);
    if (!job) return missing(id);
    const existing = latestAnalysis(id);
    if (existing && !force) {
      if (existing.score >= threshold) {
        generateResume(id, { force }).catch(() => {});
        return { id, queued: 'resume', score: existing.score };
      }
      return { id, skipped: true, reason: `Scored ${existing.score}, below ${threshold}` };
    }
    if (!job.matched) db.prepare('UPDATE jobs SET matched = 1 WHERE id = ?').run(id);
    analyzeJob(id, { force })
      .then((r) => {
        const score = r?.analysis?.score;
        if (score != null && score >= threshold) return generateResume(id, { force });
      })
      .catch(() => {});
    return { id, queued: 'analyze+resume' };
  });
}

/** Move jobs into, or out of, the ignored list. */
function setIgnored(ids, flag, reason) {
  const update = db.prepare('UPDATE jobs SET ignored = ?, updated_at = ? WHERE id = ?');
  return cleanIds(ids).map((id) => {
    const job = getJob(id);
    if (!job) return missing(id);
    if (Boolean(job.ignored) === Boolean(flag)) return { id, skipped: true, reason: flag ? 'Already ignored' : 'Not ignored' };
    update.run(flag ? 1 : 0, nowIso(), id);
    addEvent(id, flag ? 'ignored' : 'restored', reason ? { reason } : null);
    return { id, to: flag ? 'ignored' : 'active' };
  });
}

export const bulkIgnore = (ids) => setIgnored(ids, true, 'Ignored by hand');
export const bulkRestore = (ids) => setIgnored(ids, false);

export const BULK_ACTIONS = {
  advance: (ids, opts) => bulkAdvance(ids, opts),
  status: (ids, opts) => bulkStatus(ids, opts.to),
  analyze: (ids, opts) => bulkAnalyze(ids, opts),
  score_and_resume: (ids, opts) => bulkScoreAndResume(ids, opts),
  ignore: (ids) => bulkIgnore(ids),
  restore: (ids) => bulkRestore(ids),
};
