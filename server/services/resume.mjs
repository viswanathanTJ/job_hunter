// Tailored resume generation: claude -p tailors the master Resume/resume.html
// against the JD, output goes to Resume/<Company>/ following the existing
// career-ops convention (resume.html + job-info.txt + PDF, one page, ../resume.css).
import fs from 'node:fs';
import path from 'node:path';
import { RESUME_ROOT, MASTER_RESUME, CV_MD, readIfExists } from '../paths.mjs';
import { db, nowIso, addEvent, getJob, latestAnalysis, latestResume, setStatus } from '../db.mjs';
import { runClaude, extractText } from './claude.mjs';
import { enqueue, opQueue, opStart, opEnd, opActive } from './ops.mjs';

const pdfName = () => process.env.RESUME_PDF_NAME || 'Viswanathan-T-J-Resume.pdf';

function companySlug(company) {
  return (
    company
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'Company'
  );
}

function resolveDir(job) {
  const existing = latestResume(job.id);
  if (existing) return existing.dir;
  let base = companySlug(job.company);
  // If another job already claimed this folder, disambiguate with the job id.
  const clash = db
    .prepare('SELECT 1 FROM resumes WHERE dir = ? AND job_id != ? LIMIT 1')
    .get(path.join(RESUME_ROOT, base), job.id);
  if (clash || fs.existsSync(path.join(RESUME_ROOT, base, 'job-info.txt'))) {
    const info = readIfExists(path.join(RESUME_ROOT, base, 'job-info.txt'));
    if (!info.includes(job.url)) base = `${base}-${job.id}`;
  }
  return path.join(RESUME_ROOT, base);
}

function buildResumePrompt(job, analysis) {
  const master = readIfExists(MASTER_RESUME);
  const cv = readIfExists(CV_MD);
  const analysisBlock = analysis
    ? `\n=== MATCH ANALYSIS (for emphasis guidance) ===\nScore: ${analysis.score}/5\nPros: ${analysis.pros.join('; ')}\nCons: ${analysis.cons.join('; ')}\n`
    : '';
  return `You are tailoring an existing one-page HTML resume for a specific job posting.

=== MASTER RESUME (HTML) ===
${master}

=== CANONICAL CV (source of truth for every factual claim) ===
${cv}
${analysisBlock}
=== JOB POSTING ===
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
URL: ${job.url}

Description:
${job.description}

=== TAILORING RULES (all mandatory) ===
1. TRUTHFULNESS: Every claim must already exist in the master resume or the CV. Reorder,
   reframe, and emphasise — never invent. No new employers, titles, dates, metrics, tools,
   or projects. Keywords get reformulated, never fabricated.
2. Specifically forbidden: any AWS experience claim; any claim of production Generative-AI
   work (GenAI is coursework/personal exploration only — it may appear only where the CV
   already lists it, e.g. certificates); claiming authorship of tools the candidate merely uses.
3. Keep the EXACT HTML document structure, class names, section order, and inline SVG icons.
   Do not add or remove sections. Do not add any <style> blocks or inline styles.
   Preserve the <span class="kw">…</span> keyword highlighting; you MAY move it onto the
   technology terms most relevant to this job, but only ever wrap real tech/tool names.
4. Change ONLY: the <title>, the role line under the name, the summary text, the wording and
   ordering of experience/project bullets, and the ordering/emphasis of skills — to align
   with this job description.
5. The stylesheet link must be exactly: <link rel="stylesheet" href="../resume.css">
6. ONE PAGE budget: total text content must be the same length or shorter than the master.
   Do not add bullets — only reword or reorder existing ones.
7. Contact details (phone, email, links) must remain byte-identical to the master.

=== OUTPUT ===
Output ONLY the complete tailored HTML document, starting with <!DOCTYPE html>. No markdown
fences, no explanation before or after.`;
}

function cleanHtml(text) {
  let html = text.trim();
  const fence = html.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (fence) html = fence[1].trim();
  const start = html.indexOf('<!DOCTYPE');
  if (start > 0) html = html.slice(start);
  if (!html.startsWith('<!DOCTYPE')) {
    throw new Error(`Model did not return an HTML document. Got: ${html.slice(0, 140)}`);
  }
  // Belt-and-braces: make sure the stylesheet points one level up.
  html = html.replace(/href="resume\.css"/g, 'href="../resume.css"');
  return html;
}

async function renderPdf(htmlPath, pdfPath) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

function countPdfPages(pdfPath) {
  // Chromium writes an uncompressed page tree: /Type /Pages ... /Count N
  try {
    const buf = fs.readFileSync(pdfPath).toString('latin1');
    const m = buf.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/);
    if (m) return parseInt(m[1], 10);
    const pageObjs = (buf.match(/\/Type\s*\/Page[^s]/g) || []).length;
    return pageObjs || null;
  } catch {
    return null;
  }
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
  if (existing && !force && fs.existsSync(existing.html_path)) {
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
    try {
      // Tailoring rewrites an existing master — it does not author one from
      // scratch. Fail fast with an actionable message if the master is absent.
      const master = readIfExists(MASTER_RESUME);
      if (!master.includes('<')) {
        throw new Error(
          `No master resume at ${MASTER_RESUME}. Create Resume/resume.html (+ resume.css) first — tailoring reads and rewrites it per job.`
        );
      }
      const analysis = latestAnalysis(jobId);
      const raw = await runClaude(buildResumePrompt(job, analysis), {
        timeoutMs: 420_000,
        signal: ctrl.signal,
      });
      const html = cleanHtml(extractText(raw));

      const dir = resolveDir(job);
      fs.mkdirSync(dir, { recursive: true });
      const htmlPath = path.join(dir, 'resume.html');
      const pdfPath = path.join(dir, pdfName());
      fs.writeFileSync(htmlPath, html);
      writeJobInfo(dir, job, analysis);

      let pageCount = null;
      try {
        await renderPdf(htmlPath, pdfPath);
        pageCount = await countPdfPages(pdfPath);
      } catch (e) {
        addEvent(jobId, 'pdf_render_failed', { error: String(e.message || e).slice(0, 300) });
      }

      const version = (existing?.version || 0) + 1;
      const info = db
        .prepare(
          `INSERT INTO resumes (job_id, version, dir, html_path, pdf_path, page_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(jobId, version, dir, htmlPath, fs.existsSync(pdfPath) ? pdfPath : null, pageCount, nowIso());
      addEvent(jobId, 'resume_generated', {
        version,
        dir,
        pageCount,
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
    }
  });
}
