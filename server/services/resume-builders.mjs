// How a tailored resume gets built, behind one interface.
//
// Today there is exactly one builder — LaTeX, matching Resume/build-tex.sh and
// the resume.pdf it produces. The registry exists so a second pipeline can be
// added without touching resume.mjs: a builder owns its master file, its prompt,
// how it validates what the model returned, and how it turns that into a PDF.
//
// RESUME_BUILDER selects one; it is a constant today rather than a setting,
// because there is nothing else to choose.
import fs from 'node:fs';
import path from 'node:path';
import { RESUME_ROOT, CV_MD, readIfExists } from '../paths.mjs';
import { compileTex, verifyPdf } from './latex.mjs';

/** The shared truthfulness contract — it constrains content, not format. */
const TRUTH_RULES = `1. TRUTHFULNESS: every claim must already exist in the master resume or the CV.
   Reorder, reframe, and emphasise — never invent. No new employers, titles, dates,
   metrics, tools, or projects. Keywords get reformulated, never fabricated.
2. Specifically forbidden: any AWS experience claim; any claim of production
   Generative-AI work (GenAI is coursework/personal exploration only — it may appear
   only where the CV already lists it, e.g. certificates); claiming authorship of
   tools the candidate merely uses.
3. Contact details (phone, email, links) must remain byte-identical to the master.`;

function jobBlock(job, analysis) {
  const analysisBlock = analysis
    ? `\n=== MATCH ANALYSIS (for emphasis guidance) ===\nScore: ${analysis.score}/5\nPros: ${analysis.pros.join('; ')}\nCons: ${analysis.cons.join('; ')}\n`
    : '';
  return `${analysisBlock}
=== JOB POSTING ===
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
URL: ${job.url}

Description:
${job.description}`;
}

const latexBuilder = {
  key: 'latex',
  sourceName: 'resume.tex',

  /** resume-v2.tex is the primary design — the one build-tex.sh builds by default. */
  masterPath: () => path.join(RESUME_ROOT, 'resume-v2.tex'),

  /** Used when tailoring cannot be made to fit; the user gets their real resume. */
  basePdfPath: () => path.join(RESUME_ROOT, 'resume.pdf'),

  buildPrompt(job, analysis) {
    return `You are tailoring an existing one-page LaTeX resume for a specific job posting.

=== MASTER RESUME (LaTeX, compiles to exactly one A4 page) ===
${readIfExists(this.masterPath())}

=== CANONICAL CV (source of truth for every factual claim) ===
${readIfExists(CV_MD)}
${jobBlock(job, analysis)}

=== TAILORING RULES (all mandatory) ===
${TRUTH_RULES}
4. Keep the preamble EXACTLY as given — every \\usepackage, \\newcommand, length,
   and the whole header block up to \\begin{document}. Do not change fonts, margins,
   spacing, or the \\rsection / ritems macros. Do not add packages.
5. Keep the section set and their order unchanged. Do not add or remove sections.
6. Change ONLY: the role/title line, the wording and ordering of bullets within a
   section, and the ordering and emphasis of skills — to align with this posting.
7. ONE PAGE, strictly. The master fills the page already, so every edit must be
   length-neutral or shorter. Do NOT add bullets; reword or reorder the existing
   ones. A resume that runs to two pages is worthless here.
8. Escape LaTeX specials in any text you write (& % $ # _ { } ~ ^ \\).

=== OUTPUT ===
Output ONLY the complete LaTeX document, starting with \\documentclass and ending
with \\end{document}. No markdown fences, no explanation before or after.`;
  },

  /** Fed back after a build that missed the page budget. */
  retryPrompt(job, analysis, previousSource, reason) {
    return `The tailored LaTeX resume below was rejected: ${reason}.

Return it again, trimmed to fit exactly one A4 page. Shorten or merge bullet text —
do not drop a section, and do not change the preamble. Same rules as before:
${TRUTH_RULES}

=== REJECTED DOCUMENT ===
${previousSource}
${jobBlock(job, analysis)}

Output ONLY the corrected LaTeX document, starting with \\documentclass. No fences.`;
  },

  /**
   * Pull the document out of the model's reply, or throw. A refusal or an
   * explanation must never be written to disk as if it were a resume.
   */
  cleanSource(text) {
    let src = String(text || '').trim();
    const fence = src.match(/```(?:la)?tex\s*([\s\S]*?)```/i) || src.match(/```\s*([\s\S]*?)```/);
    if (fence) src = fence[1].trim();
    const start = src.indexOf('\\documentclass');
    if (start > 0) src = src.slice(start);
    if (!src.startsWith('\\documentclass')) throw new Error('Model did not return a LaTeX document');
    if (!src.includes('\\end{document}')) throw new Error('Model returned a truncated LaTeX document');
    return src;
  },

  /** Compile and gate. Returns { pdfPath, pageCount } or { failed, reason }. */
  async build(sourcePath, pdfPath) {
    const produced = await compileTex(sourcePath);
    const gate = verifyPdf(produced, { pageBudget: 1 });
    if (!gate.ok) return { failed: true, reason: gate.reason, pages: gate.pages, produced };
    fs.renameSync(produced, pdfPath);
    return { pdfPath, pageCount: gate.pages };
  },
};

export const RESUME_BUILDERS = { latex: latexBuilder };

/** Constant for now — the seam is here for when it needs to become a setting. */
export const RESUME_BUILDER = 'latex';

export function activeBuilder() {
  const b = RESUME_BUILDERS[RESUME_BUILDER];
  if (!b) throw new Error(`Unknown resume builder: ${RESUME_BUILDER}`);
  return b;
}
