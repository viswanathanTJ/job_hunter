// Headless Claude runner: all AI processing goes through the user's Claude
// subscription via `claude -p`. No tools, all context inlined, strict JSON out.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { CV_MD, PROFILE_YML, PROFILE_MD, RULES_MD, readIfExists } from '../paths.mjs';
import { db, nowIso, addEvent, getJob, latestAnalysis, setStatus } from '../db.mjs';
import { enqueue, opQueue, opStart, opEnd, opActive } from './ops.mjs';

const model = () => process.env.CLAUDE_MODEL || 'sonnet';

function cancelledError() {
  return Object.assign(new Error('cancelled'), { cancelled: true });
}

export function runClaude(prompt, { timeoutMs = 300_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    // cwd = tmpdir so the headless run doesn't load the career-ops project
    // context (CLAUDE.md etc.) — the prompt carries everything it needs.
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', model()], {
      cwd: os.tmpdir(),
      env: process.env,
    });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(val);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`claude -p timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, cancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (signal?.aborted) return finish(reject, cancelledError());
      if (code !== 0) finish(reject, new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      else finish(resolve, out);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function extractText(raw) {
  // --output-format json wraps the reply in an envelope with a `result` field.
  try {
    const env = JSON.parse(raw);
    if (env && typeof env.result === 'string') return env.result;
  } catch {
    /* raw text fallthrough */
  }
  return raw;
}

export function extractJSON(raw) {
  const text = extractText(raw);
  try {
    return JSON.parse(text);
  } catch {
    /* try harder */
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* keep going */
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      /* fail below */
    }
  }
  throw new Error(`No parseable JSON in model output: ${text.slice(0, 200)}`);
}

function buildAnalysisPrompt(job) {
  const cv = readIfExists(CV_MD);
  const profileYml = readIfExists(PROFILE_YML);
  const profileMd = readIfExists(PROFILE_MD);
  const rules = readIfExists(RULES_MD);
  return `You are a strict career-fit evaluator. Evaluate ONE job posting against the candidate's profile below.

=== CANDIDATE CV (cv.md) ===
${cv}

=== PROFILE (config/profile.yml) ===
${profileYml}

=== TARGETING PROFILE (modes/_profile.md) ===
${profileMd}

=== HARD MATCH RULES ===
${rules}

=== JOB POSTING ===
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Posted: ${job.posted_at}
Employment type: ${job.employment_type}
Seniority: ${job.seniority}
URL: ${job.url}

Description:
${job.description}

=== OUTPUT ===
Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly:
{
  "score": <number 0-5, one decimal>,
  "verdict": "YES" | "NO",
  "pros": ["specific matching factor citing the JD and CV", ...],
  "cons": ["specific gap or disqualifier", ...],
  "reasoning": "<3-6 sentences explaining the score>",
  "location_check": "<one sentence applying the location policy to this posting>"
}
Rules: verdict must be NO if any hard rule fails, regardless of skills match. 3-6 pros and 1-5 cons, each one sentence. Score 4.0+ only when the candidate should actually apply.`;
}

/**
 * Queue an analysis for a job. Skips if already analyzed (unless force).
 * Returns { skipped } synchronously-resolved, or a promise that resolves
 * with the new analysis after the queued claude run completes.
 */
export function analyzeJob(jobId, { force = false } = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const existing = latestAnalysis(jobId);
  if (existing && !force) return Promise.resolve({ skipped: true, analysis: existing });

  const key = `analyze:${jobId}`;
  if (opActive(key)) return Promise.resolve({ alreadyRunning: true });
  const ctrl = opQueue(key, { type: 'analyze', jobId, title: job.title, company: job.company });
  return enqueue(async () => {
    if (ctrl.signal.aborted) {
      addEvent(jobId, 'analysis_cancelled', null);
      opEnd(key, 'cancelled');
      return { cancelled: true };
    }
    opStart(key);
    try {
      const raw = await runClaude(buildAnalysisPrompt(job), { signal: ctrl.signal });
      const parsed = extractJSON(raw);
      const score = Math.max(0, Math.min(5, Number(parsed.score) || 0));
      const verdict = String(parsed.verdict || '').toUpperCase().startsWith('Y') ? 'YES' : 'NO';
      const pros = Array.isArray(parsed.pros) ? parsed.pros.map(String) : [];
      const cons = Array.isArray(parsed.cons) ? parsed.cons.map(String) : [];
      const info = db
        .prepare(
          `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          jobId,
          score,
          verdict,
          JSON.stringify(pros),
          JSON.stringify(cons),
          String(parsed.reasoning || ''),
          String(parsed.location_check || ''),
          model(),
          nowIso()
        );
      addEvent(jobId, 'analyzed', { score, verdict, analysisId: Number(info.lastInsertRowid) });
      const fresh = getJob(jobId);
      if (fresh.status === 'new') setStatus(jobId, 'reviewed', { by: 'analysis' });
      opEnd(key, 'done', { score, verdict });
      return { skipped: false, analysis: latestAnalysis(jobId) };
    } catch (e) {
      if (e.cancelled || ctrl.signal.aborted) {
        addEvent(jobId, 'analysis_cancelled', null);
        opEnd(key, 'cancelled');
        return { cancelled: true };
      }
      addEvent(jobId, 'analysis_failed', { error: String(e.message || e).slice(0, 500) });
      opEnd(key, 'error', { error: String(e.message || e) });
      throw e;
    }
  });
}

/** Queue analyses for all jobs missing one. Returns the number queued. */
export function analyzeAll({ force = false } = {}) {
  const rows = force
    ? db.prepare("SELECT id FROM jobs WHERE status NOT IN ('discarded', 'rejected')").all()
    : db
        .prepare(
          `SELECT j.id FROM jobs j
           WHERE j.status NOT IN ('discarded', 'rejected')
             AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.job_id = j.id)`
        )
        .all();
  for (const r of rows) analyzeJob(r.id, { force }).catch(() => {});
  return rows.length;
}
