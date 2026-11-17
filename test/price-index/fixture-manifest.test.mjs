import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// E11.6-01: the founder's capture of the source site is the only copy of it an
// agent session may read (epic rule 2). This test proves the committed files
// are the ones the capture recorded, byte for byte, and that every one of the
// 38 countries the ticket names is accounted for.

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fixtureRoot = resolve(
  projectRoot,
  'packages/price-index/test/fixtures/youfundceo',
);
const sourceOrigin = 'https://www.youfundceo.com';

// The ticket's list, as URL slugs (development plan, E11.6-01 Build).
const countries = [
  ['sweden', 'Sweden'],
  ['germany', 'Germany'],
  ['united-kingdom', 'United Kingdom'],
  ['poland', 'Poland'],
  ['romania', 'Romania'],
  ['norway', 'Norway'],
  ['denmark', 'Denmark'],
  ['switzerland', 'Switzerland'],
  ['canada', 'Canada'],
  ['australia', 'Australia'],
  ['austria', 'Austria'],
  ['belgium', 'Belgium'],
  ['bosnia-and-herzegovina', 'Bosnia and Herzegovina'],
  ['croatia', 'Croatia'],
  ['cyprus', 'Cyprus'],
  ['czech-republic', 'Czech Republic'],
  ['estonia', 'Estonia'],
  ['finland', 'Finland'],
  ['france', 'France'],
  ['greece', 'Greece'],
  ['hungary', 'Hungary'],
  ['iceland', 'Iceland'],
  ['ireland', 'Ireland'],
  ['italy', 'Italy'],
  ['latvia', 'Latvia'],
  ['liechtenstein', 'Liechtenstein'],
  ['lithuania', 'Lithuania'],
  ['luxembourg', 'Luxembourg'],
  ['malta', 'Malta'],
  ['netherlands', 'Netherlands'],
  ['new-zealand', 'New Zealand'],
  ['north-macedonia', 'North Macedonia'],
  ['portugal', 'Portugal'],
  ['serbia', 'Serbia'],
  ['slovakia', 'Slovakia'],
  ['slovenia', 'Slovenia'],
  ['spain', 'Spain'],
  ['united-states', 'United States'],
];

const header = ['url', 'file', 'status', 'captured_at', 'sha256'];

function parseManifest(text) {
  assert.ok(text.endsWith('\n'), 'manifest.tsv ends with a newline');
  const [first, ...lines] = text.slice(0, -1).split('\n');
  assert.deepEqual(first.split('\t'), header, 'manifest.tsv header');
  return lines.map((line, index) => {
    const fields = line.split('\t');
    assert.equal(
      fields.length,
      header.length,
      `manifest.tsv row ${index + 2} has ${header.length} fields`,
    );
    const [url, file, status, capturedAt, sha256] = fields;
    return { capturedAt, file, sha256, status, url };
  });
}

async function manifest() {
  return parseManifest(
    await readFile(resolve(fixtureRoot, 'manifest.tsv'), 'utf8'),
  );
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('every manifest row is well formed and points at the source host', async () => {
  const rows = await manifest();
  assert.ok(rows.length > 0, 'the manifest lists the capture');
  for (const row of rows) {
    const url = new URL(row.url);
    assert.equal(url.origin, sourceOrigin, `${row.url} is on the source host`);
    assert.doesNotMatch(
      url.pathname,
      /^\/(?:api|go)\//u,
      `${row.url} is not a path robots.txt disallows`,
    );
    assert.match(
      row.capturedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u,
      `${row.url} has an ISO capture time`,
    );
    assert.match(
      row.status,
      /^(?:\d{3}(?:-checkpoint)?|har|error)$/u,
      `${row.url} has a recorded status`,
    );
    if (row.file === '-') {
      assert.equal(row.sha256, '-', `${row.url} has no file and no hash`);
    } else {
      assert.match(row.sha256, /^[0-9a-f]{64}$/u, `${row.file} has a SHA-256`);
      assert.doesNotMatch(row.file, /(?:^|\/)\.\.(?:\/|$)/u);
    }
  }
});

test('every listed file exists and matches its SHA-256', async () => {
  const rows = (await manifest()).filter((row) => row.file !== '-');
  const files = new Set();
  for (const row of rows) {
    assert.ok(!files.has(row.file), `${row.file} is listed once`);
    files.add(row.file);
    const path = resolve(fixtureRoot, row.file);
    assert.ok((await stat(path)).isFile(), `${row.file} exists`);
    assert.equal(
      sha256(await readFile(path)),
      row.sha256,
      `${row.file} is unmodified since the capture`,
    );
  }
});

test('all 38 countries are accounted for, none substituted', async () => {
  const rows = await manifest();
  assert.equal(countries.length, 38);
  for (const [slug, name] of countries) {
    const url = `${sourceOrigin}/countries/${slug}`;
    const forCountry = rows.filter((row) => row.url === url);
    const notListed = forCountry.find((row) => row.status === '404');
    if (notListed) {
      // A country the source does not list is recorded as such, with no file.
      assert.equal(notListed.file, '-', `${slug}: a 404 saves no file`);
      continue;
    }
    const saved = forCountry.filter(
      (row) => row.status === '200' && row.file.startsWith('pages/'),
    );
    assert.deepEqual(
      saved.map((row) => row.file).sort(),
      [`pages/countries__${slug}.html`, `pages/countries__${slug}.server.html`],
      `${slug}: the rendered and the server copy were saved`,
    );
    for (const row of saved) {
      const page = await readFile(resolve(fixtureRoot, row.file), 'utf8');
      // The page is the country it claims to be, not a substitute.
      assert.match(
        page,
        new RegExp(
          `<h1[^>]*>Subscription prices in (?:<!-- -->)?${name}</h1>`,
          'u',
        ),
        `${row.file} is the page for ${name}`,
      );
    }
  }
});

test('every saved page shows real content, not the bot checkpoint', async () => {
  const pages = (await manifest()).filter((row) =>
    row.file.startsWith('pages/'),
  );
  assert.ok(pages.length > 0);
  for (const row of pages) {
    assert.equal(row.status, '200', `${row.file} was a 200`);
    const page = await readFile(resolve(fixtureRoot, row.file), 'utf8');
    assert.doesNotMatch(
      page,
      /Vercel Security Checkpoint/u,
      `${row.file} is not the checkpoint`,
    );
    assert.match(page, /YouFundCEO/u, `${row.file} is a source page`);
  }
});

test('the HAR files carry no cookie or authorisation header', async () => {
  const hars = (await manifest()).filter((row) => row.file.endsWith('.har'));
  assert.equal(hars.length, 2, 'two HAR files were captured');
  for (const row of hars) {
    const har = JSON.parse(
      await readFile(resolve(fixtureRoot, row.file), 'utf8'),
    );
    for (const entry of har.log.entries) {
      for (const part of [entry.request, entry.response]) {
        assert.deepEqual(part.cookies, [], `${row.file}: no cookies`);
        for (const { name } of part.headers) {
          assert.doesNotMatch(
            name,
            /^(?:cookie|set-cookie|authorization|proxy-authorization)$/iu,
            `${row.file}: no ${name} header`,
          );
        }
      }
    }
  }
});

test('a tampered or missing fixture fails the manifest check', () => {
  // Red path for parseManifest's contract and the hash comparison above.
  const rows = parseManifest(
    `${header.join('\t')}\n${sourceOrigin}/robots.txt\traw/robots.txt\t200\t2026-11-17T13:13:39Z\t${sha256('User-Agent: *\n')}\n`,
  );
  assert.notEqual(sha256('User-Agent: *\nDisallow: /\n'), rows[0].sha256);
  assert.throws(() => parseManifest('url\tfile\n'), /header/u);
  assert.throws(
    () => parseManifest(`${header.join('\t')}\nonly\tthree\tfields\n`),
    /fields/u,
  );
});
