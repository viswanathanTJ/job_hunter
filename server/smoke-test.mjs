// Offline smoke test: exercises DB, importer idempotency, status transitions,
// notes, and stats — no Apify, no claude, no network.
process.env.JOBDASH_DB_PATH = new URL('../data/smoke.db', import.meta.url).pathname;
import fs from 'node:fs';

for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(process.env.JOBDASH_DB_PATH + suffix);
  } catch {}
}

const { db, setStatus, jobWithDetails, latestAnalysis } = await import('./db.mjs');
const { importJobs } = await import('./services/importer.mjs');
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/sample-jobs.json', import.meta.url), 'utf8'));

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond) failures++;
}

// 1. Import
const r1 = importJobs(fixture.jobs, 'fixture');
check('import creates 3 jobs', r1.created === 3 && r1.updated === 0);

// 2. Idempotent re-import
const r2 = importJobs(fixture.jobs, 'fixture');
check('re-import creates nothing', r2.created === 0 && r2.updated === 0 && r2.skipped === 3);

// 3. Changed description updates in place
const changed = { ...fixture.jobs[0], jobDescription: fixture.jobs[0].jobDescription + ' UPDATED.' };
const r3 = importJobs([changed], 'fixture');
check('changed description updates, not duplicates', r3.updated === 1 && r3.created === 0);
check('still 3 jobs total', db.prepare('SELECT COUNT(*) n FROM jobs').get().n === 3);

// 4. Status transitions + events
const id = r1.ids[0];
setStatus(id, 'reviewed');
setStatus(id, 'ready_to_apply');
const detail = jobWithDetails(id);
check('status is ready_to_apply', detail.status === 'ready_to_apply');
check('events recorded', detail.events.length >= 3);

// 5. Invalid status rejected
let threw = false;
try {
  setStatus(id, 'bogus');
} catch {
  threw = true;
}
check('invalid status rejected', threw);

// 6. Notes
db.prepare('INSERT INTO notes (job_id, body, created_at) VALUES (?, ?, ?)').run(id, 'test note', new Date().toISOString());
check('note stored', jobWithDetails(id).notes.length === 1);

// 7. Analysis storage round-trip (direct insert, no claude)
db.prepare(
  `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
   VALUES (?, 4.2, 'YES', '["p1","p2"]', '["c1"]', 'good fit', 'Bengaluru hybrid — allowed', 'test', ?)`
).run(id, new Date().toISOString());
const a = latestAnalysis(id);
check('analysis round-trip', a.score === 4.2 && a.pros.length === 2 && a.verdict === 'YES');

// 8. Matched flag: company scans store everything; unmatched rows carry matched=0
const unJob = { title: 'Unmatched Role', jobLink: 'https://x.test/jobs/unmatched-1', company: 'X' };
const un = importJobs([unJob], 'company:X', { matched: 0 });
const unId = un.ids[0];
const flagOf = (jobId) => db.prepare('SELECT matched FROM jobs WHERE id = ?').get(jobId).matched;
check('default import is matched=1', flagOf(id) === 1);
check('unmatched import stores matched=0', flagOf(unId) === 0);

// 9. Promotion: a matched re-import flips 0 → 1
importJobs([unJob], 'company:X', { matched: 1 });
check('re-import promotes to matched=1', flagOf(unId) === 1);

// 10. Demotion only while never analyzed
importJobs([unJob], 'company:X', { matched: 0 });
check('unanalyzed job demotes to matched=0', flagOf(unId) === 0);
importJobs([unJob], 'company:X', { matched: 1 });
db.prepare(
  `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
   VALUES (?, 3.5, 'NO', '["cheap pro"]', '["one con"]', 'meh', '', 'test', ?)`
).run(unId, new Date().toISOString());
importJobs([unJob], 'company:X', { matched: 0 });
check('analyzed job is never demoted', flagOf(unId) === 1);

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
