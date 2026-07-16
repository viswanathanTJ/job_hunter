// Canonical dedup key for a job URL. Job boards append tracking/pagination
// params (refId, trackingId, position, pageNum, utm_*) that differ every fetch,
// so the same posting arrives under many raw URLs. We key on the STABLE
// identity of the posting instead: the provider's numeric job id where we can
// recognise it, otherwise the origin + path with tracking params stripped.

const TRACKING_PARAMS = new Set([
  'refid', 'trackingid', 'position', 'pagenum', 'trk', 'origin', 'savedsearchid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'src', 'source', 'from', 'seo', 'referer', 'referrer',
]);

/** LinkedIn: /jobs/view/<slug>-<jobId> or /jobs/view/<jobId>. */
function linkedinId(u) {
  const m = u.pathname.match(/\/jobs\/view\/(?:.*-)?(\d{6,})/);
  return m ? `linkedin:${m[1]}` : null;
}

/** Naukri: …-job-listings-…-<numericId> (the trailing all-digits segment). */
function naukriId(u) {
  const m = u.pathname.match(/(\d{10,})\/?$/);
  return m ? `naukri:${m[1]}` : null;
}

export function urlKey(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return raw.toLowerCase(); // unparseable — fall back to the raw string
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  if (host.endsWith('linkedin.com')) {
    const id = linkedinId(u);
    if (id) return id;
  }
  if (host.endsWith('naukri.com')) {
    const id = naukriId(u);
    if (id) return id;
  }

  // Generic: origin + path, tracking params dropped, trailing slash normalised.
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}${qs}`.toLowerCase();
}
