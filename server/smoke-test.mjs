// Offline smoke test: exercises DB, importer idempotency, status transitions,
// notes, and stats — no Apify, no claude, no network.
process.env.JOBDASH_DB_PATH = new URL('../data/smoke.db', import.meta.url).pathname;
process.env.JOBDASH_SETTINGS_PATH = new URL('../data/smoke-settings.json', import.meta.url).pathname;
process.env.JOBDASH_PROFILE_PATH = new URL('../data/smoke-profile.json', import.meta.url).pathname;
import fs from 'node:fs';

for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.unlinkSync(process.env.JOBDASH_DB_PATH + suffix);
  } catch {}
}
for (const scratch of [process.env.JOBDASH_SETTINGS_PATH, process.env.JOBDASH_PROFILE_PATH]) {
  try {
    fs.unlinkSync(scratch);
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

// 11. Company detail view — now served by the shared list query
const { listJobs } = await import('./services/joblist.mjs');
importJobs([{ title: 'Stored Only', jobLink: 'https://x.test/jobs/stored-2', company: 'X' }], 'company:X', { matched: 0 });
const coJobs = (f) => listJobs({ company: 'X', sort: 'score', ...f });
check('company view defaults to matched only', coJobs({}).length === 1 && coJobs({})[0].matched === 1);
check('all view shows both rows', coJobs({ matched: 'all' }).length === 2);
check('unmatched view shows stored-only row', coJobs({ matched: '0' }).length === 1 && coJobs({ matched: '0' })[0].title === 'Stored Only');
check('scored rows sort first by default', coJobs({ matched: 'all' })[0].score === 3.5);
check('pros/cons parsed to arrays', coJobs({})[0].pros[0] === 'cheap pro' && coJobs({})[0].cons.length === 1);
check('minScore drops unscored rows', coJobs({ matched: 'all', minScore: '3' }).length === 1);
check('q filters by title', coJobs({ matched: 'all', q: 'Stored' })[0].title === 'Stored Only');

// 12. Age window: `added` is exact, `posted` respects the precision it has
const { ageFilter } = await import('./services/filters.mjs');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;

const ageIds = {};
for (const [key, createdAgo, posted] of [
  ['fresh', 5 * MINUTE, iso(5 * MINUTE)],
  ['hourOld', 90 * MINUTE, iso(90 * MINUTE)],
  ['dayOld', 30 * HOUR, iso(30 * HOUR)],
  ['dateOnly', 30 * HOUR, new Date(Date.now() - 30 * HOUR).toISOString().slice(0, 10)],
  ['noDate', 30 * HOUR, ''],
]) {
  const res = importJobs([{ title: `Age ${key}`, jobLink: `https://age.test/${key}`, company: 'AgeCo', postedAt: posted }], 'fixture');
  ageIds[key] = res.ids[0];
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(iso(createdAgo), ageIds[key]);
}
const ageTitles = (within, withinBy) =>
  listJobs({ within: String(within), withinBy, q: 'Age ' }).map((j) => j.title.replace('Age ', '')).sort();

check('no window returns every row', listJobs({ q: 'Age ' }).length === 5);
check('added 15m keeps only the 5m row', ageTitles(900, 'added').join() === 'fresh');
check('added 2h keeps 5m + 90m rows', ageTitles(2 * 3600, 'added').join() === 'fresh,hourOld');
check('added 2d keeps all dated rows', ageTitles(2 * 86400, 'added').length === 5);
check('posted 15m keeps only the 5m posting', ageTitles(900, 'posted').join() === 'fresh');
check('posted 2h excludes the date-only row', ageTitles(2 * 3600, 'posted').join() === 'fresh,hourOld');
check('posted 3d includes the date-only row', ageTitles(3 * 86400, 'posted').join() === 'dateOnly,dayOld,fresh,hourOld');
check('posted window never matches a blank posted_at', !ageTitles(3 * 86400, 'posted').includes('noDate'));
check('sub-day posted window compares full timestamps', ageFilter(3600, 'posted').param.includes('T'));
check('multi-day posted window compares whole days', ageFilter(3 * 86400, 'posted').param.length === 10);
check('a zero or absent window is no filter', ageFilter('', 'added') === null && ageFilter(0, 'added') === null);

// 13. Bulk status changes
const { bulkAdvance, bulkStatus } = await import('./services/bulk.mjs');
// Each is scored, so the advance guard (section 24) lets them move.
const bulkIds = ['new', 'reviewed', 'ready_to_apply', 'applied'].map((st, i) => {
  const res = importJobs([{ title: `Bulk ${i}`, jobLink: `https://bulk.test/${i}`, company: 'BulkCo' }], 'fixture');
  const bid = res.ids[0];
  db.prepare(
    `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
     VALUES (?, 4.0, 'YES', '[]', '[]', '', '', 'test', ?)`
  ).run(bid, new Date().toISOString());
  if (st !== 'new') setStatus(bid, st);
  return bid;
});
const statusOf = (bid) => db.prepare('SELECT status FROM jobs WHERE id = ?').get(bid).status;

const adv = bulkAdvance(bulkIds);
check('advance moves new → reviewed', statusOf(bulkIds[0]) === 'reviewed');
check('advance moves reviewed → resume_generated', statusOf(bulkIds[1]) === 'resume_generated');
check('advance moves ready_to_apply → applied', statusOf(bulkIds[2]) === 'applied');
check('advance leaves an applied job alone', statusOf(bulkIds[3]) === 'applied');
check('advance reports the skip and its reason', adv.filter((r) => r.skipped).length === 1 && /last stage/i.test(adv.find((r) => r.skipped).reason));
check('advance reports one result per id', adv.length === 4);

bulkStatus(bulkIds.slice(0, 2), 'discarded');
check('bulk status sets every id', statusOf(bulkIds[0]) === 'discarded' && statusOf(bulkIds[1]) === 'discarded');
let bulkThrew = false;
try {
  bulkStatus(bulkIds, 'bogus');
} catch {
  bulkThrew = true;
}
check('bulk status rejects an invalid status', bulkThrew);
check('bulk ignores ids that do not exist', bulkStatus([999999], 'reviewed')[0].skipped === true);

// 14. Priority sort: score bands, newest within each
const { sortJobs } = await import('../web/src/sort.js');
const band = [
  { id: 1, score: 4.5, created_at: iso(5 * DAY) },
  { id: 2, score: null, created_at: iso(2 * DAY) },
  { id: 3, score: 3.4, created_at: iso(1 * HOUR) },
  { id: 4, score: 2.0, created_at: iso(1 * MINUTE) },
  { id: 5, score: 4.1, created_at: iso(1 * MINUTE) },
  { id: 6, score: null, created_at: iso(1 * MINUTE) },
];
check('priority orders good → unscored → mid → poor', sortJobs(band, 'priority').map((j) => j.id).join() === '5,1,6,2,3,4');
check('priority keeps newest first inside a band', sortJobs(band, 'priority')[0].id === 5);
check('priority does not mutate its input', band[0].id === 1);
check('created sort is purely newest-first', sortJobs(band, 'created').map((j) => j.id).join() === '6,5,4,3,2,1');
check('score sort puts unscored last', sortJobs(band, 'score').map((j) => j.id).slice(0, 2).join() === '1,5');

// 15. Facet extraction from description text
const { extractFacets } = await import('./services/facets.mjs');
const yoe = (text) => extractFacets(text, '').yoeMin;
const mode = (text, loc = '') => extractFacets(text, loc).workMode;

check('yoe reads an en-dash range low end', yoe('10–12 years of software development experience') === 10);
check('yoe reads a plus form', yoe('Experience: 8+ years working with relational databases') === 8);
check('yoe reads a hyphen range', yoe('The ideal candidate will have 2-4 years of experience in development') === 2);
check('yoe reads a "to" range', yoe('Experience Range: 0 to 2 Years') === 0);
check('yoe reads "Minimum N years"', yoe('Experience: Minimum 5 years of experience in consulting') === 5);
check('yoe reads a spelled-out number', yoe('At least five years of professional backend engineering experience') === 5);
check('yoe ignores years unrelated to experience', yoe('Founded 12 years ago, we ship software.') === null);
check('yoe rejects implausible values', yoe('99 years of experience required') === null);
check('yoe is null when unstated', yoe('We want a great engineer who ships.') === null);
check(
  'yoe survives a long gap before "experience"',
  yoe('At least five years of professional backend software engineering experience in production environments') === 5
);
check(
  'yoe ignores a number attached to a specific tool, far from "experience"',
  yoe('Hands-on experience building and maintaining Salesforce managed packages, with a minimum of 2+ years of Second Generation Packaging') === null
);

check('hybrid wins over an incidental remote mention', mode('This is a hybrid role; remote teams collaborate daily.') === 'hybrid');
check('explicit remote phrasing is caught', mode('This is a fully remote position.') === 'remote');
check('work from home counts as remote', mode('You may work from home permanently.') === 'remote');
check('a remote location counts', mode('Great team.', 'Bengaluru (Remote)') === 'remote');
check('onsite phrasing is caught', mode('You will be on-site five days a week.') === 'onsite');
check('a bare mention of remote is not enough', mode('Our remote-friendly competitors differ; we value our teams.') === '');
check('unknown mode stays empty', mode('A normal job description with no mode stated.') === '');

// 16. Local company strength
const { companyStrength } = await import('./services/strength.mjs');
const mk = (title, company, score) => {
  const res = importJobs([{ title, jobLink: `https://str.test/${title.replace(/\W/g, '')}`, company }], 'fixture');
  const sid = res.ids[0];
  if (score != null) {
    db.prepare(
      `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
       VALUES (?, ?, 'YES', '[]', '[]', '', '', 'test', ?)`
    ).run(sid, score, new Date().toISOString());
  }
  return sid;
};
mk('Strong A', 'StrongCo', 4.6);
mk('Strong B', 'StrongCo', 4.2);
mk('Weak A', 'WeakCo', 1.5);
mk('Unknown A', 'UnknownCo', null);
db.prepare(`INSERT INTO companies (name, careers_url, ats, created_at, updated_at) VALUES ('StrongCo', 'https://strongco.test', 'unknown', ?, ?)`).run(
  new Date().toISOString(),
  new Date().toISOString()
);

const strength = companyStrength();
check('strength keys are case-insensitive', strength.get('strongco') !== undefined);
check('a well-scoring company beats a poorly-scoring one', strength.get('strongco').strength > strength.get('weakco').strength);
check('an unscored company sits between the two', strength.get('unknownco').strength > strength.get('weakco').strength && strength.get('unknownco').strength < strength.get('strongco').strength);
check('average score is reported', Math.abs(strength.get('strongco').avgScore - 4.4) < 0.001);
check('posting counts are reported', strength.get('strongco').postings === 2);
check('being tracked is reported', strength.get('strongco').tracked === true && strength.get('weakco').tracked === false);
check('an unscored company reports no average', strength.get('unknownco').avgScore === null);
check('a tracked company carries its id and careers url', strength.get('strongco').companyId > 0 && strength.get('strongco').careersUrl === 'https://strongco.test');
check('an untracked company carries neither', strength.get('weakco').companyId === null && strength.get('weakco').careersUrl === '');
check('strength stays within 0..1', [...strength.values()].every((v) => v.strength >= 0 && v.strength <= 1));

const withStrength = listJobs({ q: 'Strong A' })[0];
check('the list attaches strength to each row', withStrength.company_strength > 0 && withStrength.company_avg_score === 4.4);
check('the list attaches the posting count', withStrength.company_postings === 2);

// 17. Sorting by company strength, and explicit multi-key specs
const strengthRows = [
  { id: 1, company_strength: 0.2, score: null, created_at: iso(1 * MINUTE) },
  { id: 2, company_strength: 0.9, score: null, created_at: iso(3 * DAY) },
  { id: 3, company_strength: 0.5, score: null, created_at: iso(2 * MINUTE) },
];
check('strength sorts high to low', sortJobs(strengthRows, ['strength']).map((j) => j.id).join() === '2,3,1');
check('an explicit multi-key spec is honoured in order', sortJobs(strengthRows, ['age', 'strength']).map((j) => j.id).join() === '1,3,2');
check('an unknown key is ignored, not fatal', sortJobs(strengthRows, ['bogus', 'strength']).map((j) => j.id).join() === '2,3,1');
check('an all-unknown spec still returns every row', sortJobs(strengthRows, ['bogus']).length === 3);

// 18. Facets are stored on import and refreshed when a description changes
const facetJob = {
  title: 'Facet Probe',
  jobLink: 'https://facet.test/1',
  company: 'FacetCo',
  location: 'Bengaluru, India',
  jobDescription: 'This is a hybrid role. We need 4+ years of experience in backend work.',
};
const facetId = importJobs([facetJob], 'fixture').ids[0];
const facetRow = () => db.prepare('SELECT work_mode, yoe_min FROM jobs WHERE id = ?').get(facetId);
check('import stores the work mode', facetRow().work_mode === 'hybrid');
check('import stores the years asked for', facetRow().yoe_min === 4);

importJobs([{ ...facetJob, jobDescription: 'This is a fully remote position needing 2-4 years of experience.' }], 'fixture');
check('a changed description re-reads the work mode', facetRow().work_mode === 'remote');
check('a changed description re-reads the years', facetRow().yoe_min === 2);
check('the list exposes both facets', listJobs({ q: 'Facet Probe' })[0].work_mode === 'remote');

// 19. Primary / secondary role tiers, matched on the job title
const { classifyTier, tierQuery, roleMatches } = await import('./services/tiers.mjs');
const ROLES = {
  primary: ['Backend Engineer', 'Full Stack Developer', 'Python Developer', 'Java Developer'],
  secondary: ['DevOps Engineer', 'Cloud Architect'],
};
const tier = (title) => classifyTier(title, ROLES);

check('an exact role title is primary', tier('Backend Engineer') === 'primary');
check('seniority prefixes do not break the match', tier('Senior Backend Engineer') === 'primary');
check('engineer and developer are interchangeable', tier('Full Stack Engineer') === 'primary');
check('a hyphenated spelling still matches', tier('Back-End Developer') === 'primary');
check('a language role matches', tier('Python Developer (Django)') === 'primary');
check('a secondary role is tagged secondary', tier('Senior DevOps Engineer') === 'secondary');
check('cloud architect is secondary', tier('Cloud Architect - AWS') === 'secondary');
check('primary wins when a title matches both', tier('Backend Engineer / DevOps') === 'primary');
check('an unrelated title has no tier', tier('Marketing Manager') === '');
check('a bare generic title has no tier', tier('Engineer') === '');
check('matching is case-insensitive', tier('SENIOR JAVA DEVELOPER') === 'primary');
check('an empty role list tiers nothing', classifyTier('Backend Engineer', { primary: [], secondary: [] }) === '');

check('a role reduces to its distinguishing words', roleMatches('Backend Engineer', 'Staff Backend Programmer') === true);
check('a role does not match an unrelated specialty', roleMatches('Backend Engineer', 'Frontend Engineer') === false);
// Drawn from real titles in the database that the first, looser version mis-tagged.
check('a non-engineering title is not a Cloud Architect', roleMatches('Cloud Architect', 'Sr Strategic Partnership Manager Buyer Cloud Dsp') === false);
check('a product role is not a Cloud Architect', roleMatches('Cloud Architect', 'Product Manager Buyer Cloud') === false);
check('a real cloud engineering title still matches', roleMatches('Cloud Architect', 'Oracle Fusion Cloud Engineer') === true);
check('a non-engineering noun must match itself', roleMatches('Data Scientist', 'Data Engineer') === false);
check('that same noun matches when present', roleMatches('Data Scientist', 'Senior Data Scientist') === true);

check('a tier becomes one OR-joined query', tierQuery(ROLES.secondary) === 'DevOps Engineer OR Cloud Architect');
check('an empty tier yields an empty query', tierQuery([]) === '');

// The list attaches the tier and can filter on it.
importJobs([{ title: 'Senior Backend Engineer', jobLink: 'https://tier.test/1', company: 'TierCo' }], 'fixture');
importJobs([{ title: 'Cloud Architect', jobLink: 'https://tier.test/2', company: 'TierCo' }], 'fixture');
importJobs([{ title: 'Office Manager', jobLink: 'https://tier.test/3', company: 'TierCo' }], 'fixture');
const tierRows = (f) => listJobs({ q: 'TierCo', ...f }).map((j) => j.tier).sort();
check('the list attaches a tier to every row', tierRows({}).join() === ',primary,secondary');
check('the list filters to primary', listJobs({ q: 'TierCo', tier: 'primary' }).length === 1);
check('the list filters to secondary', listJobs({ q: 'TierCo', tier: 'secondary' }).length === 1);
check('the list can isolate untiered rows', listJobs({ q: 'TierCo', tier: 'none' })[0].title === 'Office Manager');
check('an unknown tier filter is ignored', listJobs({ q: 'TierCo', tier: 'bogus' }).length === 3);

check('tier sorts primary before secondary before untiered', sortJobs(
  [{ id: 1, tier: '' }, { id: 2, tier: 'secondary' }, { id: 3, tier: 'primary' }],
  ['tier']
).map((j) => j.id).join() === '3,2,1');

// 20. Filtering by the years a posting asks for.
// The cap is off here so these fixtures survive import — auto-reject is
// exercised separately in section 22.
const { saveProfile } = await import('./services/profile.mjs');
saveProfile({ maxYoeAsk: 0 });
const yoeJob = (title, desc) =>
  importJobs([{ title, jobLink: `https://yoe.test/${title.replace(/\W/g, '')}`, company: 'YoeCo', jobDescription: desc }], 'fixture').ids[0];
yoeJob('Yoe Two', 'We need 2 years of experience here.');
yoeJob('Yoe Six', 'We need 6+ years of experience here.');
yoeJob('Yoe Twelve', 'We need 12+ years of experience here.');
yoeJob('Yoe Silent', 'A description that never mentions how long you have worked.');

const yoeTitles = (max) => listJobs({ q: 'YoeCo', maxYoe: max }).map((j) => j.title.replace('Yoe ', '')).sort().join();
check('maxYoe keeps postings at or under the cap', yoeTitles(6).includes('Six') && yoeTitles(6).includes('Two'));
check('maxYoe drops postings above the cap', !yoeTitles(6).includes('Twelve'));
check('maxYoe keeps postings that never state a requirement', yoeTitles(6).includes('Silent'));
check('a tight cap drops the mid-range too', yoeTitles(3) === 'Silent,Two');
check('no cap returns everything', listJobs({ q: 'YoeCo' }).length === 4);

// 21. The analyzer is told the candidate's experience and the posting's ask
const { getProfile } = await import('./services/profile.mjs');
check('the profile carries years of experience', typeof getProfile().yearsExperience === 'number');

// 22. Auto-reject at import moves a posting to the ignored list
saveProfile({ yearsExperience: 4, maxYoeAsk: 5 });

const arJob = (name, desc) =>
  importJobs([{ title: `AR ${name}`, jobLink: `https://ar.test/${name}`, company: 'ARCo', jobDescription: desc }], 'fixture').ids[0];
const rowOf = (arId) => db.prepare('SELECT status, ignored FROM jobs WHERE id = ?').get(arId);

const arOver = arJob('over', 'This role needs 12+ years of experience in backend systems.');
const arEdge = arJob('edge', 'This role needs 6+ years of experience in backend systems.');
const arAt = arJob('at', 'This role needs 5+ years of experience in backend systems.');
const arUnder = arJob('under', 'This role needs 3+ years of experience in backend systems.');
const arSilent = arJob('silent', 'A description that never states how many years are required at all.');

check('a posting well over the cap is ignored', rowOf(arOver).ignored === 1);
check('a posting one year over the cap is ignored', rowOf(arEdge).ignored === 1);
check('a posting exactly at the cap is kept', rowOf(arAt).ignored === 0);
check('a posting under the cap is kept', rowOf(arUnder).ignored === 0);
check('a posting with no stated requirement is kept', rowOf(arSilent).ignored === 0);
check('an ignored posting keeps a clean status so restoring it is simple', rowOf(arOver).status === 'new');
check(
  'the reason is recorded as an event',
  db.prepare("SELECT payload FROM events WHERE job_id = ? AND type = 'auto_rejected'").get(arOver)?.payload.includes('12')
);

// The main list must not show them; the ignored view must show only them.
const arTitles = (f) => listJobs({ q: 'ARCo', ...f }).map((j) => j.title.replace('AR ', '')).sort().join();
check('the default list hides ignored postings', arTitles({}) === 'at,silent,under');
check('the ignored view shows only ignored postings', arTitles({ ignored: '1' }) === 'edge,over');
check('the all view shows both', arTitles({ ignored: 'all' }) === 'at,edge,over,silent,under');

// Restoring, and staying restored across a re-fetch.
const { bulkRestore } = await import('./services/bulk.mjs');
bulkRestore([arOver]);
check('restoring clears the ignored flag', rowOf(arOver).ignored === 0);
importJobs([{ title: 'AR over', jobLink: 'https://ar.test/over', company: 'ARCo', jobDescription: 'This role needs 12+ years of experience, updated wording.' }], 'fixture');
check('a restored job is not re-ignored on re-import', rowOf(arOver).ignored === 0);

// Turning the cap off keeps everything.
saveProfile({ maxYoeAsk: 0 });
const arOff = arJob('off', 'This role needs 15+ years of experience.');
check('a zero cap disables auto-reject', rowOf(arOff).ignored === 0);
saveProfile({ maxYoeAsk: 5 });

// 23. One list query serves the company view too
saveProfile({ maxYoeAsk: 0 }); // keep these fixtures out of the ignored list
const coName = 'UnifyCo';
importJobs([{ title: 'Unify Scanned', jobLink: 'https://unify.test/1', company: coName }], `company:${coName}`, { matched: 1 });
importJobs([{ title: 'Unify Stored', jobLink: 'https://unify.test/2', company: coName }], `company:${coName}`, { matched: 0 });
importJobs([{ title: 'Unify FromLinkedIn', jobLink: 'https://unify.test/3', company: coName }], 'linkedin');

const coTitles = (f) => listJobs({ company: coName, ...f }).map((j) => j.title.replace('Unify ', '')).sort().join();
check('the company scope finds scanned jobs', coTitles({}).includes('Scanned'));
check('the company scope also finds jobs from other sources', coTitles({}).includes('FromLinkedIn'));
check('the company scope respects the matched filter', !coTitles({}).includes('Stored'));
check('the company scope can show stored-only rows', listJobs({ company: coName, matched: '0' })[0].title === 'Unify Stored');
check('the company scope can show everything', coTitles({ matched: 'all' }) === 'FromLinkedIn,Scanned,Stored');
check('the company scope is case-insensitive', listJobs({ company: 'unifyco' }).length === 2);
check('an unknown company scopes to nothing', listJobs({ company: 'NoSuchCompanyAnywhere' }).length === 0);

// The company view needs the analysis detail it used to get from companyJobs.
const unifyId = listJobs({ company: coName })[0].id;
db.prepare(
  `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
   VALUES (?, 4.1, 'YES', '["a pro"]', '["a con"]', 'because', '', 'test', ?)`
).run(unifyId, new Date().toISOString());
const detailed = listJobs({ company: coName }).find((j) => j.id === unifyId);
check('the list carries pros as an array', Array.isArray(detailed.pros) && detailed.pros[0] === 'a pro');
check('the list carries cons as an array', Array.isArray(detailed.cons) && detailed.cons[0] === 'a con');
check('the list carries the reasoning', detailed.reasoning === 'because');

// Everything else the jobs list can do works when scoped to a company.
check('company scope composes with the tier filter', listJobs({ company: coName, tier: 'none' }).length >= 1);
check('company scope composes with minScore', listJobs({ company: coName, minScore: '4' }).length === 1);
check('company scope composes with the ignored view', listJobs({ company: coName, ignored: '1' }).length === 0);
saveProfile({ maxYoeAsk: 5 });

// 24. Advancing an unscored job is refused — the guard that keeps "reviewed"
// meaning "actually reviewed".
const gJob = (name, score) => {
  const gid = importJobs([{ title: `Guard ${name}`, jobLink: `https://guard.test/${name}`, company: 'GuardCo' }], 'fixture').ids[0];
  if (score != null) {
    db.prepare(
      `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
       VALUES (?, ?, 'YES', '[]', '[]', '', '', 'test', ?)`
    ).run(gid, score, new Date().toISOString());
  }
  return gid;
};
const gStatus = (gid) => db.prepare('SELECT status FROM jobs WHERE id = ?').get(gid).status;

const gUnscored = gJob('unscored', null);
const gScored = gJob('scored', 4.2);

const gRes = bulkAdvance([gUnscored, gScored]);
check('an unscored job is not advanced', gStatus(gUnscored) === 'new');
check('a scored job still advances', gStatus(gScored) === 'reviewed');
check('the refusal explains itself', /not scored/i.test(gRes.find((r) => r.id === gUnscored).reason));

// The guard applies wherever the job sits, not just at "new".
const gStranded = gJob('stranded', null);
setStatus(gStranded, 'reviewed');
bulkAdvance([gStranded]);
check('an unscored job already past new cannot advance further', gStatus(gStranded) === 'reviewed');

// An explicit override still works, for when you know better.
bulkAdvance([gUnscored], { force: true });
check('force overrides the guard', gStatus(gUnscored) === 'reviewed');

// Setting a status outright is unaffected — that is how you undo a bad advance.
bulkStatus([gUnscored], 'new');
check('setting a status directly is not guarded', gStatus(gUnscored) === 'new');

// 25. The company picker's option list
const { companyNames } = await import('./services/joblist.mjs');
importJobs([{ title: 'Picker A', jobLink: 'https://pick.test/1', company: 'Zeta Systems' }], 'fixture');
importJobs([{ title: 'Picker B', jobLink: 'https://pick.test/2', company: 'Zeta Systems' }], 'fixture');
importJobs([{ title: 'Picker C', jobLink: 'https://pick.test/3', company: 'Alpha Labs' }], 'fixture');

const names = companyNames();
const zeta = names.find((n) => n.name === 'Zeta Systems');
const alpha = names.find((n) => n.name === 'Alpha Labs');
check('every company with jobs is listed', Boolean(zeta) && Boolean(alpha));
check('each carries its job count', zeta.count === 2 && alpha.count === 1);
check('busier companies come first', names.findIndex((n) => n.name === 'Zeta Systems') < names.findIndex((n) => n.name === 'Alpha Labs'));
check('the list is deduplicated', names.filter((n) => n.name === 'Zeta Systems').length === 1);

const ignoredCo = importJobs(
  [{ title: 'Picker D', jobLink: 'https://pick.test/4', company: 'Hidden Corp', jobDescription: 'Needs 20+ years of experience.' }],
  'fixture'
).ids[0];
check('the auto-ignored fixture really was ignored', db.prepare('SELECT ignored FROM jobs WHERE id = ?').get(ignoredCo).ignored === 1);
check('a company with only ignored jobs is left out', !companyNames().some((n) => n.name === 'Hidden Corp'));
check('it appears once ignored rows are included', companyNames({ ignored: 'all' }).some((n) => n.name === 'Hidden Corp'));

// 26. Server-side paging
const { listJobsPage } = await import('./services/joblist.mjs');
for (let i = 0; i < 7; i++) {
  importJobs([{ title: `Page ${String(i).padStart(2, '0')}`, jobLink: `https://page.test/${i}`, company: 'PageCo' }], 'fixture');
}
const pageOf = (opts) => listJobsPage({ company: 'PageCo', sort: 'company', ...opts });

check('a page reports the full total, not the page size', pageOf({ limit: 3 }).total === 7);
check('a page returns only its own rows', pageOf({ limit: 3 }).rows.length === 3);
check('the offset moves the window', pageOf({ limit: 3, offset: 3 }).rows.length === 3);
check('the last page is short, not padded', pageOf({ limit: 3, offset: 6 }).rows.length === 1);
check('an offset past the end returns nothing', pageOf({ limit: 3, offset: 99 }).rows.length === 0);
check('pages do not overlap', (() => {
  const a = pageOf({ limit: 3, offset: 0 }).rows.map((j) => j.id);
  const b = pageOf({ limit: 3, offset: 3 }).rows.map((j) => j.id);
  return a.every((id) => !b.includes(id));
})());
check('every row is reachable across pages', (() => {
  const seen = new Set();
  for (let off = 0; off < 9; off += 3) for (const j of pageOf({ limit: 3, offset: off }).rows) seen.add(j.id);
  return seen.size === 7;
})());
check('no limit returns everything', pageOf({}).rows.length === 7);
check('the page echoes its own window', pageOf({ limit: 3, offset: 3 }).offset === 3);

// Paging must run AFTER the filters that are applied in JS, or totals lie.
db.prepare(
  `INSERT INTO analyses (job_id, score, verdict, pros, cons, reasoning, location_check, model, created_at)
   VALUES ((SELECT id FROM jobs WHERE url = 'https://page.test/0'), 4.5, 'YES', '[]', '[]', '', '', 'test', ?)`
).run(new Date().toISOString());
check('a total respects a post-query filter', pageOf({ minScore: '4' }).total === 1);
check('a page respects a post-query filter', pageOf({ minScore: '4', limit: 10 }).rows.length === 1);

check('listJobs still returns a plain array', Array.isArray(listJobs({ company: 'PageCo' })));

// 27. Naukri parsing against the epicscrapers actor's real field names
const { naukriSource } = await import('./services/sources.mjs');
// Dated relative to now: the parser drops anything older than its recency
// cutoff, so a hardcoded date would rot the test as time passed.
const naukriPostedAt = new Date(Date.now() - 2 * 86400000).toISOString();
const naukriItem = {
  jobId: 'n1',
  title: 'Backend Engineer',
  companyName: 'Naukri Test Co',
  jobDescription: 'A description long enough to clear the fifty character minimum that the parser enforces.',
  locationLabel: 'Bengaluru, Chennai',
  experienceLabel: '3-6 Yrs',
  minimumExperience: 3,
  postedAt: naukriPostedAt,
  jdURL: 'https://www.naukri.com/job-listings-backend-engineer-1',
};
const [parsedNaukri] = naukriSource.parseItems([naukriItem]);
check('the naukri parser reads the job url', parsedNaukri.jobLink === naukriItem.jdURL);
// A site-relative jdURL must be absolutized, or "Open posting" resolves against
// the dashboard's own origin and lands on localhost.
const [relNaukri] = naukriSource.parseItems([
  { ...naukriItem, jdURL: '/job-listings-backend-engineer-acme-bengaluru-1-to-5-years-240926501649' },
]);
check('a relative naukri url is absolutized', relNaukri.jobLink === 'https://www.naukri.com/job-listings-backend-engineer-acme-bengaluru-1-to-5-years-240926501649');
check('an absolute naukri url is left alone', parsedNaukri.jobLink.startsWith('https://www.naukri.com/'));
check('the naukri parser reads locationLabel', parsedNaukri.location === 'Bengaluru, Chennai');
check('the naukri parser reads the experience label', parsedNaukri.seniorityLevel === '3-6 Yrs');
check('the naukri parser passes the stated minimum years through', parsedNaukri.yoeMin === 3);
check('the naukri parser keeps the posting timestamp', parsedNaukri.postedAt === naukriPostedAt);
check('a description-less item is dropped', naukriSource.parseItems([{ ...naukriItem, jobDescription: '' }]).length === 0);

// A source-supplied minimum beats guessing at it from the prose.
const yoeFromSource = importJobs(
  [{ ...parsedNaukri, jobLink: 'https://naukri.test/explicit', jobDescription: 'Text that mentions 15 years of experience misleadingly.', yoeMin: 3 }],
  'naukri'
).ids[0];
check('an explicit minimum wins over the description', db.prepare('SELECT yoe_min FROM jobs WHERE id = ?').get(yoeFromSource).yoe_min === 3);

const cfg = naukriSource.buildInput({
  query: 'Backend Engineer',
  locations: ['Chennai'],
  includeRemote: false,
  count: 25,
  search: { primary: ['Backend Engineer'], secondary: [], includeSecondary: false },
});
check('the naukri input asks for full descriptions', cfg.fetchAdditionalDetails === true);
check('the naukri input carries a per-query cap', cfg.maxResultsPerQuery === 25);
check('the naukri input still sends the generic keys other actors expect', Boolean(cfg.startUrls && cfg.keyword));

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
