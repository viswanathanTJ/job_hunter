// Posting dates arrive in wildly different shapes: full ISO timestamps
// (Greenhouse, Lever), plain dates (sitemaps), epochs, and human labels
// ("Posted Today", "3 Days Ago"). Normalize once, on the way in, so the UI can
// show minute-level recency wherever the source actually knew it.

const DAY = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Returns a full ISO timestamp when the source gave real time-of-day, a plain
 * YYYY-MM-DD when it only knew the day, or the raw label when it is neither.
 * Both forms sort and compare correctly against a YYYY-MM-DD cutoff.
 */
export function normalizePosted(v) {
  if (v == null) return '';
  const s = String(v).trim().replace(/^Posted\s+/i, '');
  if (!s) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString();
  }
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();

  if (/^just\s*now$/i.test(s)) return new Date().toISOString();
  // "Today" means some time today, not this minute — keep it at day precision.
  if (/^today$/i.test(s)) return isoDay(Date.now());
  if (/^yesterday$/i.test(s)) return isoDay(Date.now() - DAY);

  // "3 Days Ago", "30+ days ago", "5 hours ago", "20 minutes ago"
  const m = s.match(/(\d+)\s*\+?\s*(minute|min|hour|hr|day|week|month)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    // Minutes and hours are real precision — keep the time. Coarser units are
    // rounded labels, so record only the day and avoid faking precision.
    if (unit.startsWith('min')) return new Date(Date.now() - n * 60000).toISOString();
    if (unit === 'hour' || unit === 'hr') return new Date(Date.now() - n * 3600000).toISOString();
    const days = unit === 'week' ? n * 7 : unit === 'month' ? n * 30 : n;
    return isoDay(Date.now() - days * DAY);
  }

  return s; // Unknown label — pass through; the UI renders it verbatim.
}
