// Company-reputation analysis: what employees say, headcount, ratings, and a
// fit verdict for THIS candidate. Runs through the same headless `claude -p`
// queue as job analysis, but web-enabled (small firms aren't in model memory)
// and cached per-company so it isn't re-run for every job at the same employer.
import { PROFILE_YML, PROFILE_MD, readIfExists } from '../paths.mjs';
import { db, nowIso, addEvent, companyKey, latestCompanyReport } from '../db.mjs';
import { enqueue, opQueue, opStart, opEnd, opActive } from './ops.mjs';
import { runClaude, extractJSON, model } from './claude.mjs';

const VERDICTS = ['good_fit', 'caution', 'avoid'];

function buildCompanyPrompt({ company, location, sampleTitle }) {
  const profileYml = readIfExists(PROFILE_YML);
  const profileMd = readIfExists(PROFILE_MD);
  return `You are a company-reputation researcher helping a job candidate decide whether "${company}" is a good place to work.

Use web search to find CURRENT, real information. Prioritise employee-review sites — Glassdoor and AmbitionBox (India) — plus LinkedIn (for headcount), the company's own site, and recent news. Report what employees actually say: culture, work-life balance, management, pay, growth, and any red flags (layoffs, poor ratings, negative reviews, legal issues, high attrition).

Weigh the fit verdict against this candidate's profile and deal-breakers:
=== PROFILE (config/profile.yml) ===
${profileYml}

=== TARGETING PROFILE (modes/_profile.md) ===
${profileMd}

Company to research: ${company}${location ? ` (a posting is based in ${location})` : ''}${sampleTitle ? `; example open role: ${sampleTitle}` : ''}.

=== OUTPUT ===
Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly:
{
  "rating": <number 0-5 with one decimal, or null if unknown>,
  "rating_source": "<e.g. 'Glassdoor 3.8/5', 'AmbitionBox 4.1/5', or 'unknown'>",
  "headcount": "<approx employees, e.g. '5,000-10,000', or 'unknown'>",
  "founded": "<year or 'unknown'>",
  "hq": "<HQ location or 'unknown'>",
  "industry": "<industry or 'unknown'>",
  "verdict": "good_fit" | "caution" | "avoid",
  "summary": "<3-6 sentences on what people say about working there>",
  "pros": ["what employees praise", ...],
  "cons": ["complaint or red flag", ...],
  "metrics": [{"label": "Work-life balance", "value": "3.5/5"}, {"label": "Attrition", "value": "high"}],
  "sources": ["Glassdoor", "AmbitionBox", "LinkedIn"]
}
Rules: Use real data from web search. If a field is genuinely unavailable, use "unknown" (or null for rating) — NEVER invent numbers, reviews, or sources. 3-6 pros and 1-6 cons, each one sentence. "verdict" reflects fit for THIS candidate given their profile and deal-breakers.`;
}

const strArr = (v) => (Array.isArray(v) ? v.map(String) : []);
const metricArr = (v) =>
  Array.isArray(v)
    ? v.filter((m) => m && m.label != null).map((m) => ({ label: String(m.label), value: String(m.value ?? '') }))
    : [];

/**
 * Queue a company-reputation analysis. Cached per-company; skips if a report
 * exists (unless force). Runs on the shared sequential AI queue.
 */
export function analyzeCompany({ company, location = '', sampleTitle = '', jobId = null }, { force = false } = {}) {
  const key = companyKey(company);
  if (!key) throw new Error('company is required');
  const existing = latestCompanyReport(company);
  if (existing && !force) return Promise.resolve({ skipped: true, report: existing });

  const opKey = `company:${key}`;
  if (opActive(opKey)) return Promise.resolve({ alreadyRunning: true });
  const ctrl = opQueue(opKey, { type: 'company', jobId, company });

  return enqueue(async () => {
    if (ctrl.signal.aborted) {
      opEnd(opKey, 'cancelled');
      return { cancelled: true };
    }
    opStart(opKey);
    try {
      const raw = await runClaude(buildCompanyPrompt({ company, location, sampleTitle }), {
        signal: ctrl.signal,
        allowWeb: true,
        timeoutMs: 420_000,
      });
      const p = extractJSON(raw);
      const rating = p.rating == null || p.rating === '' ? null : Math.max(0, Math.min(5, Number(p.rating)));
      const verdict = VERDICTS.includes(p.verdict) ? p.verdict : 'caution';
      const now = nowIso();
      db.prepare(
        `INSERT INTO company_reports
           (company_key, company, rating, rating_source, headcount, founded, hq, industry,
            verdict, summary, pros, cons, metrics, sources, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(company_key) DO UPDATE SET
           rating=excluded.rating, rating_source=excluded.rating_source, headcount=excluded.headcount,
           founded=excluded.founded, hq=excluded.hq, industry=excluded.industry, verdict=excluded.verdict,
           summary=excluded.summary, pros=excluded.pros, cons=excluded.cons, metrics=excluded.metrics,
           sources=excluded.sources, model=excluded.model, updated_at=excluded.updated_at`
      ).run(
        key,
        company,
        rating,
        String(p.rating_source || ''),
        String(p.headcount || ''),
        String(p.founded || ''),
        String(p.hq || ''),
        String(p.industry || ''),
        verdict,
        String(p.summary || ''),
        JSON.stringify(strArr(p.pros)),
        JSON.stringify(strArr(p.cons)),
        JSON.stringify(metricArr(p.metrics)),
        JSON.stringify(strArr(p.sources)),
        model(),
        now,
        now
      );
      if (jobId) addEvent(jobId, 'company_analyzed', { company, verdict, rating });
      opEnd(opKey, 'done', { verdict, rating });
      return { skipped: false, report: latestCompanyReport(company) };
    } catch (e) {
      if (e.cancelled || ctrl.signal.aborted) {
        opEnd(opKey, 'cancelled');
        return { cancelled: true };
      }
      if (jobId) addEvent(jobId, 'company_analysis_failed', { error: String(e.message || e).slice(0, 500) });
      opEnd(opKey, 'error', { error: String(e.message || e) });
      throw e;
    }
  });
}
