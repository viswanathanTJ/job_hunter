// Tailored resume generation. claude -p tailors the master resume against the JD
// and the active builder turns that into a PDF; output goes to
// Resume/<Company-JobID>/ (source + job-info.txt + PDF, one A4 page).
//
// The builder is the seam for how a resume is produced — today LaTeX, matching
// Resume/build-tex.sh. This file owns orchestration only: queueing, the output
// directory, the retry, the fallback, and what gets recorded.
import fs from 'node:fs';
import path from 'node:path';
import { RESUME_ROOT } from '../paths.mjs';
import { db, nowIso, addEvent, getJob, latestAnalysis, latestResume, setStatus } from '../db.mjs';
import { runClaude, extractText } from './claude.mjs';
import { enqueue, opQueue, opStart, opEnd, opActive } from './ops.mjs';
import { activeBuilder } from './resume-builders.mjs';

const pdfName = () => process.env.RESUME_PDF_NAME || 'Viswanathan-T-J-Resume.pdf';

function companySlug(company) {
  return (
    company
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'Company'
  );
}

// Dirs held by in-flight generations, so a job re-run while its first run is
// still going does not race itself.
const claimedDirs = new Set();

/** Resolve (and claim) the output dir. Release with releaseDir() when done. */
function claimDir(job) {
  const existing = latestResume(job.id);
  if (existing) {
    claimedDirs.add(existing.dir);
    return existing.dir;
  }
  // Company-JobID for every job, not just on collision: the id keeps two
  // postings at the same company apart, and makes the folder traceable back to
  // the job it was tailored for.
  const dir = path.join(RESUME_ROOT, `${companySlug(job.company)}-${job.id}`);
  claimedDirs.add(dir);
  return dir;
}

function releaseDir(dir) {
  if (dir) claimedDirs.delete(dir);
}

function writeJobInfo(dir, job, analysis) {
  const lines = [
    `Company: ${job.company}`,
    `Role: ${job.title}`,
    `Location: ${job.location}`,
    `URL: ${job.url}`,
    `Posted: ${job.posted_at || 'unknown'}`,
    analysis ? `Match score: ${analysis.score}/5 (${analysis.verdict})` : 'Match score: not analyzed',
    `Generated: ${nowIso()} by job-hunter`,
    '',
    '--- Job description ---',
    job.description,
  ];
  fs.writeFileSync(path.join(dir, 'job-info.txt'), lines.join('\n'));
}

/**
 * Queue resume generation. Skips if a resume already exists on disk (unless force).
 */
export function generateResume(jobId, { force = false } = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const existing = latestResume(jobId);
  // The PDF is the deliverable, so its presence is what "already generated"
  // means — older rows stored their source in html_path, newer ones in source_path.
  if (existing && !force && existing.pdf_path && fs.existsSync(existing.pdf_path)) {
    return Promise.resolve({ skipped: true, resume: existing });
  }

  const key = `resume:${jobId}`;
  if (opActive(key)) return Promise.resolve({ alreadyRunning: true });
  const ctrl = opQueue(key, { type: 'resume', jobId, title: job.title, company: job.company });
  return enqueue(async () => {
    if (ctrl.signal.aborted) {
      addEvent(jobId, 'resume_cancelled', null);
      opEnd(key, 'cancelled');
      return { cancelled: true };
    }
    opStart(key);
    let dir = null;
    try {
      const analysis = latestAnalysis(jobId);
      const builder = activeBuilder();
      const ask = (prompt) =>
        runClaude(prompt, { timeoutMs: 420_000, signal: ctrl.signal }).then((r) =>
          builder.cleanSource(extractText(r))
        );

      let source = await ask(builder.buildPrompt(job, analysis));

      dir = claimDir(job);
      fs.mkdirSync(dir, { recursive: true });
      const sourcePath = path.join(dir, builder.sourceName);
      const pdfPath = path.join(dir, pdfName());
      writeJobInfo(dir, job, analysis);

      // The master fills its single page, so a tailored version that overruns is
      // the expected failure. Give it one chance to trim with the reason fed back,
      // and if it still will not fit, ship the real resume rather than a worse one.
      fs.writeFileSync(sourcePath, source);
      let result = await builder.build(sourcePath, pdfPath);
      if (result.failed) {
        addEvent(jobId, 'resume_retry', { reason: result.reason, pages: result.pages ?? null });
        source = await ask(builder.retryPrompt(job, analysis, source, result.reason));
        fs.writeFileSync(sourcePath, source);
        result = await builder.build(sourcePath, pdfPath);
      }

      let usedBase = false;
      if (result.failed) {
        fs.copyFileSync(builder.basePdfPath(), pdfPath);
        usedBase = true;
        addEvent(jobId, 'resume_fell_back_to_base', { reason: result.reason, pages: result.pages ?? null });
      }
      const pageCount = usedBase ? 1 : result.pageCount;

      const version = (existing?.version || 0) + 1;
      const info = db
        .prepare(
          `INSERT INTO resumes (job_id, version, dir, html_path, source_path, builder, pdf_path, page_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          jobId,
          version,
          dir,
          '', // no HTML is produced any more; source_path is the document
          usedBase ? null : sourcePath,
          usedBase ? `${builder.key}:base` : builder.key,
          fs.existsSync(pdfPath) ? pdfPath : null,
          pageCount,
          nowIso()
        );
      addEvent(jobId, 'resume_generated', {
        version,
        dir,
        pageCount,
        usedBase,
        resumeId: Number(info.lastInsertRowid),
      });
      const fresh = getJob(jobId);
      if (['new', 'reviewed'].includes(fresh.status)) setStatus(jobId, 'resume_generated', { by: 'resume' });
      opEnd(key, 'done', { pageCount });
      return { skipped: false, resume: latestResume(jobId) };
    } catch (e) {
      if (e.cancelled || ctrl.signal.aborted) {
        addEvent(jobId, 'resume_cancelled', null);
        opEnd(key, 'cancelled');
        return { cancelled: true };
      }
      addEvent(jobId, 'resume_failed', { error: String(e.message || e).slice(0, 500) });
      opEnd(key, 'error', { error: String(e.message || e) });
      throw e;
    } finally {
      releaseDir(dir);
    }
  });
}
