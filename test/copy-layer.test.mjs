import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findInlineProse,
  runSecurityGates,
} from '../scripts/ci/security-gates.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Parse the LOCKED never-use table out of docs/brand/copy-rules.md so the
// forbidden list is reconciled against the brand guidelines themselves, not
// against a copy of them transcribed into this test.
async function neverUseTable() {
  const source = await readFile(
    resolve(projectRoot, 'docs/brand/copy-rules.md'),
    'utf8',
  );
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^##\s+Never use/.test(line));
  assert.notEqual(
    start,
    -1,
    'copy-rules.md must contain a "Never use" section',
  );
  const end = lines.findIndex(
    (line, index) => index > start && /^##\s/.test(line),
  );

  const cell = (value) => value.replace(/\*\*/g, '').trim();
  const terms = (value) =>
    cell(value)
      .split('·')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);

  // term -> the set of replacements the brand guidelines permit for its row.
  const allowedReplacements = new Map();
  for (const line of lines.slice(start, end === -1 ? undefined : end)) {
    const match = /^\|(.+)\|(.+)\|\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const left = cell(match[1]);
    if (left === 'Never use' || /^-+$/.test(left)) {
      continue; // header or separator row
    }
    const replacements = new Set(terms(match[2]));
    for (const term of terms(match[1])) {
      allowedReplacements.set(term, replacements);
    }
  }

  assert.ok(allowedReplacements.size > 0, 'the never-use table must parse');
  return allowedReplacements;
}

async function forbiddenList() {
  return JSON.parse(
    await readFile(resolve(projectRoot, 'scripts/forbidden-copy.json'), 'utf8'),
  );
}

test('forbidden-copy.json covers exactly the never-use table, no invented terms', async () => {
  const table = await neverUseTable();
  const policy = await forbiddenList();
  const listed = new Set(
    policy.entries.map((entry) => entry.term.toLowerCase()),
  );

  for (const term of table.keys()) {
    assert.ok(
      listed.has(term),
      `never-use term "${term}" is missing from scripts/forbidden-copy.json`,
    );
  }
  for (const term of listed) {
    assert.ok(
      table.has(term),
      `forbidden-copy term "${term}" is not in the brand never-use table (invented)`,
    );
  }
});

test('every forbidden-copy entry names a replacement drawn from its brand row', async () => {
  const table = await neverUseTable();
  const policy = await forbiddenList();

  for (const entry of policy.entries) {
    assert.equal(
      typeof entry.replacement,
      'string',
      `"${entry.term}" must name a replacement`,
    );
    assert.ok(
      entry.replacement.trim().length > 0,
      `"${entry.term}" must name a non-empty replacement`,
    );
    const allowed = table.get(entry.term.toLowerCase());
    assert.ok(
      allowed.has(entry.replacement.trim().toLowerCase()),
      `replacement "${entry.replacement}" for "${entry.term}" is not one the brand guidelines offer`,
    );
  }
});

test('the inline-prose scan finds no inline prose on the repository baseline', async () => {
  const issues = await runSecurityGates({ audit: false });
  const inlineProse = issues.filter((issue) => issue.scan === 'inline-prose');
  assert.deepEqual(
    inlineProse,
    [],
    `every customer-visible string must live in the copy layer:\n${JSON.stringify(inlineProse, null, 2)}`,
  );
});

test('findInlineProse flags literal template text', async () => {
  const hits = await findInlineProse('<p>Join the Valstara waitlist</p>');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'Join the Valstara waitlist');
  assert.equal(hits[0].line, 1);
});

test('findInlineProse ignores copy routed through an expression', async () => {
  // A string rendered from the copy layer is the sanctioned path and must pass,
  // otherwise the scan would forbid the very thing the ticket requires.
  const hits = await findInlineProse('<p>{landingCopy.hero.body}</p>');
  assert.deepEqual(hits, []);
});

test('findInlineProse ignores script and style bodies', async () => {
  const script = await findInlineProse(
    '<script>const message = "hello there";</script>',
  );
  assert.deepEqual(script, []);
  const style = await findInlineProse(
    '<style>.hero { color: var(--ink); background: red }</style>',
  );
  assert.deepEqual(style, []);
});

test('findInlineProse ignores separators, numerals and whitespace', async () => {
  const hits = await findInlineProse('<span>{numeral}</span>\n  <b>·</b> — 24');
  assert.deepEqual(hits, []);
});

test('findInlineProse flags markup nested inside an expression', async () => {
  // An element inside a map re-enters markup mode; smuggling prose there is
  // still inline prose and must not slip past the scan.
  const hits = await findInlineProse(
    '{items.map((item) => (<li>Static label</li>))}',
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].text, 'Static label');
});
