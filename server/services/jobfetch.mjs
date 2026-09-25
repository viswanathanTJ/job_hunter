// Manual job add: fetch ONE job posting from a pasted URL and normalize it
// for the importer. ATS detail APIs where available, generic HTML fallback
// otherwise (SSR pages).
import { db } from '../db.mjs';
import { normalizePosted } from './posted.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"', '#43': '+' };
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|div|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
    .slice(0, 25000);
}

/** Prefer an existing tracked company's name when the job URL matches its site. */
function knownCompanyFor(host) {
  const row = db
    .prepare("SELECT name FROM companies WHERE careers_url LIKE '%' || ? || '%' LIMIT 1")
    .get(host.replace(/^www\./, ''));
  return row?.name || null;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

async function fromWorkday(u) {
  const host = u.hostname;
  const [tenant] = host.split('.');
  const segs = u.pathname.split('/').filter(Boolean);
  const localeAt = /^[a-z]{2}-[A-Z]{2}$/.test(segs[0]) ? 1 : 0;
  const site = segs[localeAt];
  const rest = segs.slice(localeAt + 1); // job/{loc-slug}/{title-slug}_{req}
  if (!site || rest[0] !== 'job') throw new Error('Not a recognizable Workday job URL (expected …/{site}/job/…)');
  const base = `https://${host}`;
  // Cookie handshake — some tenants reject bare CXS calls.
  const page0 = await fetch(`${base}/en-US/${site}`, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  const cookie = (page0.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const res = await fetch(`${base}/wday/cxs/${tenant}/${site}/${rest.join('/')}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Cookie: cookie },
  });
  if (res.status === 404 || res.status === 403) {
    throw new Error(`Workday says this posting is closed or no longer public (HTTP ${res.status}) — likely expired`);
  }
  if (!res.ok) throw new Error(`Workday detail API returned HTTP ${res.status}`);
  const d = await res.json();
  const info = d.jobPostingInfo || {};
  if (!info.title) throw new Error('Workday returned no posting data — the job may have closed');
  return {
    title: info.title,
    company: knownCompanyFor(u.hostname) || d.hiringOrganization?.name || cap(tenant),
    location: info.location || '',
    postedAt: normalizePosted(info.startDate || info.postedOn),
    employmentType: info.timeType || '',
    description: htmlToText(info.jobDescription),
  };
}

async function fromGreenhouse(u) {
  const segs = u.pathname.split('/').filter(Boolean); // {slug}/jobs/{id}
  const slug = segs[0];
  const id = segs[segs.indexOf('jobs') + 1];
  if (!slug || !id) throw new Error('Not a recognizable Greenhouse job URL (expected /{board}/jobs/{id})');
  const api = u.hostname.includes('.eu.') ? 'https://boards-api.eu.greenhouse.io' : 'https://boards-api.greenhouse.io';
  const res = await fetch(`${api}/v1/boards/${slug}/jobs/${id}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 404) throw new Error('Greenhouse says this posting no longer exists (404) — likely expired');
  if (!res.ok) throw new Error(`Greenhouse API returned HTTP ${res.status}`);
  const d = await res.json();
  return {
    title: d.title,
    company: knownCompanyFor(u.hostname) || d.company_name || cap(slug),
    location: d.location?.name || '',
    postedAt: normalizePosted(d.updated_at),
    description: htmlToText(d.content),
  };
}

async function fromLever(u) {
  const [slug, id] = u.pathname.split('/').filter(Boolean);
  if (!slug || !id) throw new Error('Not a recognizable Lever job URL (expected /{company}/{posting-id})');
  const res = await fetch(`https://api.lever.co/v0/postings/${slug}/${id}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 404) throw new Error('Lever says this posting no longer exists (404) — likely expired');
  if (!res.ok) throw new Error(`Lever API returned HTTP ${res.status}`);
  const d = await res.json();
  return {
    title: d.text,
    company: knownCompanyFor(u.hostname) || cap(slug),
    location: d.categories?.location || '',
    postedAt: normalizePosted(d.createdAt),
    employmentType: d.categories?.commitment || '',
    description: d.descriptionPlain || htmlToText(d.description),
  };
}

async function fromAshby(u) {
  const [slug, id] = u.pathname.split('/').filter(Boolean);
  if (!slug || !id) throw new Error('Not a recognizable Ashby job URL (expected /{org}/{posting-id})');
  const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiJobPosting',
      variables: { organizationHostedJobsPageName: slug, jobPostingId: id },
      query: `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
        jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
          title locationName employmentType descriptionHtml
        }
      }`,
    }),
  });
  if (!res.ok) throw new Error(`Ashby API returned HTTP ${res.status}`);
  const d = (await res.json()).data?.jobPosting;
  if (!d) throw new Error('Ashby returned no posting — the job may have closed');
  return {
    title: d.title,
    company: knownCompanyFor(u.hostname) || cap(slug),
    location: d.locationName || '',
    employmentType: d.employmentType || '',
    description: htmlToText(d.descriptionHtml),
  };
}

async function fromGenericPage(u) {
  const res = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`The page returned HTTP ${res.status}`);
  const html = await res.text();
  const meta = (name) =>
    (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, 'i')) || [])[1];
  const title = meta('og:title') || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
  const body = htmlToText(html);
  if (!title || body.length < 300) {
    throw new Error('Could not extract a job posting from this page (client-rendered site?) — paste the JD text into the importer instead');
  }
  const hostWord = u.hostname.replace(/^(www|jobs|careers)\./, '').split('.')[0];
  // Trim site-name suffixes without splitting on hyphens inside real titles:
  // "Engineer 2 - Software Development and jobs at Comcast" → keep the full title.
  const cleanTitle = title
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .split(/\s+[|·]\s+/)[0]
    .replace(/\s+(?:and jobs|jobs|careers?)\s+at\s+.*$/i, '')
    .replace(/\s+at\s+[A-Z][\w&. ]{1,40}$/, '')
    .trim();
  return {
    title: cleanTitle.slice(0, 150),
    company: knownCompanyFor(u.hostname) || cap(hostWord),
    location: '',
    description: body,
  };
}

/** Fetch + normalize a single job posting from any supported job URL. */
export async function fetchJobFromUrl(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.toLowerCase();
  if (host.endsWith('.myworkdayjobs.com')) return fromWorkday(u);
  if (host.includes('greenhouse.io')) return fromGreenhouse(u);
  if (host === 'jobs.lever.co') return fromLever(u);
  if (host === 'jobs.ashbyhq.com') return fromAshby(u);
  return fromGenericPage(u);
}
