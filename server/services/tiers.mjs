// Roles you search for, split into a primary tier (what you actually want) and
// a secondary tier (adjacent roles worth seeing, but ranked below).
//
// A job's tier is derived from its title rather than from which search returned
// it: Apify merges every search URL into one dataset with no attribution, and
// title matching has the side benefit of tiering manually-added and
// company-scan jobs too. It is computed on read, so editing your role lists
// re-tiers everything immediately with no migration.

// Title words carry three different jobs, and conflating them makes matching
// far too loose — reducing "Cloud Architect" to just "cloud" would tag a
// "Product Manager, Buyer Cloud" posting as a match.
//
//  - SENIORITY says nothing about the role at all.
//  - ENGINEERING nouns are interchangeable: Backend Engineer ≡ Backend Developer.
//  - Any other noun (analyst, manager, scientist) must match itself exactly.
const SENIORITY = new Set([
  'senior', 'sr', 'jr', 'junior', 'staff', 'principal', 'lead', 'associate',
  'entry', 'mid', 'i', 'ii', 'iii', 'iv',
]);
const ENGINEERING = new Set([
  'engineer', 'engineering', 'developer', 'development', 'dev', 'programmer', 'architect', 'sre',
]);
const OTHER_NOUNS = new Set([
  'analyst', 'manager', 'scientist', 'consultant', 'specialist', 'administrator', 'designer',
]);

// "Back-End" / "back end" / "backend" all have to compare equal.
const normalize = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bback end\b/g, 'backend')
    .replace(/\bfront end\b/g, 'frontend')
    .replace(/\bfull stack\b/g, 'fullstack')
    .trim();

/** Split a role into the words that distinguish it and the nouns it demands. */
function parseRole(role) {
  const words = normalize(role).split(' ').filter(Boolean).filter((w) => !SENIORITY.has(w));
  return {
    specialty: words.filter((w) => !ENGINEERING.has(w) && !OTHER_NOUNS.has(w)),
    wantsEngineering: words.some((w) => ENGINEERING.has(w)),
    otherNouns: words.filter((w) => OTHER_NOUNS.has(w)),
    words,
  };
}

/** The words of a role that actually distinguish it, e.g. "backend" from "Backend Engineer". */
export function distinguishingWords(role) {
  const { specialty, words } = parseRole(role);
  return specialty.length ? specialty : words;
}

/**
 * Does `title` describe `role`? Every distinguishing word must be present, and
 * the kind of role has to agree too — an engineering role needs an engineering
 * noun in the title, and any other noun must appear verbatim.
 */
export function roleMatches(role, title) {
  const { specialty, wantsEngineering, otherNouns, words } = parseRole(role);
  if (!words.length) return false;
  const titleWords = new Set(normalize(title).split(' ').filter(Boolean));

  const needed = specialty.length ? specialty : words;
  if (!needed.every((w) => titleWords.has(w))) return false;
  if (wantsEngineering && ![...titleWords].some((w) => ENGINEERING.has(w))) return false;
  if (!otherNouns.every((w) => titleWords.has(w))) return false;
  return true;
}

/**
 * 'primary' | 'secondary' | ''. Primary wins when a title matches both tiers —
 * a "Backend Engineer / DevOps" posting is a backend job first.
 */
export function classifyTier(title, { primary = [], secondary = [] } = {}) {
  if (primary.some((role) => roleMatches(role, title))) return 'primary';
  if (secondary.some((role) => roleMatches(role, title))) return 'secondary';
  return '';
}

/** One tier becomes a single OR-joined search, keeping the URL count flat. */
export function tierQuery(roles) {
  return (Array.isArray(roles) ? roles : []).map((r) => String(r).trim()).filter(Boolean).join(' OR ');
}
