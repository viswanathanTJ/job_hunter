// Best-effort facts pulled out of a posting's own text: how the role is worked,
// and the minimum years it asks for. Both stay deliberately conservative — a
// blank facet is far better than a confident wrong badge, so anything that
// isn't stated plainly is left unset.

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15,
};

// Only explicit statements count. A passing mention of the word "remote"
// (a remote-friendly aside, a competitor, a distributed team) does not.
const REMOTE = /fully remote|100%\s*remote|remote[-\s]first|work from home|\bwfh\b|remote (?:position|role|opportunity)|is remote|work remotely/i;
const HYBRID = /\bhybrid\b/i;
const ONSITE = /\bon-?site\b|in-office|\d+\s*days?\s*(?:a week\s*)?(?:in|from)\s*(?:the\s*)?office/i;

/** Remote / hybrid / onsite, or '' when the posting never says. */
export function workMode(description, location = '') {
  const text = `${location}\n${description || ''}`;
  // Hybrid outranks remote: a hybrid posting almost always also says "remote".
  if (HYBRID.test(text)) return 'hybrid';
  if (REMOTE.test(text) || /\(remote\)|\bremote\b/i.test(location)) return 'remote';
  if (ONSITE.test(text)) return 'onsite';
  return '';
}

const NUM = String.raw`(\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;
const toNumber = (raw) => (WORD_NUMBERS[String(raw).toLowerCase()] ?? Number(raw));

// The years and the word "experience" have to be near each other, so unrelated
// counts ("founded 12 years ago") don't get read as a requirement.
const YOE_PATTERNS = [
  new RegExp(String.raw`${NUM}\s*(?:\+|plus)?\s*(?:[-–—]|to)?\s*\d{0,2}\s*\+?\s*(?:years?|yrs?)[^.\n]{0,60}?experience`, 'i'),
  new RegExp(String.raw`experience[^.\n]{0,60}?${NUM}\s*(?:\+|plus)?\s*(?:[-–—]|to)?\s*\d{0,2}\s*\+?\s*(?:years?|yrs?)`, 'i'),
];

/** The low end of the years-of-experience ask, or null when unstated. */
export function yearsOfExperience(description) {
  const text = String(description || '');
  for (const re of YOE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const n = toNumber(m[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 25) return n;
  }
  return null;
}

export function extractFacets(description, location = '') {
  return { workMode: workMode(description, location), yoeMin: yearsOfExperience(description) };
}
