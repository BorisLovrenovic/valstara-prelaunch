import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

// E11.8-03: the founder note in the weekly update, as content files. One file
// per ISO-8601 week in src/content/weekly-notes/, named `YYYY-Www.md`, whose
// name is the week the note is sent in:
//
//   Plain prose, in paragraphs separated by a blank line, with at most one
//   [link to a page on the site](/trust-ledger), written as a root-relative
//   path, so the link is always on the site's own origin.
//
// There is no frontmatter: the weekly update keeps its own subject. The rules
// below run before every build (scripts/ci/weekly-notes-check.ts), so a note
// that breaks one fails the build, and again whenever the weekly run or the
// email renderer reads a file, so nothing that breaks one is ever sent.
//
// This module imports nothing beyond Node, because the maintenance worker's
// email dispatch and weekly run load it under Node's type stripping
// (docs/modules/email.md).

export const weeklyNoteDirectory = 'src/content/weekly-notes';
/** The one file in the folder that is not a note. */
export const weeklyNotePlaceholder = '.gitkeep';

export const weeklyNoteLimits = Object.freeze({ words: 120, links: 1 });

export interface WeeklyNoteLink {
  readonly label: string;
  /** A root-relative path on the site's own origin, such as `/trust-ledger`. */
  readonly path: string;
}

export interface WeeklyNote {
  /** The ISO-8601 week the note is for, from its file name. */
  readonly isoWeek: string;
  /** Plain prose; the link appears in its paragraph as its label. */
  readonly paragraphs: readonly string[];
  readonly link: WeeklyNoteLink | null;
  /** SHA-256 of the file's text, which the weekly run records at its start. */
  readonly hash: string;
}

// No parameter properties: the maintenance worker runs this file under
// Node's type stripping, which accepts erasable syntax only.
export class WeeklyNoteError extends Error {
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super('weekly_note_invalid');
    this.name = 'WeeklyNoteError';
    this.problems = problems;
  }
}

const isoWeekPattern = /^(?<year>[0-9]{4})-W(?<week>[0-9]{2})$/u;

function weeksInYear(year: number): number {
  // An ISO year has 53 weeks when it starts or ends on a Thursday.
  const thursday = (month: number, day: number) =>
    new Date(Date.UTC(year, month, day)).getUTCDay() === 4;
  return thursday(0, 1) || thursday(11, 31) ? 53 : 52;
}

/** Whether `value` names a week that exists, such as `2026-W53`. */
export function isIsoWeek(value: string): boolean {
  const groups = isoWeekPattern.exec(value)?.groups;
  if (groups === undefined) return false;
  const week = Number(groups.week);
  return week >= 1 && week <= weeksInYear(Number(groups.year));
}

export function weeklyNoteHash(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export interface WeeklyNoteCheckOptions {
  /** The forbidden-copy terms (scripts/forbidden-copy.json), at build time. */
  readonly forbiddenTerms?: readonly string[];
}

const link = /\[(?<label>[^[\]\n]*)\]\((?<target>[^()\s]*)\)/gu;
// A root-relative path: one leading slash, then URL path, query and fragment
// characters only. Never `//`, a scheme or a backslash, so never off-origin.
const pathPattern = /^\/(?![/\\])[A-Za-z0-9\-._~/?#=&%+]*$/u;
// Merge fields and personalisation tags of every common syntax: `{{ name }}`,
// `{name}`, `*|FNAME|*`, `%%name%%`, `[[name]]` and `%FIRSTNAME%`.
const mergeField = /[{}]|\*\||\|\*|%%|\[\[|\]\]|%[A-Z][A-Z_]*%/u;
const htmlEntity = /&#?[A-Za-z0-9]+;/u;
// A written address would be turned into a link by most mail clients.
const webAddress =
  /https?:|mailto:|www\.|@|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/iu;
const inlineMarkdown = /[*_`|\\~]/u;
const blockMarkdown = /^(?:#|>|[-+]\s|[0-9]+[.)]\s|[-=_]{3,}\s*$|\s{4})/u;

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

/**
 * Validates one note's source. Returns the note, or every problem found, each
 * in words the founder can act on.
 */
export function parseWeeklyNote(
  isoWeek: string,
  source: string,
  options: WeeklyNoteCheckOptions = {},
): { readonly note: WeeklyNote } | { readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (!isIsoWeek(isoWeek))
    problems.push(
      'the file name must be YYYY-Www.md, naming an ISO-8601 week that exists, such as 2026-W50.md',
    );
  const body = source.replace(/\r\n/gu, '\n');
  if (body.trim() === '') {
    problems.push('the note has no text');
    return { problems };
  }
  for (const line of body.split('\n')) {
    if (line.trim() !== '' && blockMarkdown.test(line))
      problems.push(
        `markdown structure is not plain prose (frontmatter, headings, quotes, lists, rules or indented code): "${line.trim()}"`,
      );
  }
  if (/[<>]/u.test(body) || htmlEntity.test(body))
    problems.push('the note contains HTML');
  if (body.includes('![')) problems.push('the note contains an image');
  if (mergeField.test(body))
    problems.push(
      'the note contains a merge field; it goes to everyone unchanged, with no personalisation',
    );

  const links: WeeklyNoteLink[] = [];
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
            `the link "${text}" must be a path on the site, such as /trust-ledger, not "${target}"`,
          );
        links.push({ label: text, path: target });
        return text;
      }),
    );

  if (links.length > weeklyNoteLimits.links)
    problems.push(
      `the note has ${links.length} links; at most ${weeklyNoteLimits.links} is allowed`,
    );
  const prose = paragraphs.join('\n');
  if (/[[\]]/u.test(prose))
    problems.push('the note has square brackets that are not a link');
  if (webAddress.test(prose))
    problems.push(
      'the note contains a web or email address; link to a page on the site instead',
    );
  if (inlineMarkdown.test(prose))
    problems.push('the note contains markdown formatting; write plain prose');
  if (prose.includes('!'))
    problems.push('the note has an exclamation mark (copy rules)');
  const words = prose
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (words > weeklyNoteLimits.words)
    problems.push(
      `the note has ${words} words; at most ${weeklyNoteLimits.words} are allowed`,
    );
  for (const term of forbidden(prose, options.forbiddenTerms))
    problems.push(`forbidden copy "${term}" (docs/brand/copy-rules.md)`);
  if (problems.length > 0) return { problems };
  return {
    note: {
      isoWeek,
      paragraphs,
      link: links[0] ?? null,
      hash: weeklyNoteHash(source),
    },
  };
}

function directoryPath(directory: string | undefined): string {
  return directory ?? resolve(process.cwd(), weeklyNoteDirectory);
}

/**
 * Reads and validates the note for one week. Returns null when that week has
 * no note, and throws `WeeklyNoteError` when its file breaks a rule. Only the
 * file named for `isoWeek` is ever read.
 */
export function readWeeklyNote(
  isoWeek: string,
  directory?: string,
): WeeklyNote | null {
  if (!isIsoWeek(isoWeek)) return null;
  let source: string;
  try {
    source = readFileSync(join(directoryPath(directory), `${isoWeek}.md`), {
      encoding: 'utf8',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseWeeklyNote(isoWeek, source);
  if ('problems' in parsed) throw new WeeklyNoteError(parsed.problems);
  return parsed.note;
}

/**
 * Every problem in the folder, each prefixed with its file. A missing folder
 * holds no notes. The folder holds only note files and the placeholder that
 * keeps it in Git.
 */
export function checkWeeklyNotes(
  directory?: string,
  options: WeeklyNoteCheckOptions = {},
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
    const where = `${weeklyNoteDirectory}/${entry.name}`;
    if (entry.name === weeklyNotePlaceholder && entry.isFile()) continue;
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      problems.push(`${where}: only YYYY-Www.md note files belong here`);
      continue;
    }
    const parsed = parseWeeklyNote(
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
