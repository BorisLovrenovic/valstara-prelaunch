// E11.7-15: the copy rules as a check over rendered text, shared by the
// partner programme's email audit (test/e11-7-15-partner-audit.test.ts) and
// its rendered-page audit (test/e11-7-15-partner-browser.test.mjs). The
// forbidden-copy gate scans the source copy layer; this scans what a person
// actually reads, the copy layer filled with real data. Only exports.
import { readFileSync } from 'node:fs';

const policy = JSON.parse(
  readFileSync(
    new URL('../../scripts/forbidden-copy.json', import.meta.url),
    'utf8',
  ),
);

/** Every never-use term (docs/brand/copy-rules.md), the brief's included. */
export const forbiddenTerms = Object.freeze(
  policy.entries.map((entry) => entry.term),
);

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Text that only an unfilled template or a broken value produces.
const placeholders = [
  /\bundefined\b/iu,
  /\bNaN\b/u,
  /\[object \w+\]/u,
  /\{(?:link|code|name|count|percent)\}/u,
  /\bnull\b/u,
  /\bTODO\b/u,
  /\bInvalid Date\b/u,
];

// Manufactured urgency and scarcity (copy rules: never build).
const urgency = [
  /\bhurry\b/iu,
  /\blast chance\b/iu,
  /\bact now\b/iu,
  /\blimited time\b/iu,
  /\bspots? left\b/iu,
  /\bonly \d+ (?:left|remaining)\b/iu,
  /\bends in\b/iu,
  /\bcountdown\b/iu,
];

/**
 * The copy-rule problems in one piece of text a person reads: a never-use
 * term (word-bounded, as the gate matches it), an exclamation mark, an
 * unfilled placeholder, or urgency wording.
 */
export function copyIssues(text) {
  const issues = [];
  for (const term of forbiddenTerms)
    if (new RegExp(`\\b${escape(term)}\\b`, 'iu').test(text))
      issues.push(`forbidden term "${term}"`);
  if (text.includes('!')) issues.push('exclamation mark');
  for (const pattern of placeholders)
    if (pattern.test(text)) issues.push(`placeholder ${pattern}`);
  for (const pattern of urgency)
    if (pattern.test(text)) issues.push(`urgency ${pattern}`);
  return issues;
}

// Words a sentence-case line may capitalise after its first word: names,
// months, and the product and platform names partner copy uses.
const properNouns = new Set([
  'Valstara',
  'I',
  'TikTok',
  'YouTube',
  'Instagram',
  'Discord',
  'Telegram',
  'WhatsApp',
  'X',
  'GameSeal',
  'G2A',
  'Eneba',
  'Hong',
  'Kong',
  'Cloudflare',
  'Turnstile',
  'Brevo',
  'Resend',
  'Umami',
  'US',
  'UK',
  'EU',
  'A4',
  'QR',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

// The brand's named programmes take capitals as names do
// (docs/brand/identity-guidelines.md: "Programmes take plain English names:
// the Triple Guarantee, the Trust Ledger").
const programmeNames = ['Triple Guarantee', 'Trust Ledger'];

/**
 * Title-case words in a heading, button or label: a word after the first
 * that starts with a capital and is not a name, a month, an acronym, a code
 * or a numbered label ("Coupon 1", the founder's ladder form). Each part of
 * a line split by "·" is its own phrase, and a list marker ("I.", "2.") is
 * not its first word. Sentence case everywhere (copy rules: voice).
 */
export function sentenceCaseIssues(line) {
  const issues = [];
  for (const part of line.split('·')) {
    let phrase = part.trim().replace(/^(?:[IVX]+|\d+)\.\s+/u, '');
    for (const name of programmeNames)
      phrase = phrase.replaceAll(name, name.toLowerCase());
    const words = phrase
      .replace(/[“”"'‘’()[\]:,.;?—–-]/gu, ' ')
      .split(/\s+/u)
      .filter(Boolean);
    for (const [index, word] of words.entries()) {
      if (index === 0 || !/^\p{Lu}/u.test(word)) continue;
      if (properNouns.has(word)) continue;
      // An acronym or a code: no lower-case letter at all (FAQ, MAYASTUDIO).
      if (!/\p{Ll}/u.test(word)) continue;
      // A numbered label: "Coupon 1", "Wave 1".
      if (/^\d+$/u.test(words[index + 1] ?? '')) continue;
      issues.push(`"${word}" in "${line}"`);
    }
  }
  return issues;
}
