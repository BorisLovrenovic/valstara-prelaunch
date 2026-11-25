import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

// E11.7-16: partner announcements as content files. One file per
// announcement in src/content/partner-announcements/, named
// `YYYY-MM-DD-<slug>.md`, whose name without `.md` is its id:
//
//   ---
//   subject: Programme news for December
//   ---
//
//   Plain prose, in paragraphs separated by a blank line, with at most three
//   [links to the site's own pages](/partners), written as root-relative paths.
//
// The rules below run before every build (scripts/ci/partner-announcements-
// check.ts), so an announcement that breaks one fails the build, and again
// whenever the founder command or the email renderer reads a file, so nothing
// that breaks one is ever queued or sent. A published announcement never
// changes: the security gates fail when a file on the merge base differs on
// the branch (scripts/ci/partner-announcements-append-only.mjs).
//
// This module imports nothing beyond Node, because the maintenance worker's
// email dispatch loads it (docs/modules/email.md).

export const partnerAnnouncementDirectory = 'src/content/partner-announcements';
/** The one file in the folder that is not an announcement. */
export const partnerAnnouncementPlaceholder = '.gitkeep';

export const partnerAnnouncementLimits = Object.freeze({
  subjectCharacters: 80,
  words: 300,
  links: 3,
  // Keeps the business key bounded: `partner-announcement:{id}:{partner_id}`.
  idCharacters: 80,
});

const idPattern =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export interface PartnerAnnouncementLink {
  readonly label: string;
  /** A root-relative path on the site's own origin, such as `/partners`. */
  readonly path: string;
}

export interface PartnerAnnouncement {
  readonly id: string;
  readonly subject: string;
  /** Plain prose; a link appears in its paragraph as its label. */
  readonly paragraphs: readonly string[];
  readonly links: readonly PartnerAnnouncementLink[];
}

// No parameter properties: the maintenance worker runs this file under
// Node's type stripping, which accepts erasable syntax only.
export class PartnerAnnouncementError extends Error {
  public readonly reason: 'not_found' | 'invalid';
  public readonly problems: readonly string[];

  public constructor(
    reason: 'not_found' | 'invalid',
    problems: readonly string[] = [],
  ) {
    super(`partner_announcement_${reason}`);
    this.name = 'PartnerAnnouncementError';
    this.reason = reason;
    this.problems = problems;
  }
}

/** Whether `id` is a well-formed announcement id with a real calendar date. */
export function isPartnerAnnouncementId(id: string): boolean {
  if (id.length > partnerAnnouncementLimits.idCharacters) return false;
  const groups = idPattern.exec(id)?.groups;
  if (groups === undefined) return false;
  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export interface PartnerAnnouncementCheckOptions {
  /** The forbidden-copy terms (scripts/forbidden-copy.json), at build time. */
  readonly forbiddenTerms?: readonly string[];
}

const link = /\[(?<label>[^[\]\n]*)\]\((?<target>[^()\s]*)\)/gu;
// A root-relative path: one leading slash, then URL path, query and fragment
// characters only. Never `//`, a scheme or a backslash.
const pathPattern = /^\/(?![/\\])[A-Za-z0-9\-._~/?#=&%+]*$/u;
const mergeField = /[{}]|\*\||\|\*|%%|\[\[|\]\]|%[A-Z][A-Z_]*%/u;
const htmlEntity = /&#?[A-Za-z0-9]+;/u;
const webAddress =
  /https?:|mailto:|www\.|@|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/iu;
const inlineMarkdown = /[*_`|\\~]/u;
const blockMarkdown = /^(?:#|[-+]\s|[0-9]+[.)]\s|[-=_]{3,}\s*$|\s{4})/u;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function forbidden(
  text: string,
  terms: readonly string[] | undefined,
): readonly string[] {
  return (terms ?? []).filter((term) =>
    new RegExp(`\\b${escapeRegex(term)}\\b`, 'iu').test(text),
  );
}

/** "Sentence case everywhere": a Title Case Subject Is Refused. */
function titleCase(subject: string): boolean {
  const words = subject
    .split(/\s+/u)
    .slice(1)
    .filter((word) => /^[\p{L}]{4,}/u.test(word));
  return words.length >= 2 && words.every((word) => /^\p{Lu}/u.test(word));
}

function readSubject(frontmatter: string, problems: string[]): string {
  const lines = frontmatter.split('\n');
  const match = /^subject: (?<value>.*)$/u.exec(lines[0] ?? '');
  if (lines.length !== 1 || match?.groups === undefined) {
    problems.push(
      'the frontmatter must be exactly one line, "subject: <the subject>"',
    );
    return '';
  }
  let subject = match.groups.value.trim();
  const quoted = /^(?<quote>["'])(?<inner>.*)\k<quote>$/u.exec(subject);
  if (quoted?.groups !== undefined) {
    subject = quoted.groups.inner;
    if (/["'\\]/u.test(subject))
      problems.push(
        'a quoted subject cannot contain quotes or backslashes; write it unquoted',
      );
  }
  if (subject === '') problems.push('the subject is empty');
  if ([...subject].length > partnerAnnouncementLimits.subjectCharacters)
    problems.push(
      `the subject is longer than ${partnerAnnouncementLimits.subjectCharacters} characters`,
    );
  if (/[<>]/u.test(subject) || htmlEntity.test(subject))
    problems.push('the subject contains HTML');
  if (mergeField.test(subject))
    problems.push('the subject contains a merge field');
  if (webAddress.test(subject))
    problems.push('the subject contains a web or email address');
  if (subject.includes('!'))
    problems.push('the subject has an exclamation mark (copy rules)');
  if (subject !== '' && !/^[\p{Lu}0-9]/u.test(subject))
    problems.push('the subject must start with a capital letter or a digit');
  if (titleCase(subject))
    problems.push('the subject must be in sentence case (copy rules)');
  return subject;
}

function readBody(
  body: string,
  problems: string[],
): { paragraphs: string[]; links: PartnerAnnouncementLink[] } {
  const links: PartnerAnnouncementLink[] = [];
  if (body.trim() === '') {
    problems.push('the announcement has no text');
    return { paragraphs: [], links };
  }
  for (const line of body.split('\n')) {
    if (line.trim() !== '' && blockMarkdown.test(line)) {
      problems.push(
        `markdown structure is not plain prose (headings, lists, rules or indented code): "${line.trim()}"`,
      );
    }
  }
  if (/[<>]/u.test(body) || htmlEntity.test(body))
    problems.push('the text contains HTML');
  if (body.includes('![')) problems.push('the text contains an image');
  if (mergeField.test(body)) problems.push('the text contains a merge field');

  const paragraphs = body
    .trim()
    .split(/\n[ \t]*\n/u)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join(' '),
    )
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) =>
      paragraph.replace(link, (_whole, label: string, target: string) => {
        const text = label.trim();
        if (text === '') problems.push(`a link to "${target}" has no label`);
        if (!pathPattern.test(target))
          problems.push(
            `the link "${text}" must be a path on the site, such as /partners, not "${target}"`,
          );
        links.push({ label: text, path: target });
        return text;
      }),
    );

  if (links.length > partnerAnnouncementLimits.links)
    problems.push(
      `the text has ${links.length} links; at most ${partnerAnnouncementLimits.links} are allowed`,
    );
  const prose = paragraphs.join('\n');
  if (/[[\]]/u.test(prose))
    problems.push('the text has square brackets that are not a link');
  if (webAddress.test(prose))
    problems.push(
      'the text contains a web or email address; link to a page on the site instead',
    );
  if (inlineMarkdown.test(prose))
    problems.push('the text contains markdown formatting; write plain prose');
  if (prose.includes('!'))
    problems.push('the text has an exclamation mark (copy rules)');
  const words = prose
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (words > partnerAnnouncementLimits.words)
    problems.push(
      `the text has ${words} words; at most ${partnerAnnouncementLimits.words} are allowed`,
    );
  return { paragraphs, links };
}

/**
 * Validates one announcement's source. Returns the announcement, or every
 * problem found, each in words the founder can act on.
 */
export function parsePartnerAnnouncement(
  id: string,
  source: string,
  options: PartnerAnnouncementCheckOptions = {},
):
  | { readonly announcement: PartnerAnnouncement }
  | { readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (!isPartnerAnnouncementId(id))
    problems.push(
      'the file name must be YYYY-MM-DD-<slug>.md, with a real date and a slug of lowercase letters, digits and single hyphens, at most 80 characters before .md',
    );
  const text = source.replace(/\r\n/gu, '\n');
  const document =
    /^---\n(?<frontmatter>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/u.exec(
      text,
    )?.groups;
  if (document === undefined) {
    problems.push('the file must start with a --- frontmatter block');
    return { problems };
  }
  const subject = readSubject(document.frontmatter, problems);
  const { paragraphs, links } = readBody(document.body, problems);
  for (const term of forbidden(
    `${subject}\n${paragraphs.join('\n')}`,
    options.forbiddenTerms,
  ))
    problems.push(`forbidden copy "${term}" (docs/brand/copy-rules.md)`);
  if (problems.length > 0) return { problems };
  return { announcement: { id, subject, paragraphs, links } };
}

function directoryPath(directory: string | undefined): string {
  return directory ?? resolve(process.cwd(), partnerAnnouncementDirectory);
}

/**
 * Reads and validates one announcement by id. Throws
 * `PartnerAnnouncementError` when no such file exists or it breaks a rule.
 */
export function readPartnerAnnouncement(
  id: string,
  directory?: string,
): PartnerAnnouncement {
  if (!isPartnerAnnouncementId(id))
    throw new PartnerAnnouncementError('not_found');
  let source: string;
  try {
    source = readFileSync(join(directoryPath(directory), `${id}.md`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new PartnerAnnouncementError('not_found');
    throw error;
  }
  const parsed = parsePartnerAnnouncement(id, source);
  if ('problems' in parsed)
    throw new PartnerAnnouncementError('invalid', parsed.problems);
  return parsed.announcement;
}

/**
 * Every problem in the folder, each prefixed with its file. A missing folder
 * holds no announcements. The folder holds only announcement files and the
 * placeholder that keeps it in Git.
 */
export function checkPartnerAnnouncements(
  directory?: string,
  options: PartnerAnnouncementCheckOptions = {},
): readonly string[] {
  const path = directoryPath(directory);
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const problems: string[] = [];
  for (const entry of [...entries].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const where = `${partnerAnnouncementDirectory}/${entry.name}`;
    if (entry.name === partnerAnnouncementPlaceholder && entry.isFile())
      continue;
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      problems.push(
        `${where}: only YYYY-MM-DD-<slug>.md announcement files belong here`,
      );
      continue;
    }
    const parsed = parsePartnerAnnouncement(
      entry.name.slice(0, -3),
      readFileSync(join(path, entry.name), 'utf8'),
      options,
    );
    if ('problems' in parsed)
      for (const problem of parsed.problems)
        problems.push(`${where}: ${problem}`);
  }
  return problems;
}
