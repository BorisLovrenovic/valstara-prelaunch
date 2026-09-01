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
  '--font-sans': "'Instrument Sans', system-ui, sans-serif",
  '--font-mono': "'JetBrains Mono', ui-monospace, monospace",
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
  '--coral': '#FF8A66',
};

function declarations(block) {
  return new Map(
    [...block.matchAll(/(?<name>--[\w-]+):\s*(?<value>[^;]+);/g)].map(
      ({ groups }) => [groups.name, groups.value.trim()],
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

  assert.notEqual(root['--error'], root['--coral']);
  assert.ok(
    contrastRatio(root['--error'], root['--coral']) >= 1.2,
    '--error must be visibly distinct from --coral',
  );
});
