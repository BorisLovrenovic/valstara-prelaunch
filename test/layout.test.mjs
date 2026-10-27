import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const layoutUrl = new URL('../src/layouts/BaseLayout.astro', import.meta.url);
const copyUrl = new URL('../src/copy/layout.ts', import.meta.url);

async function layoutSource() {
  return readFile(layoutUrl, 'utf8');
}

async function copySource() {
  return readFile(copyUrl, 'utf8');
}

test('the layout ships only the theme toggle island and no other client script', async () => {
  const source = await layoutSource();

  // The single island the shell mounts is the theme toggle.
  const islandImports = [
    ...source.matchAll(/import\s+\w+\s+from\s+'[^']*\/islands\/[^']*'/gu),
  ].map((match) => match[0]);
  assert.deepEqual(islandImports, [
    "import ThemeToggle from '../islands/ThemeToggle.astro'",
  ]);

  // No hydrated framework island is introduced by the shell.
  assert.doesNotMatch(source, /\sclient:[a-z]/u);

  // The only script the shell itself emits is the theme bootstrap, and it is
  // inlined verbatim — the shell adds no bundled client JavaScript of its own.
  const scripts = [...source.matchAll(/<script\b[^>]*>/gu)].map(
    (match) => match[0],
  );
  assert.equal(scripts.length, 2);
  assert.match(scripts[0], /\bis:inline\b/u);
  assert.match(scripts[0], /type="application\/ld\+json"/u);
  assert.match(scripts[0], /set:html=\{jsonLd\(organisationData\(\)\)\}/u);
  assert.match(scripts[1], /\bis:inline\b/u);
  assert.match(scripts[1], /set:html=\{themeBootstrapScript\}/u);
});

test('the layout selectively preloads only the above-fold Instrument Sans WOFF2', async () => {
  const source = await layoutSource();
  const preloads = [
    ...source.matchAll(/<link[\s\S]*?rel="preload"[\s\S]*?\/>/gu),
  ].map((match) => match[0]);
  assert.equal(preloads.length, 1);
  assert.match(preloads[0], /instrument-sans-latin-wght-normal\.woff2/u);
  assert.doesNotMatch(preloads[0], /jetbrains/u);
});

const literalColour = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu;
const tokenisedProperties = [
  /\b(?:background-)?color\s*:\s*([^;]+)/giu,
  /\bfont(?:-family|-size)?\s*:\s*([^;]+)/giu,
  /\bline-height\s*:\s*([^;]+)/giu,
  /\bborder-radius\s*:\s*([^;]+)/giu,
  /\b(?:margin|padding|gap|inset|top|right|bottom|left|outline-offset)(?:-[\w-]+)?\s*:\s*([^;]+)/giu,
  /\b(?:animation|transition)-duration\s*:\s*([^;]+)/giu,
];

// Tokens carry themed values; unitless zero and keywords are not values a
// token could hold, so they are permitted. A calc() built only from var()
// tokens, unitless numbers and operators is still tokens, as in the E11.5-01
// scan (E11.5-11b, founder-authorised 2026-10-26).
function tokenisedValue(value) {
  if (
    /^(?:var\(|inherit\b|currentColor\b|transparent\b|0\b|none\b|auto\b)/u.test(
      value,
    )
  )
    return true;
  if (!value.startsWith('calc(')) return false;
  const outsideTokens = value
    .replace(/var\(--[\w-]+\)/gu, '')
    .replace(/^calc/u, '');
  return /^[\d.\s()+\-*/]*$/u.test(outsideTokens);
}

function literalValues(source) {
  const found = [];
  if (literalColour.test(source)) found.push('a literal colour');
  for (const propertyPattern of tokenisedProperties) {
    for (const match of source.matchAll(propertyPattern)) {
      if (!tokenisedValue(match[1].trim())) found.push(match[0]);
    }
  }
  return found;
}

test('the layout carries no literal colour, font, radius, spacing or duration value', async () => {
  assert.deepEqual(literalValues(await layoutSource()), []);
});

test('a token-only calc() passes the layout scan and a calc() with a literal length fails it', () => {
  for (const sound of [
    '.a { padding-inline: calc(var(--space-2-5) / 2); }',
    '.a { margin-block-start: calc((var(--leading-3) - var(--tap-min)) / 2); }',
    '.a { gap: var(--space-1); }',
  ]) {
    assert.deepEqual(literalValues(sound), [], sound);
  }
  for (const planted of [
    '.a { padding-inline: calc(var(--space-2) + 3px); }',
    '.a { margin-block-start: calc(var(--space-1) * 1rem); }',
    '.a { gap: calc(10px); }',
    '.a { padding-inline: 10px; }',
  ]) {
    assert.equal(literalValues(planted).length, 1, planted);
  }
});

test('every customer-visible layout string comes from the copy layer', async () => {
  const source = await layoutSource();
  assert.match(
    source,
    /import\s+\{\s*layoutCopy\s*\}\s+from\s+'\.\.\/copy\/layout\.ts'/u,
  );
  for (const reference of [
    'layoutCopy.skipToContent',
    'layoutCopy.siteName',
    'layoutCopy.footerNavLabel',
    'layoutCopy.footerLinks',
  ]) {
    assert.ok(source.includes(reference), `layout references ${reference}`);
  }
});

test('each page drives its own title and description through the layout props', async () => {
  const source = await layoutSource();
  assert.match(
    source,
    /interface Props\s*\{[^}]*title:\s*string;[^}]*description:\s*string;/su,
  );
  assert.match(source, /<title>\{title\}<\/title>/u);
  assert.match(source, /<meta name="description" content=\{description\} \/>/u);

  for (const page of ['index.astro', 'verify.astro']) {
    const pageSource = await readFile(
      new URL(`../src/pages/${page}`, import.meta.url),
      'utf8',
    );
    assert.match(pageSource, /<BaseLayout/u, `${page} uses the layout`);
    assert.match(pageSource, /title=\{/u, `${page} passes a title`);
    assert.match(pageSource, /description=\{/u, `${page} passes a description`);
  }
});

// Rewritten in E11.5-03: the footer became two link columns, Company and Legal,
// so the link set grew. The five permanent URLs (E2-05) are still asserted.
test('the footer copy groups the permanent URLs into Company and Legal, with the legal line', async () => {
  const source = await copySource();
  const { layoutCopy } = await import('../src/copy/layout.ts');

  const entries = [
    ...source.matchAll(
      /\{\s*group:\s*'([^']+)',\s*href:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/gu,
    ),
  ];
  assert.deepEqual(
    entries.map(([, group, href]) => [group, href]),
    [
      ['company', '/about'],
      ['company', '/legit'],
      ['company', '/guarantee'],
      ['legal', '/terms'],
      ['legal', '/privacy'],
      ['legal', '/privacy/storage'],
      ['legal', '/giveaway/rules'],
    ],
  );
  const hrefs = entries.map((entry) => entry[2]);
  for (const permanent of [
    '/legit',
    '/guarantee',
    '/about',
    '/terms',
    '/privacy',
  ]) {
    assert.ok(hrefs.includes(permanent), `the footer keeps ${permanent}`);
  }
  for (const [, , href, label] of entries) {
    assert.ok(label.length > 0, `${href} has a label`);
  }
  assert.deepEqual(
    layoutCopy.footerGroups.map((group) => [group.id, group.heading]),
    [
      ['company', 'Company'],
      ['legal', 'Legal'],
    ],
  );
  assert.equal(layoutCopy.supportEmail, 'support@valstara.com');
  // identity-guidelines §3.4, verbatim.
  assert.equal(
    layoutCopy.legalLine,
    'Valstara is a trading brand of 3NITY Digital Limited, registered in Hong Kong.',
  );
  assert.match(source, /skipToContent:\s*'[^']+'/u);
});

test('the header copy carries the four landing anchors and the Join action', async () => {
  const { layoutCopy } = await import('../src/copy/layout.ts');
  assert.deepEqual(
    layoutCopy.headerLinks.map((link) => [link.anchor, link.label]),
    [
      ['#how', 'How it works'],
      ['#rewards', 'What you get'],
      ['#guarantee', 'Guarantee'],
      ['#faq', 'FAQ'],
    ],
  );
  assert.equal(layoutCopy.joinAnchor, '#join');
  assert.equal(layoutCopy.joinLabel, 'Join the waitlist');
});

test('header and footer copy stays within the E11.5 copy budget', async () => {
  const { layoutCopy } = await import('../src/copy/layout.ts');
  const words = (text) => text.trim().split(/\s+/u).length;
  // Headings at most 7 words; link, button and badge-sized text at most 15;
  // a supporting line at most 20.
  for (const heading of [
    ...layoutCopy.footerGroups.map((group) => group.heading),
    layoutCopy.contactHeading,
  ]) {
    assert.ok(words(heading) <= 7, heading);
  }
  for (const label of [
    ...layoutCopy.headerLinks.map((link) => link.label),
    ...layoutCopy.footerLinks.map((link) => link.label),
    layoutCopy.joinLabel,
    layoutCopy.siteName,
  ]) {
    assert.ok(words(label) <= 15, label);
  }
  assert.ok(words(layoutCopy.legalLine) <= 20);
});
