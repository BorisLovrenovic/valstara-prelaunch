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
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /\bis:inline\b/u);
  assert.match(scripts[0], /set:html=\{themeBootstrapScript\}/u);
});

test('the layout carries no literal colour, font, radius, spacing or duration value', async () => {
  const source = await layoutSource();
  const literalColour = /#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/iu;
  const tokenisedProperties = [
    /\b(?:background-)?color\s*:\s*([^;]+)/giu,
    /\bfont(?:-family|-size)?\s*:\s*([^;]+)/giu,
    /\bline-height\s*:\s*([^;]+)/giu,
    /\bborder-radius\s*:\s*([^;]+)/giu,
    /\b(?:margin|padding|gap|inset|top|right|bottom|left|outline-offset)(?:-[\w-]+)?\s*:\s*([^;]+)/giu,
    /\b(?:animation|transition)-duration\s*:\s*([^;]+)/giu,
  ];

  assert.doesNotMatch(source, literalColour, 'layout has a literal colour');
  for (const propertyPattern of tokenisedProperties) {
    for (const match of source.matchAll(propertyPattern)) {
      assert.match(
        match[1].trim(),
        // Tokens carry themed values; unitless zero and keywords are not values
        // a token could hold, so they are permitted.
        /^(?:var\(|inherit\b|currentColor\b|transparent\b|0\b|none\b|auto\b)/u,
        `layout has a literal value in "${match[0]}"`,
      );
    }
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

test('the footer copy links to the permanent trust and legal URLs', async () => {
  const source = await copySource();

  // Every footer entry declares a non-empty label alongside its href.
  const entries = [
    ...source.matchAll(/\{\s*href:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/gu),
  ];
  assert.deepEqual(
    entries.map((entry) => entry[1]),
    ['/legit', '/guarantee', '/about', '/terms', '/privacy'],
  );
  for (const [, href, label] of entries) {
    assert.ok(label.length > 0, `${href} has a label`);
  }
  assert.match(source, /skipToContent:\s*'[^']+'/u);
});
