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

// 3b. Same posting under different tracking params must NOT duplicate (#dedup)
const withTracking = {
  ...fixture.jobs[0],
  jobLink: fixture.jobs[0].jobLink + '?position=59&refId=ABC%3D%3D&trackingId=XYZ%3D%3D',
};
const rDup = importJobs([withTracking], 'fixture');
check('tracking-param variant creates no new row', rDup.created === 0);
check('still 3 jobs after tracking variant', db.prepare('SELECT COUNT(*) n FROM jobs').get().n === 3);

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

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
