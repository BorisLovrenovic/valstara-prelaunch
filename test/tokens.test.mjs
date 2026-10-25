import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const tokenPath = new URL('../src/styles/tokens.css', import.meta.url);
const brandGuidelinesPath = new URL(
  '../docs/brand/identity-guidelines.md',
  import.meta.url,
);
const tokenContractPath = new URL('../docs/brand/tokens.md', import.meta.url);

const expectedRootTokens = {
  '--paper': '#FAFAFA',
  '--surface': '#FFFFFF',
  '--ink': '#101014',
  '--ink-600': '#55555E',
  '--ink-300': '#A0A0A8',
  '--line': '#E5E5E5',
  '--coral': '#E8654A',
  '--coral-lift': '#FF8A66',
  '--coral-tint': '#FDEEE9',
  '--midnight': '#171733',
  '--midnight-deep': '#0D0D1F',
  '--error': '#C0392B',
  '--warning': '#B7791F',
  '--success': '#2E7D57',
  '--font-sans':
    "'Instrument Sans', 'Instrument Sans Fallback', system-ui, sans-serif",
  '--font-mono':
    "'JetBrains Mono', 'JetBrains Mono Fallback', ui-monospace, monospace",
  '--step-5': '2rem',
  '--leading-5': '2.5rem',
  '--step-4': '1.5rem',
  '--leading-4': '2rem',
  '--step-3': '1.25rem',
  '--leading-3': '1.75rem',
  '--step-2': '1rem',
  '--leading-2': '1.5rem',
  '--step-1': '0.875rem',
  '--leading-1': '1.25rem',
  '--step-0': '0.8125rem',
  '--leading-0': '1.125rem',
  '--radius-card': '12px',
  '--radius-control': '8px',
  '--radius-pill': '999px',
  '--duration-fast': '150ms',
  '--duration-base': '200ms',
  '--ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
};

const expectedDarkTokens = {
  '--paper': '#0F0F1A',
  '--surface': '#171733',
  '--ink': '#F0F0EE',
  '--ink-600': '#A0A0A8',
  '--coral': '#FF8A66',
  '--on-midnight': '#F0F0EE',
  '--shadow-1': '0 1px 2px rgb(0 0 0 / 0.30), 0 2px 6px rgb(0 0 0 / 0.30)',
  '--shadow-2': '0 2px 4px rgb(0 0 0 / 0.30), 0 8px 24px rgb(0 0 0 / 0.40)',
  '--shadow-3': '0 4px 8px rgb(0 0 0 / 0.40), 0 16px 40px rgb(0 0 0 / 0.50)',
};

const foundationTokens = {
  '--on-midnight': '#fafafa',
  '--shadow-1':
    '0 1px 2px rgb(16 16 20 / 0.06), 0 2px 6px rgb(16 16 20 / 0.06)',
  '--shadow-2':
    '0 2px 4px rgb(16 16 20 / 0.06), 0 8px 24px rgb(16 16 20 / 0.10)',
  '--shadow-3':
    '0 4px 8px rgb(16 16 20 / 0.08), 0 16px 40px rgb(16 16 20 / 0.14)',
  '--container-max': '75rem',
  '--gutter': 'var(--space-2)',
  '--gutter-wide': 'var(--space-4)',
  '--section-gap': 'var(--space-8)',
  '--section-gap-wide': 'var(--space-10)',
  '--measure': '68ch',
  '--weight-regular': '400',
  '--weight-medium': '500',
  '--weight-semibold': '600',
  '--weight-bold': '700',
  '--tracking-tight': '-0.01em',
  '--tracking-normal': '0',
  '--tap-min': '2.75rem',
  '--icon-sm': '1rem',
  '--icon-md': '1.5rem',
  '--icon-lg': '2.5rem',
  '--layer-dock': '20',
  '--layer-skip': '30',
};

const providerShowcaseTokens = {
  '--provider-layer-decor': '-1',
  '--provider-banner-tone':
    'linear-gradient( to bottom right, color-mix(in srgb, currentColor, var(--surface) 45%), transparent 60% )',
  '--provider-depth-brightness': '0.7',
  '--provider-rail-peek': '82%',
};

function declarations(block) {
  return new Map(
    [...block.matchAll(/(?<name>--[\w-]+):\s*(?<value>[^;]+);/g)].map(
      ({ groups }) => [groups.name, groups.value.trim().replace(/\s+/gu, ' ')],
    ),
  );
}

function colourLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [
    colourLuminance(foreground),
    colourLuminance(background),
  ].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

function lockedColour(brandGuidelines, name) {
  const markdownCode = String.fromCharCode(96);
  const tokenTable = brandGuidelines.slice(
    brandGuidelines.indexOf('## 5. Colour — LOCKED'),
    brandGuidelines.indexOf('### 5.1 The coral rule'),
  );
  const match = tokenTable.match(
    new RegExp(
      `\\| ${markdownCode}${name}${markdownCode} \\| ${markdownCode}(?<value>#[0-9A-F]{6})${markdownCode}`,
      'u',
    ),
  );
  assert.ok(match, `locked colour source is missing ${name}`);
  return match.groups.value;
}

test('tokens exactly transcribe the locked colour and typography sources', async () => {
  const [source, brandGuidelines] = await Promise.all([
    readFile(tokenPath, 'utf8'),
    readFile(brandGuidelinesPath, 'utf8'),
  ]);
  const root = declarations(
    source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u).groups.block,
  );

  for (const [name, value] of Object.entries(expectedRootTokens)) {
    assert.equal(root.get(name)?.toUpperCase(), value.toUpperCase(), name);
  }
  for (const [name, value] of Object.entries(foundationTokens)) {
    assert.equal(root.get(name), value, name);
  }
  for (const [name, value] of Object.entries(providerShowcaseTokens)) {
    assert.equal(root.get(name), value, name);
  }

  for (const name of [
    'paper',
    'surface',
    'ink',
    'ink-600',
    'ink-300',
    'line',
    'coral',
    'coral-lift',
    'coral-tint',
    'midnight',
    'midnight-deep',
  ]) {
    assert.equal(
      root.get(`--${name}`)?.toUpperCase(),
      lockedColour(brandGuidelines, name),
      name,
    );
  }

  for (const [name, value] of [
    ['error', '#C0392B'],
    ['warning', '#B7791F'],
    ['success', '#2E7D57'],
  ]) {
    const markdownCode = String.fromCharCode(96);
    assert.match(
      brandGuidelines,
      new RegExp(
        `${markdownCode}${name}${markdownCode} ${markdownCode}${value}${markdownCode}`,
        'u',
      ),
    );
    assert.equal(root.get(`--${name}`)?.toUpperCase(), value, name);
  }
  assert.match(brandGuidelines, /Instrument Sans/u);
  assert.match(brandGuidelines, /JetBrains Mono/u);

  for (const [name, value] of Object.entries({
    '--space-0': '0',
    '--space-1': '0.5rem',
    '--space-2': '1rem',
    '--space-3': '1.5rem',
    '--space-4': '2rem',
    '--space-5': '2.5rem',
    '--space-6': '3rem',
    '--space-7': '3.5rem',
    '--space-8': '4rem',
    '--space-9': '4.5rem',
    '--space-10': '5rem',
  })) {
    assert.equal(root.get(name), value, name);
  }
});

test('every colour value reuses the locked §5 palette and the type scale has no new size', async () => {
  const [source, guidelines] = await Promise.all([
    readFile(tokenPath, 'utf8'),
    readFile(brandGuidelinesPath, 'utf8'),
  ]);
  const lockedNames = [
    'paper',
    'surface',
    'ink',
    'ink-600',
    'ink-300',
    'line',
    'coral',
    'coral-lift',
    'coral-tint',
    'midnight',
    'midnight-deep',
  ];
  const palette = new Set(
    lockedNames.map((name) => lockedColour(guidelines, name).toLowerCase()),
  );
  for (const value of ['#0F0F1A', '#F0F0EE', '#C0392B', '#B7791F', '#2E7D57']) {
    assert.match(guidelines, new RegExp(value, 'iu'));
    palette.add(value.toLowerCase());
  }
  const root = declarations(
    source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u).groups.block,
  );
  const dark = declarations(
    source.match(/:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u)
      .groups.block,
  );
  assert.deepEqual(
    [...root.keys()].sort(),
    [
      ...Object.keys(expectedRootTokens),
      ...Object.keys(foundationTokens),
      '--space-0',
      ...Object.keys(providerShowcaseTokens),
      ...Array.from({ length: 10 }, (_, index) => `--space-${index + 1}`),
    ].sort(),
    'bare :root declares exactly the authorised tokens, regardless of colour syntax or size name',
  );
  assert.deepEqual(
    [...dark.keys()].sort(),
    Object.keys(expectedDarkTokens).sort(),
    'dark mode introduces no colour or type-size token',
  );
  assert.deepEqual(
    new Set(
      [...source.matchAll(/(?<name>--[\w-]+)\s*:/gu)].map(
        (match) => match.groups.name,
      ),
    ),
    new Set(root.keys()),
    'no selector introduces an undeclared colour or type-size token',
  );
  assert.equal(
    [...source.matchAll(/--[\w-]+\s*:/gu)].length,
    root.size + dark.size * 2,
    'tokens are declared only in the base and paired dark blocks',
  );
  const expectedColourNames = new Set([
    ...Object.entries(expectedRootTokens)
      .filter(([, value]) => value.startsWith('#'))
      .map(([name]) => name),
    '--on-midnight',
  ]);
  assert.deepEqual(
    new Set(
      [...root]
        .filter(([, value]) => /^#[0-9a-f]{6}$/iu.test(value))
        .map(([name]) => name),
    ),
    expectedColourNames,
  );
  for (const [name, value] of [...root, ...dark]) {
    if (/^#[0-9a-f]{6}$/iu.test(value)) {
      assert.ok(
        palette.has(value.toLowerCase()),
        `${name} must reuse §5 palette`,
      );
    }
  }
  assert.equal(root.get('--on-midnight'), root.get('--paper'));
  assert.equal(dark.get('--on-midnight'), dark.get('--ink'));
  assert.deepEqual(
    [...root.keys()]
      .filter((name) => /^--(?:step|leading)-/u.test(name))
      .sort(),
    Object.keys(expectedRootTokens)
      .filter((name) => /^--(?:step|leading)-/u.test(name))
      .sort(),
  );
});

test('the port checklist names the storefront target for the verbatim token file', async () => {
  const contract = await readFile(tokenContractPath, 'utf8');
  assert.match(
    contract,
    /\| `src\/styles\/tokens\.css` \| Storefront global stylesheet, \*\*verbatim\*\*/u,
  );
});

test('tokens are a framework-free, light-first portable CSS file', async () => {
  const source = await readFile(tokenPath, 'utf8');
  const rootMatch = source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u);
  const systemDarkMatch = source.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme\]\)\s*\{(?<block>[\s\S]*?)\}\s*\}/u,
  );
  const explicitDarkMatch = source.match(
    /:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u,
  );

  assert.ok(rootMatch);
  assert.ok(systemDarkMatch);
  assert.ok(explicitDarkMatch);
  assert.doesNotMatch(source, /@(?:import|use|tailwind|layer)\b/u);
  assert.doesNotMatch(source, /(?:theme\(|var\(--tw-|styled\.)/u);

  const root = declarations(rootMatch.groups.block);
  const systemDark = declarations(systemDarkMatch.groups.block);
  const explicitDark = declarations(explicitDarkMatch.groups.block);
  assert.deepEqual(systemDark, explicitDark);

  for (const [name, value] of Object.entries(expectedDarkTokens)) {
    assert.equal(
      explicitDark.get(name)?.toUpperCase(),
      value.toUpperCase(),
      name,
    );
  }

  for (const name of explicitDark.keys()) {
    assert.ok(root.has(name), `${name} must have a light base definition`);
  }
});

test('declared body-text pairings meet WCAG AA in both themes', async () => {
  const source = await readFile(tokenPath, 'utf8');
  const root = Object.fromEntries(
    [
      ...declarations(
        source.match(/:root\s*\{(?<block>[\s\S]*?)\}/u).groups.block,
      ),
    ].filter(([, value]) => value.startsWith('#')),
  );
  const explicitDarkMatch = source.match(
    /:root\[data-theme=['"]dark['"]\]\s*\{(?<block>[\s\S]*?)\}/u,
  );
  assert.ok(explicitDarkMatch);
  const dark = Object.fromEntries(
    [...declarations(explicitDarkMatch.groups.block)].filter(([, value]) =>
      value.startsWith('#'),
    ),
  );
  const themes = [
    {
      name: 'light',
      tokens: root,
      pairings: [
        ['--ink', '--paper'],
        ['--ink', '--surface'],
        ['--ink-600', '--paper'],
        ['--paper', '--midnight'],
        ['--paper', '--midnight-deep'],
        ['--error', '--paper'],
      ],
    },
    {
      name: 'dark',
      tokens: { ...root, ...dark },
      pairings: [
        ['--ink', '--paper'],
        ['--ink', '--surface'],
        // Muted text must clear AA in dark too. --ink-600 gains a dark override
        // (#A0A0A8, the light --ink-300 value — founder-authorised 2026-09-05)
        // because at its light value it fails on the dark grounds. --ink-300 is
        // tertiary/placeholder text and is checked for parity.
        ['--ink-600', '--paper'],
        ['--ink-600', '--surface'],
        ['--ink-300', '--paper'],
        ['--ink-300', '--surface'],
      ],
    },
  ];

  for (const theme of themes) {
    for (const [foreground, background] of theme.pairings) {
      assert.ok(
        contrastRatio(theme.tokens[foreground], theme.tokens[background]) >=
          4.5,
        `${theme.name} ${foreground} on ${background} must meet WCAG AA`,
      );
    }
  }

  for (const theme of themes) {
    const foreground =
      theme.name === 'light' ? root['--on-midnight'] : dark['--on-midnight'];
    assert.ok(contrastRatio(foreground, root['--midnight']) >= 4.5);
    assert.ok(
      contrastRatio(theme.tokens['--coral'], root['--midnight']) >= 3,
      `${theme.name} coral on midnight must meet large-text and accent contrast`,
    );
  }

  assert.notEqual(root['--error'], root['--coral']);
  assert.ok(
    contrastRatio(root['--error'], root['--coral']) >= 1.2,
    '--error must be visibly distinct from --coral',
  );
});

test('self-hosted Latin variable fonts have metric fallbacks and tabular-figure contract', async () => {
  const source = await readFile(tokenPath, 'utf8');
  for (const filename of [
    'instrument-sans-latin-wght-normal.woff2',
    'instrument-sans-latin-wght-normal.woff',
    'jetbrains-mono-latin-wght-normal.woff2',
    'jetbrains-mono-latin-wght-normal.woff',
    'OFL-Instrument-Sans.txt',
    'OFL-JetBrains-Mono.txt',
  ]) {
    assert.ok(
      (await readFile(new URL(`../public/fonts/${filename}`, import.meta.url)))
        .byteLength > 0,
      `${filename} must ship`,
    );
  }
  assert.match(
    source,
    /font-family: 'Instrument Sans Fallback'[\s\S]*size-adjust:[\s\S]*ascent-override:[\s\S]*descent-override:[\s\S]*line-gap-override:/u,
  );
  assert.match(
    source,
    /font-family: 'JetBrains Mono Fallback'[\s\S]*size-adjust:[\s\S]*ascent-override:[\s\S]*descent-override:[\s\S]*line-gap-override:/u,
  );
  assert.match(
    source,
    /\.tabular-figure\s*\{[\s\S]*font-family: var\(--font-mono\);[\s\S]*font-variant-numeric: tabular-nums;/u,
  );
});
