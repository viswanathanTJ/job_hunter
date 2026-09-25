// Job ordering shared by the list and the pipeline, so both views agree on what
// "priority" means. Kept free of React imports so the smoke test can run it.

/** Score bands, best-actionable first. Unscored ranks above weak scores on
 *  purpose: it is the pile that still needs a decision, not a rejected one. */
export function scoreBand(score) {
  if (score == null) return 1;
  if (score >= 4) return 0;
  if (score >= 3) return 2;
  return 3;
}

const newest = (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0);

const TIER_RANK = { primary: 0, secondary: 1 };
const tierRank = (t) => TIER_RANK[t] ?? 2;

const KEYS = {
  tier: (a, b) => tierRank(a.tier) - tierRank(b.tier),
  band: (a, b) => scoreBand(a.score) - scoreBand(b.score),
  strength: (a, b) => (b.company_strength ?? 0) - (a.company_strength ?? 0),
  age: newest,
  score: (a, b) => (a.score == null) - (b.score == null) || (b.score ?? 0) - (a.score ?? 0),
  company: (a, b) => String(a.company || '').localeCompare(String(b.company || ''), undefined, { sensitivity: 'base' }),
  posted: (a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')),
  updated: (a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0),
};

export const SORT_PRESETS = {
  priority: ['tier', 'band', 'strength', 'age'],
  created: ['age'],
  score: ['score', 'age'],
  company: ['company', 'age'],
  posted: ['posted', 'age'],
  updated: ['updated'],
  strength: ['strength', 'age'],
  tier: ['tier', 'age'],
};

export const SORT_LABELS = {
  priority: 'Priority (good fits & fresh)',
  strength: 'By company strength',
  tier: 'Primary roles first',
  created: 'Newest first',
  score: 'By score',
  company: 'By company',
  posted: 'By posted date',
  updated: 'Recently updated',
};

export const KEY_LABELS = {
  tier: 'Primary roles first',
  band: 'Score band',
  strength: 'Company strength',
  age: 'Newest added',
  score: 'Exact score',
  company: 'Company name',
  posted: 'Posted date',
  updated: 'Last updated',
};

export const SORT_KEYS = Object.keys(KEY_LABELS);

/**
 * Sort a copy of `jobs`. `spec` is a preset name or an explicit ordered list of
 * keys from KEYS — the first key that separates two jobs wins, id breaks ties.
 */
export function sortJobs(jobs, spec = 'priority') {
  const keys = (Array.isArray(spec) ? spec : SORT_PRESETS[spec] || SORT_PRESETS.priority).filter((k) => KEYS[k]);
  return [...(jobs || [])].sort((a, b) => {
    for (const key of keys) {
      const d = KEYS[key](a, b);
      if (d) return d;
    }
    return (b.id || 0) - (a.id || 0);
  });
}
