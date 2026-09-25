// Shared list-filter helpers. Kept as plain functions so the SQL they produce
// can be unit-tested without going through HTTP.

const DAY_SECONDS = 86400;

/**
 * Age window for the job list. `added` filters on created_at, which is always
 * exact. `posted` filters on posted_at, which is only as precise as the source
 * was: sub-day windows compare full timestamps (a date-only row cannot prove it
 * is 20 minutes old, so it drops out), while windows of a day or more compare
 * whole days so date-only rows still match. Returns null when there is no
 * window to apply.
 */
export function ageFilter(within, withinBy = 'added', now = Date.now()) {
  const seconds = Number(within);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const cutoff = new Date(now - seconds * 1000).toISOString();
  if (withinBy === 'posted') {
    return {
      sql: "(j.posted_at != '' AND j.posted_at >= ?)",
      param: seconds < DAY_SECONDS ? cutoff : cutoff.slice(0, 10),
    };
  }
  return { sql: 'j.created_at >= ?', param: cutoff };
}
